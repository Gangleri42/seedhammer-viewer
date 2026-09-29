import { describe, expect, it } from 'vitest';
import type { MeasureRef } from '$lib/state/hash';
import { nextSelection } from './selection';

const f = (index: number): MeasureRef => ({ part: 'a', kind: 'f', index });

describe('measure selection', () => {
	it('fills Selection 1, then Selection 2', () => {
		expect(nextSelection([], f(1))).toEqual([f(1)]);
		expect(nextSelection([f(1)], f(2))).toEqual([f(1), f(2)]);
	});

	it('replaces Selection 2 on a third pick', () => {
		expect(nextSelection([f(1), f(2)], f(3))).toEqual([f(1), f(3)]);
	});

	it('takes a selected item out again, whatever its check', () => {
		expect(nextSelection([f(1), f(2)], { ...f(1), check: 'zz' })).toEqual([f(2)]);
	});

	it('leaves everything alone on empty space', () => {
		const current = [f(1)];
		expect(nextSelection(current, null)).toBe(current);
	});
});
