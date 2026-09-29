import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { authHeader, authorized, blobUrl } from './blossom.ts';
import { mergeRelayList, mergeServerList } from './lists.ts';

// Standard base64 pads only when the byte count is not a multiple of three; make sure this event needs padding.
const auth = { kind: 24242, id: 'i', pubkey: 'p', sig: 's', created_at: 1, content: 'Upload', tags: [['t', 'upload'], ['x', 'a'.repeat(64)]] } as unknown as Event;
while (Buffer.byteLength(JSON.stringify(auth)) % 3 === 0) auth.content += '.';
const padded = authHeader(auth, true);

describe('blossom auth header', () => {
	it('encodes unpadded base64url and standard padded base64 of the same event', () => {
		const unpadded = authHeader(auth, false);
		expect(unpadded.startsWith('Nostr ')).toBe(true);
		expect(unpadded).not.toMatch(/[=+/]/);
		expect(padded).toMatch(/=$/);
		for (const header of [unpadded, padded]) {
			expect(JSON.parse(Buffer.from(header.slice(6), header === padded ? 'base64' : 'base64url').toString())).toEqual(auth);
		}
	});

	it('retries with the padded header on 401', async () => {
		const seen: string[] = [];
		const response = await authorized(auth, async (header) => {
			seen.push(header);
			return new Response(null, { status: header === padded ? 200 : 401 });
		});
		expect(response.status).toBe(200);
		expect(seen).toHaveLength(2);
	});

	it('does not retry on other failures', async () => {
		const seen: string[] = [];
		const response = await authorized(auth, async (header) => {
			seen.push(header);
			return new Response(null, { status: 413 });
		});
		expect(response.status).toBe(413);
		expect(seen).toHaveLength(1);
	});

	it('addresses blobs', () => {
		expect(blobUrl('https://bls.unrug.tech/', 'f'.repeat(64), 'glb')).toBe(`https://bls.unrug.tech/${'f'.repeat(64)}.glb`);
	});
});

describe('lists', () => {
	const existing = (tags: string[][]) => ({ tags }) as unknown as Event;

	it('keeps existing relays and their markers, appends new ones', () => {
		const merge = mergeRelayList(existing([['r', 'wss://relay.damus.io/', 'read'], ['r', 'wss://nos.lol']]), ['wss://relay.damus.io', 'wss://nsite.run', { url: 'wss://archive.unrug.tech', marker: 'write' }]);
		expect(merge.tags).toEqual([['r', 'wss://relay.damus.io/', 'read'], ['r', 'wss://nos.lol'], ['r', 'wss://nsite.run'], ['r', 'wss://archive.unrug.tech', 'write']]);
		expect(merge.added).toEqual(['wss://nsite.run', 'wss://archive.unrug.tech']);
		expect(merge.dropped).toEqual([]);
	});

	it('orders servers by our preference and keeps the rest behind', () => {
		const merge = mergeServerList(existing([['server', 'https://blossom.band'], ['server', 'https://blssm.us']]), ['https://bls.unrug.tech', 'https://blssm.us']);
		expect(merge.tags.map((t) => t[1])).toEqual(['https://bls.unrug.tech', 'https://blssm.us', 'https://blossom.band']);
		expect(merge.dropped).toEqual([]);
		expect(mergeServerList(existing([['server', 'https://blossom.band']]), ['https://bls.unrug.tech'], true).dropped).toEqual(['https://blossom.band']);
	});
});
