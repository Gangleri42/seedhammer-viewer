import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { openSigner } from './signer.ts';

const keyFile = (content: string) => {
	const file = `${mkdtempSync(`${tmpdir()}/signer-`)}/key`;
	writeFileSync(file, content, { mode: 0o600 });
	return file;
};

describe('signer', () => {
	const secret = generateSecretKey();
	const pubkey = getPublicKey(secret);

	it('signs with an nsec or hex key file', async () => {
		for (const content of [nip19.nsecEncode(secret), Buffer.from(secret).toString('hex')]) {
			const signer = openSigner(pubkey, keyFile(`${content}\n`));
			const event = await signer.signEvent({ kind: 1, created_at: 1, tags: [], content: '' });
			expect(event.pubkey).toBe(pubkey);
			expect(verifyEvent(event)).toBe(true);
		}
	});

	it('refuses another identity, a missing file setting and garbage', () => {
		expect(() => openSigner(getPublicKey(generateSecretKey()), keyFile(nip19.nsecEncode(secret)))).toThrow(/signs as/);
		expect(() => openSigner(pubkey, '')).toThrow(/NOSTR_NSEC_FILE/);
		expect(() => openSigner(pubkey, keyFile('not a key'))).toThrow(/neither/);
	});
});
