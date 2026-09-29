import { describe, expect, it } from 'vitest';
import { decode, defaultState, encode } from './hash';

describe('hash', () => {
	it.each([
		'#/hammer',
		'#/seed@4',
		'#/hammer@41?hide=a3,b0&cut=x:12.5,z:-3!&ex=0.6',
		'#/seed?iso=c7&cut=y:0&cam=120,80,90;0,0,20&sel=c7&edges=0',
		'#/hammer?cam=100,-200,150.5;0,0,80;2.5&ortho=1'
	])('round-trips %s', (hash) => {
		expect(encode(decode(hash))).toBe(hash);
	});

	it('falls back to the default model on garbage', () => {
		expect(decode('#nonsense')).toEqual(defaultState());
		expect(decode('')).toEqual(defaultState());
	});

	it('drops malformed values and keeps the rest', () => {
		const state = decode('#/hammer?hide=a3,<script>&cut=x:1,w:2,y:abc&ex=7&cam=1,2;3,4,5&sel=b2');
		expect(state.hidden).toEqual([]);
		expect(state.cuts).toEqual([{ axis: 'x', offset: 1, flip: false }]);
		expect(state.explode).toBe(1);
		expect(state.camera).toBeNull();
		expect(state.selected).toBe('b2');
	});

	it('keeps at most three section planes', () => {
		expect(decode('#/seed?cut=x:1,y:2,z:3,x:4').cuts).toHaveLength(3);
	});

	it('rounds camera coordinates to 0.1 mm', () => {
		const state = defaultState('seed');
		state.camera = { position: [1.234567, 2, 3], target: [0, 0, 0.049] };
		expect(encode(state)).toBe('#/seed?cam=1.2,2,3;0,0,0');
	});
});
