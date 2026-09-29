// The built manifest must describe the built files: the hashes are what Blossom serves them under. Runs when the
// models have been built (npm run models); static/models is not committed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModelFile, ModelIndex } from './types';

const INDEX = 'static/models/index.json';
const built = existsSync(INDEX);
const index: ModelIndex = built ? JSON.parse(readFileSync(INDEX, 'utf8')) : { version: 2, models: {} };
const files = Object.values(index.models).flatMap((m) => m.versions.flatMap((v) => [v.glb, v.step, ...(v.plain ? [v.plain] : [])]));

describe.skipIf(!built)('static/models/index.json', () => {
	it('is schema v2 with every model sorted newest first', () => {
		expect(index.version).toBe(2);
		expect(Object.keys(index.models).length).toBeGreaterThan(0);
		for (const entry of Object.values(index.models)) {
			expect(entry.versions.length).toBeGreaterThan(0);
			expect(entry.latest).toBe(entry.versions[0].version);
			expect([...entry.versions].sort((a, b) => b.version - a.version)).toEqual(entry.versions);
		}
	});

	it.each(files.map((f): [string, ModelFile] => [f.path, f]))('%s matches its size and sha256', (_path, file) => {
		const data = readFileSync(`static/models/${file.path}`);
		expect(data.byteLength).toBe(file.bytes);
		expect(createHash('sha256').update(data).digest('hex')).toBe(file.sha256);
		expect(file.path).not.toMatch(/^\/|\.\./);
	});
});
