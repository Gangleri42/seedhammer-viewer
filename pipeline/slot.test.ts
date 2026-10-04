import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Manifest } from './build-model.ts';
import { findSlot, pcbFacts, register, type PcbFacts } from './slot.ts';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// The Seed's board slot: flipped about Y and moved, as Fusion has it (origin 203.2, -0.03, 0.56).
const SEED_SLOT = [-1, 0, 0, 203.2, 0, 1, 0, -0.03, 0, 0, -1, 0.56, 0, 0, 0, 1];
const lift = (m: number[], dz: number) => m.map((v, i) => (i === 11 ? v + m[10] * dz : v));

/** An export with one board body: a 52.56 x 37.39 x 0.7012 slab in KiCad's page frame, under `holder`. */
function exportWith(holder: number[]): { dir: string; manifest: Manifest } {
	const dir = mkdtempSync(`${tmpdir()}/slot-`);
	const [x0, y0, x1, y1, t] = [74.52, -84.805, 127.08, -47.415, 0.7012];
	const corners = [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [0, t].flatMap((z) => [x, y, z])));
	const head = Buffer.alloc(8);
	head.writeUInt32LE(8, 0);
	writeFileSync(`${dir}/m_000.bin`, Buffer.concat([head, Buffer.from(new Float32Array(corners).buffer)]));
	writeFileSync(`${dir}/measure.json`, JSON.stringify({ v: 1, solids: [{ p: [], e: [], f: [[0, 1965, [], 0, 0, -1, 0], [0, 1965, [], 0, 0, 1, t], [0, 26, [], 1, 0, 0, x1]] }] }));
	const occurrences = [
		{ path: 'frame:1', parent: null, name: 'frame:1', component: 'frame', linked: false, matrix: I },
		{ path: 'seed_v4_pcb_3bd63c8:1', parent: null, name: 'seed_v4_pcb_3bd63c8:1', component: 'seed_v4_pcb_3bd63c8', linked: false, matrix: SEED_SLOT },
		{ path: 'seed_v4_pcb_3bd63c8:1+seed_PCB:1', parent: 'seed_v4_pcb_3bd63c8:1', name: 'seed_PCB:1', component: 'seed_PCB', linked: false, matrix: holder }
	];
	const bodies = [{ occ: 'seed_v4_pcb_3bd63c8:1+seed_PCB:1', body: 'seed_PCB', mesh: 0, appearance: null }];
	return { dir, manifest: { doc: 'seed_v4', version: 26, units: 'mm', occurrences, bodies, meshes: [], appearances: {}, fastener_partners: {} } };
}

describe('board slots', () => {
	it('is the sub-assembly around the KiCad board body', () => {
		const { manifest } = exportWith(SEED_SLOT);
		expect(findSlot(manifest)?.slot.path).toBe('seed_v4_pcb_3bd63c8:1');
		// Board bodies in two places: no single slot.
		expect(findSlot({ ...manifest, bodies: [...manifest.bodies, { ...manifest.bodies[0], occ: 'frame:1' }] })).toBeNull();
		// A board in two pieces (seed_PCB_1, seed_PCB_2) is still one slot.
		const pieces = { ...manifest, bodies: [{ ...manifest.bodies[0], body: 'seed_PCB_1' }, { ...manifest.bodies[0], body: 'seed_PCB_2' }] };
		expect(findSlot(pieces)?.pcbs.map((b) => b.body)).toEqual(['seed_PCB_1', 'seed_PCB_2']);
	});

	it('reads the board body back in KiCad’s frame through the slot’s flip', () => {
		const { dir, manifest } = exportWith(SEED_SLOT);
		const found = findSlot(manifest)!;
		expect(pcbFacts(dir, manifest, found.pcbs, found.slot.matrix)).toEqual({ box: [74.52, -84.805, 127.08, -47.415], bottom: 0, top: 0.7012 });
	});

	it('sees a board that moved inside its link', () => {
		const { dir, manifest } = exportWith(lift(SEED_SLOT, 0.8));
		const found = findSlot(manifest)!;
		expect(pcbFacts(dir, manifest, found.pcbs, found.slot.matrix)).toMatchObject({ bottom: 0.8, top: 1.5012 });
	});
});

describe('registration', () => {
	const upstream: PcbFacts = { box: [63, -126, 182.5, -76], bottom: 0, top: 1.5162 };

	it('fits an upstream board as it is, even when its outline has changed', () => {
		expect(register(upstream, upstream)).toEqual({});
		expect(register({ ...upstream, box: [63, -126, 150, -80] }, upstream)).toEqual({});
	});

	it('shifts it where the CAD board sits higher in its link', () => {
		expect(register({ ...upstream, bottom: 0.8, top: 2.3162 }, upstream)).toEqual({ fix: [0, 0, 0.8] });
	});

	it('refuses a CAD board exported with another origin', () => {
		// Hammer v41: the board corner, not KiCad's page origin, at 0,0.
		expect(register({ box: [0, -50, 119.5, 0], bottom: 0, top: 1.5162 }, upstream)).toBeNull();
	});
});
