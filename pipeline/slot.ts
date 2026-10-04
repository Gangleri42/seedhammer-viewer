// Where a board goes in an enclosure. Each Fusion export holds its PCB as one sub-assembly, the slot, whose frame is
// KiCad's page frame: the board came in as a kicad-cli export with the default origin. An upstream export made the
// same way fits the slot as it is. Registration checks that on the board body: its outline box must overlap and its
// exact bottom face must lie where the upstream one does, else the board needs a shift (one moved inside its link) or
// does not fit at all (an export with another origin).
import { readFileSync } from 'node:fs';
import type { Body, Manifest, Occurrence } from './build-model.ts';
import type { RawMeasure } from './measure.ts';

/** The board body in some frame: outline box [x0, y0, x1, y1] and the z of its bottom and top faces, mm. */
export type PcbFacts = { box: [number, number, number, number]; bottom: number; top: number };

type Mat = number[]; // row-major 4×4, as the manifest stores it

/** KiCad names the board body <board>_PCB, or <board>_PCB_1, _2... when the outline has separate pieces. */
export const PCB_NAME = /_PCB(?:_\d+)?$/;
const isPcb = (body: Body) => PCB_NAME.test(body.body);

/** The slot and its board bodies, when every board body sits in one sub-assembly. */
export function findSlot(manifest: Manifest): { slot: Occurrence; pcbs: Body[] } | null {
	const pcbs = manifest.bodies.filter(isPcb);
	if (!pcbs.length || pcbs.some((b) => b.occ === null)) return null;
	const byPath = new Map(manifest.occurrences.map((o) => [o.path, o]));
	// KiCad's board body is an occurrence of its own inside the board component.
	const slots = new Set(pcbs.map((b) => {
		const holder = byPath.get(b.occ!)!;
		return PCB_NAME.test(holder.component) && holder.parent ? holder.parent : holder.path;
	}));
	return slots.size === 1 ? { slot: byPath.get([...slots][0])!, pcbs } : null;
}

export function boardBodies(manifest: Manifest): Body[] {
	return manifest.bodies.filter(isPcb);
}

function invertRigid(m: Mat): Mat {
	const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
	const t = [0, 1, 2].map((i) => -(r[i * 3] * m[3] + r[i * 3 + 1] * m[7] + r[i * 3 + 2] * m[11]));
	return [r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2], 0, 0, 0, 1];
}

function multiply(a: Mat, b: Mat): Mat {
	const out = new Array(16).fill(0);
	for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
	return out;
}

/** The board bodies' facts together, in the frame of `frame` (an occurrence's world matrix) or the export's own. */
export function pcbFacts(dir: string, manifest: Manifest, pcbs: Body[], frame: Mat | null): PcbFacts {
	const all = pcbs.map((pcb) => bodyFacts(dir, manifest, pcb, frame));
	return {
		box: [Math.min(...all.map((f) => f.box[0])), Math.min(...all.map((f) => f.box[1])), Math.max(...all.map((f) => f.box[2])), Math.max(...all.map((f) => f.box[3]))],
		bottom: Math.min(...all.map((f) => f.bottom)),
		top: Math.max(...all.map((f) => f.top))
	};
}

function bodyFacts(dir: string, manifest: Manifest, pcb: Body, frame: Mat | null): PcbFacts {
	const holder = manifest.occurrences.find((o) => o.path === pcb.occ);
	const world = holder?.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	const m = frame ? multiply(invertRigid(frame), world) : world;
	const at = (x: number, y: number, z: number, row: number) => m[row * 4] * x + m[row * 4 + 1] * y + m[row * 4 + 2] * z + m[row * 4 + 3];

	const bin = readFileSync(`${dir}/m_${String(pcb.mesh).padStart(3, '0')}.bin`);
	const nodes = bin.readUInt32LE(0);
	const positions = new Float32Array(bin.buffer.slice(bin.byteOffset + 8, bin.byteOffset + 8 + nodes * 12));
	const box: PcbFacts['box'] = [Infinity, Infinity, -Infinity, -Infinity];
	for (let i = 0; i < nodes; i++) {
		const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
		const px = at(x, y, z, 0), py = at(x, y, z, 1);
		box[0] = Math.min(box[0], px);
		box[1] = Math.min(box[1], py);
		box[2] = Math.max(box[2], px);
		box[3] = Math.max(box[3], py);
	}

	// Plane records are [0, area, loops, nx, ny, nz, d] with n·p = d, in the solid's own frame.
	const measure: RawMeasure = JSON.parse(readFileSync(`${dir}/measure.json`, 'utf8'));
	let bottom = Infinity, top = -Infinity;
	for (const face of measure.solids[pcb.mesh].f) {
		if (face[0] !== 0) continue;
		const [nx, ny, nz, d] = face.slice(3) as number[];
		const n = [0, 1, 2].map((row) => m[row * 4] * nx + m[row * 4 + 1] * ny + m[row * 4 + 2] * nz);
		const offset = d + n[0] * m[3] + n[1] * m[7] + n[2] * m[11];
		if (n[2] < -0.999) bottom = Math.min(bottom, -offset);
		if (n[2] > 0.999) top = Math.max(top, offset);
	}
	if (!Number.isFinite(bottom) || !Number.isFinite(top)) throw new Error(`${pcb.body}: no flat top and bottom faces`);
	const round = (v: number) => Number(v.toFixed(4));
	return { box: box.map(round) as PcbFacts['box'], bottom: round(bottom), top: round(top) };
}

/**
 * How an upstream board goes into a slot: as it is ({}), shifted by `fix`, or not at all (null) when the CAD board
 * is in another frame. The boxes only need to overlap well, since the upstream outline may have changed since the
 * CAD board was imported; the bottom faces must agree exactly, or the difference becomes the fix.
 */
export function register(cad: PcbFacts, board: PcbFacts): { fix?: [number, number, number] } | null {
	const [ax0, ay0, ax1, ay1] = cad.box, [bx0, by0, bx1, by1] = board.box;
	const overlap = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) * Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
	const smaller = Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0));
	if (!(overlap > 0.25 * smaller)) return null;
	const dz = Number((cad.bottom - board.bottom).toFixed(4));
	return Math.abs(dz) < 0.001 ? {} : { fix: [0, 0, dz] };
}
