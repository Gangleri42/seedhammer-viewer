import { describe, expect, it } from 'vitest';
import { chunksNeeded } from './carry.ts';

// A previous deploy's manifest: its own build plus files carried from the deploy before it.
const texts: Record<string, string | null> = {
	'/index.html': '<link rel="modulepreload" href="./_app/immutable/entry/app.A.js"><link href="./_app/immutable/assets/0.A.css" rel="stylesheet">',
	'/_app/immutable/entry/app.A.js': 'import{a}from"../chunks/c1.js";const n=[()=>import("../nodes/2.A.js")];x(`../chunks/c2.js`,"../chunks/missing.js")',
	'/_app/immutable/nodes/2.A.js': 'const s=()=>import("../chunks/big.js")',
	'/_app/immutable/chunks/big.js': 'import"./c1.js"',
	'/_app/immutable/chunks/c1.js': 'import"./big.js"',
	'/_app/immutable/chunks/c2.js': '',
	'/_app/immutable/assets/0.A.css': 'body{}',
	'/_app/immutable/entry/app.OLD.js': 'import"../chunks/old.js"',
	'/_app/immutable/chunks/old.js': '',
	'/models/index.json': '{}'
};
const files = new Map(Object.keys(texts).map((path) => [path, 'sha']));
const read = async (path: string) => texts[path] ?? null;

describe('carried chunks', () => {
	it('keeps what the previous index.html loads and drops what older deploys left', async () => {
		expect([...(await chunksNeeded(files, read))].sort()).toEqual([
			'/_app/immutable/assets/0.A.css',
			'/_app/immutable/chunks/big.js',
			'/_app/immutable/chunks/c1.js',
			'/_app/immutable/chunks/c2.js',
			'/_app/immutable/entry/app.A.js',
			'/_app/immutable/nodes/2.A.js'
		]);
	});

	it('keeps what it can reach when a file cannot be read, and nothing without the index', async () => {
		const partial = async (path: string) => (path === '/_app/immutable/entry/app.A.js' ? null : read(path));
		expect([...(await chunksNeeded(files, partial))].sort()).toEqual(['/_app/immutable/assets/0.A.css', '/_app/immutable/entry/app.A.js']);
		expect((await chunksNeeded(files, async () => null)).size).toBe(0);
	});
});
