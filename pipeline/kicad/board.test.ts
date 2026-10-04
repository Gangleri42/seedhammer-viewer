import { describe, expect, it } from 'vitest';
import { blockEnd, footprintBox, footprints, libraryRefs, modelledRefs, outlineBox, prepare, root, shapeText, useNearest } from './board.ts';
import { BOARD } from './fixture.ts';

const lib = '${KIPRJMOD}/../../lib';
const R0402 = '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step';

describe('reading a board', () => {
	it('finds whole blocks, parentheses inside strings included', () => {
		expect(blockEnd(BOARD, root(BOARD).start)).toBe(BOARD.trimEnd().length);
		expect(blockEnd('(a "(" (b ")") c)', 0)).toBe(17);
		expect(() => blockEnd('(a (b)', 0)).toThrow(/unbalanced/);
	});

	it('lists footprints with reference, position and models', () => {
		const fps = footprints(BOARD);
		expect(fps.map((f) => [f.ref, f.x, f.y, f.angle])).toEqual([['R1', 10, 20, 90], ['U13', 30, 25, 0], ['L6', 40, 30, 0], ['R99', 200, 20, 0], ['TP1', 15, 15, 0], ['J9', 101.5, 25, 90]]);
		const u13 = fps[1].models;
		expect(u13.map((m) => [m.path.split('/').pop(), m.hidden])).toEqual([['RSE0010A.stp', false], ['Texas_UQFN-10_1.5x2mm_P0.5mm.step', true]]);
		expect(modelledRefs(BOARD)).toEqual(['J9', 'L6', 'R1', 'R99', 'U13']);
	});

	it('measures the Edge.Cuts outline', () => {
		expect(outlineBox(BOARD)).toEqual([0, 0, 100, 50]);
	});

	it('places a footprint by its courtyard, turned with it, else by its origin', () => {
		const fps = footprints(BOARD);
		const box = footprintBox(BOARD, fps.find((f) => f.ref === 'J9')!)!.map((v) => Number(v.toFixed(6)));
		expect(box).toEqual([99.5, 22, 103.5, 28]);
		expect(footprintBox(BOARD, fps.find((f) => f.ref === 'R99')!)).toEqual([200, 20, 200, 20]);
	});

	it('names the repository models a board uses', () => {
		expect(libraryRefs(BOARD)).toEqual(['RSE0010A.stp']);
	});

	it('keeps what shapes the 3D export and drops copper and uuids', () => {
		const text = shapeText(BOARD);
		expect(text).not.toMatch(/\((segment|arc|zone)\b/);
		expect(text).not.toMatch(/uuid/);
		expect(text).toMatch(/\(via \(at 3 3\)/);
		expect(text).toMatch(/\(at 40 30\)/);
		// Routing alone leaves it unchanged; moving a part does not.
		expect(shapeText(BOARD.replace('(segment (start 1 1)', '(segment (start 5 5)'))).toBe(text);
		expect(shapeText(BOARD.replace('(via (at 3 3)', '(group "" (members "22222222-2222-2222-2222-222222222222"))\n\t(via (at 3 3)'))).toBe(text);
		expect(shapeText(BOARD.replace('(at 40 30)', '(at 41 30)'))).not.toBe(text);
	});
});

describe('preparing a board for export', () => {
	const { text, notes } = prepare(BOARD, { scale: { L6: [1, 1, 0.64], L99: [1, 1, 2] } }, { libPrefix: lib, libHas: (name) => name === 'RSE0010A.stp' });

	it('points models in the engineer’s checkout at the repository’s lib', () => {
		expect(footprints(text).find((f) => f.ref === 'U13')!.models[0].path).toBe(`${lib}/RSE0010A.stp`);
		expect(notes).toContain('models from the repository\'s lib: U13');
	});

	it('leaves out parts parked off the board, and keeps a connector over the edge', () => {
		expect(footprints(text).map((f) => f.ref)).toEqual(['R1', 'U13', 'L6', 'TP1', 'J9']);
		expect(notes).toContain('left out, parked outside the board: R99');
	});

	it('scales models by reference and says which scales found no part', () => {
		const l6 = footprints(text).find((f) => f.ref === 'L6')!;
		expect(text.slice(l6.start, l6.end)).toMatch(/\(scale \(xyz 1 1 0\.64\)\)/);
		expect(notes).toContain('model scale: L6 1×1×0.64');
		expect(notes).toContain('scale not needed or no such part: L99');
	});

	it('changes nothing else', () => {
		const untouched = (t: string) => t.slice(t.indexOf('(gr_line'));
		expect(untouched(text)).toBe(untouched(BOARD));
	});
});

describe('closest stock models', () => {
	const nearest = { 'Resistor_SMD.3dshapes/R_0402_1005Metric': 'Resistor_SMD.3dshapes/R_0402_1005Metric_Pad0.72x0.64mm_HandSolder' };

	it('swaps only the models KiCad could not find', () => {
		const swapped = useNearest(BOARD, new Set([R0402]), nearest)!;
		expect(footprints(swapped.text).find((f) => f.ref === 'R1')!.models[0].path).toBe('${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric_Pad0.72x0.64mm_HandSolder.step');
		expect(swapped.note).toBe('closest stock models: R_0402_1005Metric → R_0402_1005Metric_Pad0.72x0.64mm_HandSolder (R1, R99)');
	});

	it('returns null when nothing applies', () => {
		expect(useNearest(BOARD, new Set(), nearest)).toBeNull();
		expect(useNearest(BOARD, new Set([R0402]), {})).toBeNull();
	});
});
