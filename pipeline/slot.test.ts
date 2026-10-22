import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gltfJson, partsOf, type Mat, type Part } from './glb.ts';
import { boardBodies, centre, findPart, findSlot, pcbFacts, register, type PcbFacts } from './slot.ts';
import type { Blob, Catalogue, MeasureData, SolidRecord } from './stepstr.ts';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// The Seed's board slot: flipped about Y and moved, as Fusion has it (origin 203.2, -0.03, 0.56). Row-major, as CAD
// writes it; glTF's column-major is its transpose.
const SEED_SLOT = [-1, 0, 0, 203.2, 0, 1, 0, -0.03, 0, 0, -1, 0.56, 0, 0, 0, 1];
const lift = (m: number[], dz: number) => m.map((v, i) => (i === 11 ? v + m[10] * dz : v));
const columns = (m: number[]): Mat => [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => m[r * 4 + c]));

const occurrence = (id: string, name: string, component: string, parent: Part | null, world: number[]): Part =>
	({ id, name, component, body: false, parent, world: columns(world) });
const body = (name: string, parent: Part | null): Part => ({ id: `${name}-body`, name, body: true, solid: 0, parent, world: parent?.world ?? I });

/** A model with one board body: a 52.56 x 37.39 x 0.7012 slab in KiCad's page frame, under `holder`. */
function modelWith(holder: number[]): { parts: Part[]; measure: MeasureData } {
	const [x0, y0, x1, y1, t] = [74.52, -84.805, 127.08, -47.415, 0.7012];
	const p = [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [0, t].flatMap((z) => [x, y, z])));
	const f: SolidRecord['f'] = [[0, 1965, [], 0, 0, -1, 0], [0, 1965, [], 0, 0, 1, t], [0, 26, [], 1, 0, 0, x1]];
	const frame = occurrence('frame1', 'frame:1', 'frame', null, I);
	const slot = occurrence('slot01', 'seed_v4_pcb_3bd63c8:1', 'seed_v4_pcb_3bd63c8', null, SEED_SLOT);
	const pcb = occurrence('pcb001', 'seed_PCB:1', 'seed_PCB', slot, holder);
	return { parts: [frame, slot, pcb, body('seed_PCB', pcb)], measure: { v: 1, units: 'mm', glb: '', solids: [{ tol: 0, p, e: [], f }] } };
}

describe('board slots', () => {
	it('is the sub-assembly around the KiCad board body', () => {
		const { parts } = modelWith(SEED_SLOT);
		expect(findSlot(parts)?.slot.name).toBe('seed_v4_pcb_3bd63c8:1');
		// Board bodies in two places: no single slot.
		expect(findSlot([...parts, body('seed_PCB', parts[0])])).toBeNull();
		// A board in two pieces (seed_PCB_1, seed_PCB_2) is still one slot.
		const pieces = [...parts.slice(0, 3), body('seed_PCB_1', parts[2]), body('seed_PCB_2', parts[2])];
		expect(findSlot(pieces)?.pcbs.map((b) => b.name)).toEqual(['seed_PCB_1', 'seed_PCB_2']);
	});

	it('reads the board body back in KiCad’s frame through the slot’s flip', () => {
		const { parts, measure } = modelWith(SEED_SLOT);
		const found = findSlot(parts)!;
		expect(pcbFacts(measure, found.pcbs, found.slot.world)).toEqual({ box: [74.52, -84.805, 127.08, -47.415], bottom: 0, top: 0.7012 });
	});

	it('sees a board that moved inside its link', () => {
		const { parts, measure } = modelWith(lift(SEED_SLOT, 0.8));
		const found = findSlot(parts)!;
		expect(pcbFacts(measure, found.pcbs, found.slot.world)).toMatchObject({ bottom: 0.8, top: 1.5012 });
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
		// Hammer 546c9ea: the board corner, not KiCad's page origin, at 0,0.
		expect(register({ box: [0, -50, 119.5, 0], bottom: 0, top: 1.5162 }, upstream)).toBeNull();
	});

	it('refuses a CAD board laid out another way', () => {
		// Hammer 16ccf13: a portrait board in the same frame, less than half of it over the landscape upstream one.
		const landscape: PcbFacts = { box: [63, -126, 185, -73], bottom: 0, top: 1.5162 };
		expect(register({ box: [75.15, -126, 138.15, 13], bottom: 0, top: 1.5162 }, landscape)).toBeNull();
	});
});

