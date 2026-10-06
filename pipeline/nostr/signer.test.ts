import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decodeNbunksec, openSigner, savedSecret } from './signer.ts';

const secretFile = (content: string, mode = 0o600) => {
	const file = `${mkdtempSync(`${tmpdir()}/signer-`)}/secret`;
	writeFileSync(file, content);
	chmodSync(file, mode);
	return file;
};

const utf8 = (text: string) => new TextEncoder().encode(text);
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
/** A session saved the way ngit writes one: records of type, length and value. */
const nbunksec = (records: [number, Uint8Array][]) =>
	bech32.encode('nbunksec', bech32.toWords(Uint8Array.from(records.flatMap(([type, value]) => [type, value.length, ...value]))), 1000);

describe('signer', () => {
	const secret = generateSecretKey();
	const pubkey = getPublicKey(secret);

	it('signs with an nsec or a hex key', async () => {
		for (const text of [nip19.nsecEncode(secret), Buffer.from(secret).toString('hex')]) {
			const signer = await openSigner(pubkey, { text, from: 'the test' });
			const event = await signer.signEvent({ kind: 1, created_at: 1, tags: [], content: '' });
			expect(event.pubkey).toBe(pubkey);
			expect(verifyEvent(event)).toBe(true);
		}
	});

	it('refuses another identity and garbage', async () => {
		await expect(openSigner(getPublicKey(generateSecretKey()), { text: nip19.nsecEncode(secret), from: 'the test' })).rejects.toThrow(/signs as/);
		await expect(openSigner(pubkey, { text: 'not a key', from: 'the test' })).rejects.toThrow(/neither/);
	});

	it('reads the secret from the file NOSTR_SIGNER_FILE names, and only from a private one', () => {
		const npub = nip19.npubEncode(pubkey);
		expect(savedSecret(npub, { NOSTR_SIGNER_FILE: secretFile('the secret\n') }).text).toBe('the secret');
		expect(() => savedSecret(npub, { NOSTR_SIGNER_FILE: secretFile('the secret', 0o644) })).toThrow(/mode 600/);
	});

	it('says how to provide a signer when there is none', () => {
		// A fresh identity has no Keychain item either, so this holds on a Mac too.
		expect(() => savedSecret(nip19.npubEncode(getPublicKey(generateSecretKey())), {})).toThrow(/NOSTR_SIGNER_FILE/);
	});

	it('decodes a NIP-46 session saved as an nbunksec', () => {
		const remote = getPublicKey(generateSecretKey());
		const client = generateSecretKey();
		const saved = nbunksec([[0, fromHex(remote)], [1, client], [2, utf8('wss://one.example.com')], [2, utf8('wss://two.example.com')], [3, utf8('connection secret')]]);
		expect(decodeNbunksec(saved)).toEqual({ remote, clientSecret: client, relays: ['wss://one.example.com', 'wss://two.example.com'], secret: 'connection secret' });
		// Unknown records are skipped, and the connection secret may be missing.
		expect(decodeNbunksec(nbunksec([[9, utf8('later')], [0, fromHex(remote)], [1, client], [2, utf8('wss://one.example.com')]])).secret).toBeNull();
	});

	it('refuses a session without its signer, client key or relay, one cut short, and other bech32', () => {
		const remote = fromHex(getPublicKey(generateSecretKey()));
		const client = generateSecretKey();
		expect(() => decodeNbunksec(nbunksec([[1, client], [2, utf8('wss://one.example.com')]]))).toThrow(/lacks/);
		expect(() => decodeNbunksec(nbunksec([[0, remote], [2, utf8('wss://one.example.com')]]))).toThrow(/lacks/);
		expect(() => decodeNbunksec(nbunksec([[0, remote], [1, client]]))).toThrow(/lacks/);
		const cut = Uint8Array.from([0, 32, ...remote.slice(0, 10)]);
		expect(() => decodeNbunksec(bech32.encode('nbunksec', bech32.toWords(cut), 1000))).toThrow(/cut short/);
		expect(() => decodeNbunksec(nip19.npubEncode(getPublicKey(client)))).toThrow(/prefix/);
	});
});
