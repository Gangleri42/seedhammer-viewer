import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ModelIndex } from '../src/lib/models/types.ts';
import { fileEntry, serialize, sha256 } from './manifest.ts';

describe('model manifest', () => {
	it('hashes with sha256', () => {
		expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('describes a file by path, size and hash', () => {
		const dir = mkdtempSync(`${tmpdir()}/manifest-`);
		writeFileSync(`${dir}/02a4106.glb`, 'abc');
		expect(fileEntry('02a4106.glb', dir)).toEqual({ path: '02a4106.glb', bytes: 3, sha256: sha256('abc') });
	});

	it('serializes models in the configured order and drops unknown keys', () => {
		const version = { id: '02a4106', date: '2026-10-14', glb: { path: 'g', bytes: 1, sha256: 'a' }, step: { path: 's', bytes: 1, sha256: 'b' }, triangles: 0, bodies: 0 };
		const index: ModelIndex = { version: 4, models: {} };
		for (const key of ['b', 'a', 'x']) index.models[key] = { title: key, latest: '02a4106', versions: [version] };
		const out = JSON.parse(serialize(index, ['a', 'b']));
		expect(Object.keys(out.models)).toEqual(['a', 'b']);
		expect(out.version).toBe(4);
		expect(out.servers).toBeUndefined();
	});
});
