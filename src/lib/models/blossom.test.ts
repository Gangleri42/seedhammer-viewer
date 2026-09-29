import { describe, expect, it } from 'vitest';
import { blobUrl, blossomUri, parseBlossomUri } from './blossom';

const sha = 'a'.repeat(64);
const file = { path: 'hammer/v41.glb', bytes: 2232812, sha256: sha };

describe('blossom', () => {
	it('addresses a blob on a server', () => {
		expect(blobUrl('https://blossom.example.com/', sha, 'glb')).toBe(`https://blossom.example.com/${sha}.glb`);
		expect(blobUrl('https://blossom.example.com', sha)).toBe(`https://blossom.example.com/${sha}`);
	});

	it('builds and parses a BUD-10 URI', () => {
		const uri = blossomUri(file, ['https://blossom.example.com', 'https://blssm.us'], 'b'.repeat(64));
		expect(uri).toBe(`blossom:${sha}.glb?xs=https%3A%2F%2Fblossom.example.com&xs=https%3A%2F%2Fblssm.us&as=${'b'.repeat(64)}&sz=2232812`);
		expect(parseBlossomUri(uri)).toEqual({ sha256: sha, ext: 'glb', servers: ['https://blossom.example.com', 'https://blssm.us'], author: 'b'.repeat(64), size: 2232812 });
	});

	it('tolerates bare hosts and missing parts', () => {
		expect(parseBlossomUri(`blossom:${sha.toUpperCase()}?xs=cdn.example`)).toEqual({ sha256: sha, ext: '', servers: ['https://cdn.example'], author: undefined, size: undefined });
		expect(parseBlossomUri(`blossom:${sha}.zip?sz=-1`)?.size).toBeUndefined();
		expect(parseBlossomUri('blossom:nope')).toBeNull();
		expect(parseBlossomUri(`https://x/${sha}`)).toBeNull();
	});
});