describe('a board on a part modelled in CAD', () => {
	// The Seed E's PCB_back: 42 x 53.5 mm, 1.65 mm thick, centred on the model.
	const part: PcbFacts = { box: [-21, -26.75, 21, 26.75], bottom: -0.05, top: 1.6 };

	it('is the one occurrence of the component, with every body below it', () => {
		const pcb = occurrence('pcb002', 'PCB_back:1', 'PCB_back', null, I);
		const holder = occurrence('pads01', 'pads:1', 'pads', pcb, I);
		const parts = [pcb, body('PCB_back', pcb), holder, body('PCB_back (2)', holder), body('Frame', null)];
		expect(findPart(parts, 'PCB_back')).toEqual({ slot: pcb, bodies: [parts[1], parts[3]] });
		expect(findPart([...parts, occurrence('pcb003', 'PCB_back:2', 'PCB_back', null, I)], 'PCB_back')).toBeNull();
		expect(findPart(parts, 'PCB_front')).toBeNull();
	});

	it('centres a board of the same size on it and sets it on its bottom face', () => {
		// A KiCad board on its page: 41.8 x 53.3 mm with its corner at 100, -80.
		const board: PcbFacts = { box: [100, -80, 141.8, -26.7], bottom: 0, top: 1.6 };
		expect(centre(part, board)).toEqual({ fix: [-120.9, 53.35, -0.05] });
		expect(centre(part, { box: [-21, -26.75, 21, 26.75], bottom: -0.05, top: 1.55 })).toEqual({});
	});

	it('refuses a board of another size, or one turned the other way', () => {
		expect(centre(part, { box: [0, 0, 42.6, 53.5], bottom: 0, top: 1.6 })).toBeNull();
		expect(centre(part, { box: [0, 0, 53.5, 42], bottom: 0, top: 1.6 })).toBeNull();
	});
});

// The files npm run catalogue made: the II as it shows today, its 43647aa with the mainboard of commit 8a9ea69.
const built: Catalogue | null = existsSync('catalogue.json') ? JSON.parse(readFileSync('catalogue.json', 'utf8')) : null;
const read = (files: { glb: Blob; measure: Blob }) => ({
	parts: partsOf(gltfJson(readFileSync(`catalogue-files/${files.glb.sha256}`))),
	measure: JSON.parse(gunzipSync(readFileSync(`catalogue-files/${files.measure.sha256}`)).toString('utf8')) as MeasureData
});

describe.skipIf(!built?.models.ii?.companions)('the II and its upstream board', () => {
	it('fits board 8a9ea69 into 43647aa as it is, in the slot b2xsvl', () => {
		const ii = built!.models.ii;
		const ii43647aa = read(ii.versions.find((v) => v.id === '43647aa')!.files);
		const board = read(ii.companions!.revisions.find((r) => r.id === '8a9ea69')!.files);
		const found = findSlot(ii43647aa.parts)!;
		expect(found.slot.id).toBe('b2xsvl');
		expect(register(pcbFacts(ii43647aa.measure, found.pcbs, found.slot.world), pcbFacts(board.measure, boardBodies(board.parts), null))).toEqual({});
	});
});

describe.skipIf(!built?.models.seed?.companions)('the Seed E and the upstream Seed boards', () => {
	it('has a 42 x 53.5 mm PCB_back that neither the newest board nor the earlier small one fits', () => {
		const seed = built!.models.seed;
		const e = read(seed.versions.find((v) => v.id === 'cd40582')!.files);
		const found = findPart(e.parts, 'PCB_back')!;
		const facts = pcbFacts(e.measure, found.bodies, found.slot.world);
		expect([facts.box[2] - facts.box[0], facts.box[3] - facts.box[1]].map((v) => Number(v.toFixed(2)))).toEqual([42, 53.5]);
		for (const id of ['fbd649f', 'ecc0161']) {
			const board = read(seed.companions!.revisions.find((r) => r.id === id)!.files);
			expect(centre(facts, pcbFacts(board.measure, boardBodies(board.parts), null))).toBeNull();
		}
	});
});

