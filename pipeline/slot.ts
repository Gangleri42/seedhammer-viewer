// Where a board goes in an enclosure. Each Fusion export holds its PCB as one sub-assembly, the slot, whose frame is
// KiCad's page frame: the board came in as a kicad-cli export with the default origin. An upstream export made the
// same way fits the slot as it is. Registration checks that on the board body: its outline box must overlap and its
// exact bottom face must lie where the upstream one does, else the board needs a shift (one moved inside its link) or
// does not fit at all (an export with another origin). Both sides are stepstr conversions: the tree and placements from
// the GLB (glb.ts), the shape from the measurement data.
//
// A model whose PCB is modelled in CAD itself has no KiCad board body. boards.json can name that part instead (`slot`):
// the board is then centred on it (centre), as long as the two outlines are the same size.
import { invertRigid, multiply, type Mat, type Part } from './glb.ts';
import type { MeasureData, SolidRecord } from './stepstr.ts';

/** The board body in some frame: outline box [x0, y0, x1, y1] and the z of its bottom and top faces, mm. */
export type PcbFacts = { box: [number, number, number, number]; bottom: number; top: number };

/** KiCad names the board body <board>_PCB, or <board>_PCB_1, _2... when the outline has separate pieces. */
export const PCB_NAME = /_PCB(?:_\d+)?$/;

/** A part modelled in CAD that a board takes the place of, by its component name (boards.json). */
export type PartSlot = { part: string; align: 'centre' };

/** How much the board's outline may differ from the part's in width or in depth for it to take the part's place, mm. */
const SIZE_TOLERANCE = 0.5;

/** Arcs are traced at this step for the outline box, radians: a 2 mm corner then strays under 0.1 µm. */
const ARC_STEP = Math.PI / 1800;

export const boardBodies = (parts: Part[]) => parts.filter((part) => part.body && PCB_NAME.test(part.name));

/** The slot and its board bodies, when every board body sits in one sub-assembly. */
export function findSlot(parts: Part[]): { slot: Part; pcbs: Part[] } | null {
	const pcbs = boardBodies(parts);
	if (!pcbs.length || pcbs.some((b) => b.parent === null)) return null;
	// KiCad's board body is an occurrence of its own inside the board component.
	const slots = new Set(pcbs.map((b) => {
		const holder = b.parent!;
		return PCB_NAME.test(holder.component ?? '') && holder.parent ? holder.parent : holder;
	}));
	return slots.size === 1 ? { slot: [...slots][0], pcbs } : null;
}

/** The one occurrence of `component` and the bodies below it, or null when the model has none or several. */
export function findPart(parts: Part[], component: string): { slot: Part; bodies: Part[] } | null {
	const found = parts.filter((p) => !p.body && p.component === component);
	if (found.length !== 1) return null;
	const below = (p: Part) => {
		for (let at = p.parent; at; at = at.parent) if (at === found[0]) return true;
		return false;
	};
	const bodies = parts.filter((p) => p.body && below(p));
	return bodies.length ? { slot: found[0], bodies } : null;
}

/** The board bodies' facts together, in the frame of `frame` (an occurrence's placement) or the model's own. */
export function pcbFacts(measure: MeasureData, pcbs: Part[], frame: Mat | null): PcbFacts {
	const all = pcbs.map((pcb) => bodyFacts(measure, pcb, frame));
	const facts: PcbFacts = {
		box: [Math.min(...all.map((f) => f.box[0])), Math.min(...all.map((f) => f.box[1])), Math.max(...all.map((f) => f.box[2])), Math.max(...all.map((f) => f.box[3]))],
		bottom: Math.min(...all.map((f) => f.bottom)),
		top: Math.max(...all.map((f) => f.top))
	};
	// A part's pieces (pads, a stiffener) need not all be flat; together they must have a bottom and a top.
	if (!Number.isFinite(facts.bottom) || !Number.isFinite(facts.top)) throw new Error(`${pcbs[0].name}: no flat top and bottom faces`);
	return facts;
}

