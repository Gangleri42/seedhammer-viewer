// Who signs: the forge, with the key file named by NOSTR_NSEC_FILE. Nothing else holds the key, so there is no
// other way in: no key in the environment, no bunker session on a laptop.
import { readFileSync } from 'node:fs';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import * as nip19 from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

export interface Signer {
	pubkey: string;
	npub: string;
	signEvent(template: EventTemplate): Promise<VerifiedEvent>;
	close(): Promise<void>;
}

/** Reads the key file (nsec1… or 64 hex) and refuses a key other than the configured identity's. */
export function openSigner(expectedPubkey: string, file = process.env.NOSTR_NSEC_FILE?.trim()): Signer {
	if (!file) throw new Error('NOSTR_NSEC_FILE is not set; only the forge signs');
	const text = readFileSync(file, 'utf8').trim();
	const secret = text.startsWith('nsec1') ? (nip19.decode(text as `nsec1${string}`).data as Uint8Array) : hexToBytes(text);
	const pubkey = getPublicKey(secret);
	if (pubkey !== expectedPubkey) throw new Error(`the key file signs as ${nip19.npubEncode(pubkey)}, the site is published by ${nip19.npubEncode(expectedPubkey)}`);
	return { pubkey, npub: nip19.npubEncode(pubkey), signEvent: async (t) => finalizeEvent(t, secret), close: async () => undefined };
}

export function hexToBytes(hex: string) {
	if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('the key file holds neither an nsec nor 64 hex characters');
	return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}
