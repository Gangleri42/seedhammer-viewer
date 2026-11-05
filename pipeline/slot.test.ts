import { describe, expect, it } from 'vitest';
import type { Part } from './glb.ts';
import { boardBodies, findPart, findSlot } from './slot.ts';

const occurrence = (id: string, component: string, parent: Part | null): Part => ({ id, name: `${component}:1`, component, body: false, parent });
const body = (name: string, parent: Part | null): Part => ({ id: `${name}-body`, name, body: true, solid: 0, parent });

describe('the part a board takes the place of', () => {
	it('is the sub-assembly around the KiCad board body', () => {
		const frame = occurrence('frame1', 'frame', null);
		const slot = occurrence('slot01', 'muscle57', null);
		const pcb = occurrence('pcb001', 'muscle_export_PCB', slot);
		const parts = [frame, body('side_plate', frame), slot, pcb, body('muscle_export_PCB', pcb)];
		expect(findSlot(parts)?.id).toBe('slot01');
		expect(boardBodies(parts).map((p) => p.name)).toEqual(['muscle_export_PCB']);
	});

	it('takes the separate pieces of an outline as one board, and refuses boards in two places', () => {
		const slot = occurrence('slot01', 'muscle', null);
		const other = occurrence('slot02', 'muscle', null);
		const one = [slot, body('muscle_PCB_1', slot), body('muscle_PCB_2', slot)];
		expect(findSlot(one)?.id).toBe('slot01');
		expect(findSlot([...one, other, body('muscle_PCB_3', other)])).toBeNull();
	});

	it('is the one occurrence of the part boards.json names, with a body below it', () => {
		const seed = occurrence('seed01', 'Seed', null);
		const back = occurrence('back01', 'PCB_back', seed);
		const parts = [seed, back, body('pcb', back)];
		expect(findPart(parts, 'PCB_back')?.id).toBe('back01');
		expect(findPart(parts, 'nothing')).toBeNull();
		expect(findPart([seed, back], 'PCB_back')).toBeNull();
		expect(findPart([...parts, occurrence('back02', 'PCB_back', seed)], 'PCB_back')).toBeNull();
	});
});
