import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { aggregate, nappletTemplate, siteTemplate, snapshotTemplate, validate, type FileEntry } from './manifest.ts';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const entries: FileEntry[] = [
	{ path: '/index.html', sha256: A, bytes: 10, type: 'text/html' },
	{ path: '/a.css', sha256: B, bytes: 5, type: 'text/css' }
];
const base = { id: 'sh-viewer', entries, servers: ['https://blossom.example.com'], title: 'T', description: 'D', created_at: 1_790_000_000 };

describe('nsite manifest', () => {
	it('aggregates sorted "<sha256> <path>" lines', () => {
		expect(aggregate(entries)).toBe('b5b0bfeec21afd5be39206e47f20e4e5177073c0e6e83c36418809110073967c');
		expect(aggregate([...entries].reverse())).toBe(aggregate(entries));
	});

	it('builds a valid site manifest', () => {
		const t = siteTemplate({ ...base, source: 'nostr://x', app: ['31990:p:d', 'wss://r'] });
		expect(t.kind).toBe(35128);
		expect(t.tags.slice(0, 4)).toEqual([['d', 'sh-viewer'], ['path', '/a.css', B], ['path', '/index.html', A], ['x', aggregate(entries), 'aggregate']]);
		expect(t.tags).toContainEqual(['server', 'https://blossom.example.com']);
		expect(t.tags).toContainEqual(['app', '31990:p:d', 'wss://r']);
		expect(validate(t)).toBe(true);
	});

	it('builds a napplet manifest with requires and archetype tags', () => {
		const t = nappletTemplate({ ...base, entries: [entries[0]], requires: ['inc', 'link'], archetypes: [{ slug: 'cad-viewer', convention: 'napplet:cad-viewer/open' }] });
		expect(t.kind).toBe(35129);
		expect(t.tags.filter((x) => x[0] === 'requires')).toEqual([['requires', 'inc'], ['requires', 'link']]);
		expect(t.tags).toContainEqual(['archetype', 'cad-viewer', 'napplet:cad-viewer/open']);
		expect(validate(t)).toBe(true);
	});

	it('rejects bad ids and paths', () => {
		expect(() => siteTemplate({ ...base, id: 'seedhammer-viewer' })).toThrow(/d tag/);
		expect(() => siteTemplate({ ...base, id: 'bad-' })).toThrow(/d tag/);
		expect(() => validate({ ...siteTemplate(base), tags: [['d', 'x'], ['path', '/CNAME', A], ['x', aggregate([{ path: '/CNAME', sha256: A }]), 'aggregate']] })).toThrow(/extension/);
		expect(() => validate({ ...siteTemplate(base), tags: [['d', 'x'], ['path', '/i.html', A], ['x', B, 'aggregate']] })).toThrow(/aggregate/);
	});

	it('derives a snapshot that points back at its source', () => {
		const source = { ...siteTemplate(base), id: 'e'.repeat(64), pubkey: 'p'.repeat(64), sig: '' } as unknown as Event;
		const snapshot = snapshotTemplate(source, 'wss://relay.example.com', 1_790_000_001);
		expect(snapshot.kind).toBe(5128);
		expect(snapshot.tags[0]).toEqual(['a', `35128:${'p'.repeat(64)}:sh-viewer`, 'wss://relay.example.com']);
		expect(snapshot.tags.filter((t) => t[0] === 'd')).toHaveLength(0);
		expect(snapshot.tags.filter((t) => t[0] === 'path')).toHaveLength(2);
		expect(validate(snapshot, { snapshot: true })).toBe(true);
		expect(() => validate(snapshot)).toThrow(/d tag/);
	});
});