/** The points an outline box reaches: vertices, arcs traced along, and the polylines of other curves. */
function outlinePoints(solid: SolidRecord): number[][] {
	const points: number[][] = [];
	for (let i = 0; i < solid.p.length; i += 3) points.push(solid.p.slice(i, i + 3));
	for (const edge of solid.e) {
		if (edge?.[0] === 1) {
			const [, , , cx, cy, cz, nx, ny, nz, rx, ry, rz, radius, sweep] = edge;
			const side = [ny * rz - nz * ry, nz * rx - nx * rz, nx * ry - ny * rx];
			for (let a = 0; a < sweep; a += ARC_STEP) {
				const c = radius * Math.cos(a), s = radius * Math.sin(a);
				points.push([cx + c * rx + s * side[0], cy + c * ry + s * side[1], cz + c * rz + s * side[2]]);
			}
		} else if (edge?.[0] === 2) {
			for (let i = 0; i < edge[7].length; i += 3) points.push(edge[7].slice(i, i + 3));
		}
	}
	return points;
}

function bodyFacts(measure: MeasureData, pcb: Part, frame: Mat | null): PcbFacts {
	// A body's solid is in the frame of its occurrence, the body's parent.
	const world = pcb.parent!.world;
	const m = frame ? multiply(invertRigid(frame), world) : world;
	const solid = pcb.solid === undefined ? null : measure.solids[pcb.solid];
	if (!solid) throw new Error(`${pcb.name}: no exact geometry`);

	const box: PcbFacts['box'] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const [x, y, z] of outlinePoints(solid)) {
		const px = m[0] * x + m[4] * y + m[8] * z + m[12], py = m[1] * x + m[5] * y + m[9] * z + m[13];
		box[0] = Math.min(box[0], px);
		box[1] = Math.min(box[1], py);
		box[2] = Math.max(box[2], px);
		box[3] = Math.max(box[3], py);
	}

	// Plane records are [0, area, loops, nx, ny, nz, d] with n·p = d, in the solid's own frame.
	let bottom = Infinity, top = -Infinity;
	for (const face of solid.f) {
		if (face[0] !== 0) continue;
		const [nx, ny, nz, d] = face.slice(3) as number[];
		const n = [0, 1, 2].map((row) => m[row] * nx + m[4 + row] * ny + m[8 + row] * nz);
		const offset = d + n[0] * m[12] + n[1] * m[13] + n[2] * m[14];
		if (n[2] < -0.999) bottom = Math.min(bottom, -offset);
		if (n[2] > 0.999) top = Math.max(top, offset);
	}
	const round = (v: number) => Number(v.toFixed(4));
	return { box: box.map(round) as PcbFacts['box'], bottom: round(bottom), top: round(top) };
}

/**
 * How an upstream board goes into a slot: as it is ({}), shifted by `fix`, or not at all (null) when the CAD board
 * is in another frame or laid out another way. The boxes need to overlap well, over more than half of the larger one,
 * since the upstream outline may have changed since the CAD board was imported; the bottom faces must agree exactly,
 * or the difference becomes the fix.
 */
export function register(cad: PcbFacts, board: PcbFacts): { fix?: [number, number, number] } | null {
	const [ax0, ay0, ax1, ay1] = cad.box, [bx0, by0, bx1, by1] = board.box;
	const overlap = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) * Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
	const larger = Math.max((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0));
	if (!(overlap > 0.5 * larger)) return null;
	const dz = Number((cad.bottom - board.bottom).toFixed(4));
	return Math.abs(dz) < 0.001 ? {} : { fix: [0, 0, dz] };
}

/**
 * How a board takes the place of a part modelled in CAD: shifted so that the centre of its outline box is the centre
 * of the part's and its bottom face lies on the part's, both in the part's frame. Null when the outlines differ in
 * width or depth by more than SIZE_TOLERANCE; a board is never turned to fit.
 */
export function centre(part: PcbFacts, board: PcbFacts): { fix?: [number, number, number] } | null {
	const size = (f: PcbFacts) => [f.box[2] - f.box[0], f.box[3] - f.box[1]];
	const [pw, pd] = size(part), [bw, bd] = size(board);
	if (Math.abs(pw - bw) > SIZE_TOLERANCE || Math.abs(pd - bd) > SIZE_TOLERANCE) return null;
	const middle = (f: PcbFacts, axis: 0 | 1) => (f.box[axis] + f.box[axis + 2]) / 2;
	const shift = [middle(part, 0) - middle(board, 0), middle(part, 1) - middle(board, 1), part.bottom - board.bottom];
	const fix = shift.map((v) => Number(v.toFixed(4)) || 0) as [number, number, number];
	return fix.every((v) => Math.abs(v) < 0.001) ? {} : { fix };
}
