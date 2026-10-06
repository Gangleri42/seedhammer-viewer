// Who signs. The secret is read from the file NOSTR_SIGNER_FILE names (mode 0600, for a machine without a Keychain)
// or, on a Mac, from the Keychain item "nostr-signer" whose account is the signing npub. It is either a NIP-46
// session, saved as an nbunksec the way ngit and nsyte save one, so a remote signer such as Amber on a phone signs
// and the key stays there; or the key itself (nsec or 64 hex). There is no key in the environment and no other way
// in, so a machine without one of the two cannot sign. Whatever signs must sign as the configured identity, and a
// remote signer's answers are checked like anything else that comes over a relay.
import './ws.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { bech32 } from '@scure/base';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { BunkerSigner } from 'nostr-tools/nip46';
import * as nip19 from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';

export interface Signer {
	pubkey: string;
	npub: string;
	signEvent(template: EventTemplate): Promise<VerifiedEvent>;
	close(): Promise<void>;
}

/** The secret as saved, and where it came from, for messages. */
export type Saved = { text: string; from: string };

export const KEYCHAIN_SERVICE = 'nostr-signer';
/** How long a remote signer may take over one answer: the phone may ask for a tap first. */
const ANSWER_MS = 90_000;

/** The saved secret for this npub: the file NOSTR_SIGNER_FILE names, else its Keychain item on a Mac. */
export function savedSecret(npub: string, env: Record<string, string | undefined> = process.env): Saved {
	const file = env.NOSTR_SIGNER_FILE?.trim();
	if (file) {
		if (statSync(file).mode & 0o077) throw new Error(`${file} can be read by others; make it mode 600`);
		return { text: readFileSync(file, 'utf8').trim(), from: file };
	}
	if (process.platform === 'darwin') {
		try {
			const text = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', npub, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
			return { text: text.trim(), from: `the Keychain item "${KEYCHAIN_SERVICE}" for ${npub}` };
		} catch {
			// No such item: the message below says how to make one.
		}
	}
	throw new Error(`nothing to sign with: set NOSTR_SIGNER_FILE, or save an nbunksec or a key as the Keychain item "${KEYCHAIN_SERVICE}" for ${npub}`);
}

export type Session = { remote: string; clientSecret: Uint8Array; relays: string[]; secret: string | null };

/**
 * A NIP-46 session as ngit (src/lib/login/nbunksec.rs) and nsyte save it: bech32 with the prefix "nbunksec", holding
 * records of one type byte, one length byte and the value: 0 the remote signer's pubkey, 1 the client's secret key,
 * 2 a relay (repeated), 3 the connection secret.
 */
export function decodeNbunksec(text: string): Session {
	const { prefix, words } = bech32.decode(text as `${string}1${string}`, 1000);
	if (prefix !== 'nbunksec') throw new Error(`expected an nbunksec, got the prefix "${prefix}"`);
	const data = bech32.fromWords(words);
	let remote: Uint8Array | null = null;
	let clientSecret: Uint8Array | null = null;
	let secret: string | null = null;
	const relays: string[] = [];
	const text8 = new TextDecoder('utf-8', { fatal: true });
	for (let i = 0; i < data.length; ) {
		const [type, length] = [data[i], data[i + 1]];
		const value = data.slice(i + 2, i + 2 + length);
		if (length === undefined || value.length !== length) throw new Error('the nbunksec is cut short');
		i += 2 + length;
		if (type === 0) remote = value;
		else if (type === 1) clientSecret = value;
		else if (type === 2) relays.push(text8.decode(value));
		else if (type === 3) secret = text8.decode(value);
	}
	if (remote?.length !== 32 || clientSecret?.length !== 32 || !relays.length) throw new Error('the nbunksec lacks the signer, the client key or a relay');
	return { remote: toHex(remote), clientSecret, relays, secret };
}

/** The signer for the configured identity, from what was saved for it. */
export async function openSigner(expectedPubkey: string, saved: Saved = savedSecret(nip19.npubEncode(expectedPubkey))): Promise<Signer> {
	if (saved.text.startsWith('nbunksec1')) return remoteSigner(decodeNbunksec(saved.text), expectedPubkey, saved.from);
	return localSigner(saved, expectedPubkey);
}

function localSigner({ text, from }: Saved, expectedPubkey: string): Signer {
	const secret = text.startsWith('nsec1') ? nip19.decode(text as `nsec1${string}`).data : hexToBytes(text);
	const pubkey = getPublicKey(secret);
	if (pubkey !== expectedPubkey) throw new Error(`${from} signs as ${nip19.npubEncode(pubkey)}, the site is published by ${nip19.npubEncode(expectedPubkey)}`);
	return { pubkey, npub: nip19.npubEncode(pubkey), signEvent: async (t) => finalizeEvent(t, secret), close: async () => undefined };
}

async function remoteSigner(session: Session, expectedPubkey: string, from: string): Promise<Signer> {
	const bunker = BunkerSigner.fromBunker(session.clientSecret, { pubkey: session.remote, relays: session.relays, secret: session.secret });
	const answer = <T>(what: string, promise: Promise<T>) =>
		withTimeout(promise, ANSWER_MS, `the remote signer did not answer ${what} within ${ANSWER_MS / 1000} s: is the phone online and Amber connected?`);
	try {
		const pubkey = await answer('who it signs as', bunker.getPublicKey());
		if (pubkey !== expectedPubkey) throw new Error(`${from} signs as ${nip19.npubEncode(pubkey)}, the site is published by ${nip19.npubEncode(expectedPubkey)}`);
		return {
			pubkey,
			npub: nip19.npubEncode(pubkey),
			async signEvent(template) {
				const event = await answer(`for a kind ${template.kind} event`, bunker.signEvent(template));
				const asked = event.pubkey === pubkey && event.kind === template.kind && event.created_at === template.created_at && event.content === template.content;
				if (!asked || JSON.stringify(event.tags) !== JSON.stringify(template.tags) || !verifyEvent(event)) {
					throw new Error(`the remote signer returned another event than the kind ${template.kind} event asked for, or a bad signature`);
				}
				return event;
			},
			close: () => bunker.close()
		};
	} catch (err) {
		await bunker.close().catch(() => undefined);
		throw err;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function hexToBytes(hex: string) {
	if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('the saved secret is neither an nbunksec, an nsec nor 64 hex characters');
	return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}
