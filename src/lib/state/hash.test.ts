import { describe, expect, it } from 'vitest';
import { decode, defaultState, encode, formatRef, parseRef } from './hash';

describe('hash', () => {
	it.each([
		'#/hammer',
		'#/seed@4',
		'#/hammer@41?hide=a3,b0&cut=x:12.5,z:-3!&ex=0.6',
		'#/seed?iso=c7&cut=y:0&cam=120,80,90;0,0,20&sel=c7&edges=0',
		'#/hammer?cam=100,-200,150.5;0,0,80;2.5&ortho=1',
		'#/hammer@50?m=k3x9a1.f12.q7,0f2kq7.c40',
		'#/seed@15?cut=y:0&cam=120,80,90;0,0,20&sel=c7&m=a1.e3,a1.v0.x2&edges=0',
		'#/seed@26?b=7ac023b&hide=a3',
		'#/hammer?b=cad'
	])('round-trips %s', (hash) => {
		expect(encode(decode(hash))).toBe(hash);
	});

	it('reads the board as an upstream revision or cad, and drops anything else', () => {
		expect(decode('#/seed?b=7ac023b').board).toBe('7ac023b');
		expect(decode('#/seed@22?b=cad').board).toBe('cad');
		expect(decode('#/seed?b=latest').board).toBeNull();
		expect(decode('#/seed?b=7AC023B').board).toBeNull();
		expect(decode('#/seed').board).toBeNull();
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

	it('reads measured items and drops what does not parse', () => {
		const state = decode('#/seed@15?m=a1.x3,a1.f,a1.f-1,A1.f2,a1.f01,a1.f1234567,a1.f2.abc,b2.f7.zz');
		expect(state.measure).toEqual([{ part: 'b2', kind: 'f', index: 7, check: 'zz' }]);
		expect(parseRef('k3x9a1.m0')).toEqual({ part: 'k3x9a1', kind: 'm', index: 0 });
		expect(formatRef({ part: 'a', kind: 'c', index: 12, check: '3b' })).toBe('a.c12.3b');
	});

	it('keeps two measured items, each once', () => {
		expect(decode('#/seed@15?m=a.f1,a.f1.zz,a.e2,a.v3').measure.map(formatRef)).toEqual(['a.f1', 'a.e2']);
	});

	it('measures the assembled model', () => {
		expect(decode('#/seed@15?ex=0.6&m=a.f1').explode).toBe(0);
		expect(decode('#/seed@15?ex=0.6').explode).toBe(0.6);
	});

	it('writes measured items only into a route that names its version', () => {
		const state = decode('#/seed@15?m=a.f1');
		expect(encode({ ...state, version: null })).toBe('#/seed');
	});
});
