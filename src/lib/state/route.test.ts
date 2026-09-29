import { describe, expect, it } from 'vitest';
import { decode, encode, isRoute } from './hash';
import { CONVENTION, conventionUri, normalizeRoute, routeFromPayload, toPayload } from './route';

describe('route', () => {
	it('recognises the hash grammar and nothing else', () => {
		expect(isRoute('#/hammer')).toBe(true);
		expect(isRoute('#/hammer@41?hide=a3,b0&cut=x:12.5!,z:-3&cam=1,2,3;4,5,6;2&edges=0')).toBe(true);
		expect(isRoute('#/hammer@41?m=k3x9a1.f12.q7,0f2kq7.c40')).toBe(true);
		expect(isRoute('#nonsense')).toBe(false);
		expect(isRoute('#/hammer?x=<script>')).toBe(false);
		expect(isRoute('#/hammer?a=b#c')).toBe(false);
	});

	it('normalises with or without the leading hash', () => {
		expect(normalizeRoute('/hammer@41?cut=x:12.5')).toBe('#/hammer@41?cut=x:12.5');
		expect(normalizeRoute(' #/seed ')).toBe('#/seed');
		expect(normalizeRoute('javascript:alert(1)')).toBeNull();
		expect(normalizeRoute('//host/path')).toBeNull();
		expect(normalizeRoute('')).toBeNull();
		expect(normalizeRoute(42)).toBeNull();
	});

	it('round-trips through the intent convention', () => {
		const route = '#/hammer@41?hide=1,2f&cut=x:12.5!';
		const uri = conventionUri(route);
		expect(uri).toBe(`${CONVENTION}?route=%2Fhammer%4041%3Fhide%3D1%2C2f%26cut%3Dx%3A12.5!`);
		// What a runtime does with the query: percent-decode into a string-only payload.
		const query = uri.slice(uri.indexOf('?') + 1);
		const payload = Object.fromEntries(new URLSearchParams(query));
		expect(payload).toEqual(toPayload(route));
		expect(routeFromPayload(payload)).toBe(route);
		expect(encode(decode(routeFromPayload(payload)!))).toBe(route);
	});

	it('accepts a payload a runtime forgot to decode', () => {
		expect(routeFromPayload({ route: '%2Fseed%404%3Fortho%3D1' })).toBe('#/seed@4?ortho=1');
	});

	it('falls back to model and version fields', () => {
		expect(routeFromPayload({ model: 'Seed', version: '4' })).toBe('#/seed@4');
		expect(routeFromPayload({ model: 'seed', version: 'four' })).toBe('#/seed');
		expect(routeFromPayload({ model: 4 })).toBeNull();
		expect(routeFromPayload({})).toBeNull();
		expect(routeFromPayload(null)).toBeNull();
		expect(routeFromPayload('#/seed')).toBeNull();
	});
});
