import { describe, expect, it } from 'vitest';
import * as nip19 from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { parseBlossomUri } from '../../src/lib/models/blossom.ts';
import { nappletTemplate, siteTemplate, snapshotTemplate, type FileEntry } from './manifest.ts';
import { overview } from './overview.ts';

const secret = generateSecretKey();
const author = getPublicKey(secret);
const servers = ['https://one.example.com', 'https://two.example.com'];
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const site: FileEntry[] = [
	{ path: '/models/index.json', sha256: B, bytes: 46_000, type: 'application/json' },
	{ path: '/index.html', sha256: A, bytes: 7_000, type: 'text/html' }
];
const carried: FileEntry[] = [{ path: '/_app/immutable/old.js', sha256: D, bytes: 0, type: 'text/javascript' }];
const napplet: FileEntry[] = [{ path: '/index.html', sha256: C, bytes: 9_000_000, type: 'text/html' }];
const base = { id: 'sh-viewer', servers, title: 'T', description: 'D', created_at: 1_790_000_000 };
const siteEvent = finalizeEvent(siteTemplate({ ...base, entries: [...site, ...carried] }), secret);
const siteSnapshot = finalizeEvent(snapshotTemplate(siteEvent, 'wss://relay.example.com', 1_790_000_001), secret);
const nappletEvent = finalizeEvent(nappletTemplate({ ...base, entries: napplet, requires: [], archetypes: [] }), secret);

const make = (withNapplet: boolean) =>
	overview({
		author, id: 'sh-viewer', relay: 'wss://relay.example.com', gateway: 'nsite.lol', servers, viewer: '51ef76a',
		site: { event: siteEvent, relays: ['wss://relay.example.com'], snapshot: siteSnapshot, snapshotRelays: ['wss://relay.example.com'] },
		napplet: withNapplet ? { event: nappletEvent, relays: ['wss://relay.example.com'], snapshot: null, snapshotRelays: [] } : null,
		files: { site, napplet: withNapplet ? napplet : [], carried },
		downloaded: new Set([B])
	});

describe('publish overview', () => {
	it('names each file by its Blossom address and the manifest that publishes it', () => {
		const o = make(true);
		expect(o.published).toBe('2026-09-21T14:13:20Z');
		expect(o.files.map((f) => f.path)).toEqual(['/index.html', '/models/index.json', '/index.html']);
		const index = o.files[1];
		expect(parseBlossomUri(index.blossom)).toEqual({ sha256: B, ext: 'json', servers, author, size: 46_000 });
		expect(nip19.decode(index.manifest)).toMatchObject({ type: 'nevent', data: { id: siteEvent.id, kind: 35128, author } });
		expect(nip19.decode(index.snapshot!)).toMatchObject({ type: 'nevent', data: { id: siteSnapshot.id, kind: 5128 } });
		expect(o.files.map((f) => f.verified)).toEqual(['before', 'now', 'before']);
		// The napplet's file points at the napplet manifest, which has no snapshot here.
		expect(nip19.decode(o.files[2].manifest)).toMatchObject({ data: { id: nappletEvent.id, kind: 35129 } });
		expect(o.files[2].snapshot).toBeNull();
	});

	it('lists the events with their addresses, and old chunks by hash only', () => {
		const o = make(true);
		expect(nip19.decode(o.site.manifest.naddr)).toMatchObject({ type: 'naddr', data: { kind: 35128, pubkey: author, identifier: 'sh-viewer' } });
		expect(o.site.url).toMatch(/^https:\/\/[0-9a-z]{50}sh-viewer\.nsite\.lol\/$/);
		expect(o.site.snapshotUrl).toMatch(/^https:\/\/[0-9a-z]+\.nsite\.lol\/$/);
		expect(o.napplet?.manifest.kind).toBe(35129);
		expect(o.carried).toEqual([{ path: '/_app/immutable/old.js', sha256: D, manifest: o.files[0].manifest }]);
		expect(make(false).napplet).toBeNull();
		expect(make(false).files).toHaveLength(2);
	});
});
