// Blossom: files by sha256 (BUD-01), uploads (BUD-02), preflight (BUD-06), mirroring (BUD-04), all authorised with a
// signed kind 24242 event (BUD-11). Servers disagree on the header's base64 flavour (hzrd149/blossom#113), so every
// authorised call is tried unpadded first and padded on a 400 or 401.
import { createHash } from 'node:crypto';
import type { Event } from 'nostr-tools/core';
import type { FileEntry } from './manifest.ts';

export type Result = { ok: boolean; status: number; reason: string };

const TIMEOUT = 60_000;

export const blobUrl = (server: string, sha256: string, ext?: string) => `${server.replace(/\/+$/, '')}/${sha256}${ext ? `.${ext}` : ''}`;
export const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';

export function authHeader(event: Event, padded: boolean) {
	return `Nostr ${Buffer.from(JSON.stringify(event)).toString(padded ? 'base64' : 'base64url')}`;
}

/** Runs an authorised request; a 400 or 401 on the unpadded header gets one retry with the padded one. */
export async function authorized(auth: Event, send: (header: string) => Promise<Response>): Promise<Response> {
	const first = await send(authHeader(auth, false));
	if (first.status !== 400 && first.status !== 401) return first;
	const second = await send(authHeader(auth, true));
	return second.ok || second.status !== first.status ? second : first;
}

async function reason(response: Response) {
	const header = response.headers.get('x-reason');
	if (header) return header;
	try {
		return (await response.text()).slice(0, 200).trim() || response.statusText;
	} catch {
		return response.statusText;
	}
}

const result = async (response: Response): Promise<Result> => ({ ok: response.ok, status: response.status, reason: response.ok ? 'ok' : await reason(response) });

const describe = (err: unknown) => {
	const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
	return `${err instanceof Error ? err.message : String(err)}${cause?.code || cause?.message ? ` (${cause.code ?? cause.message})` : ''}`;
};

/** One retry after a pause for connection-level failures; public servers drop the odd request under a burst. */
async function attempt(send: () => Promise<Response>): Promise<Response> {
	try {
		return await send();
	} catch (err) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		try {
			return await send();
		} catch {
			throw err;
		}
	}
}

export async function head(server: string, sha256: string): Promise<{ status: number; size: number | null; type: string | null }> {
	try {
		const response = await attempt(() => fetch(blobUrl(server, sha256), { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' }));
		const length = response.headers.get('content-length');
		return { status: response.status, size: length ? Number(length) : null, type: response.headers.get('content-type') };
	} catch {
		return { status: 0, size: null, type: null };
	}
}

/** BUD-06: would the server take this file? A server without the endpoint (404, 405, 501) leaves that to the upload. */
export async function preflight(server: string, entry: FileEntry, auth: Event): Promise<Result> {
	try {
		const response = await authorized(auth, (authorization) =>
			attempt(() =>
				fetch(`${server}/upload`, {
					method: 'HEAD',
					headers: { Authorization: authorization, 'X-SHA-256': entry.sha256, 'X-Content-Length': String(entry.bytes), 'X-Content-Type': entry.type },
					signal: AbortSignal.timeout(TIMEOUT)
				})
			)
		);
		if ([404, 405, 501].includes(response.status)) return { ok: true, status: response.status, reason: 'no preflight endpoint' };
		return result(response);
	} catch (err) {
		return { ok: false, status: 0, reason: describe(err) };
	}
}

export async function upload(server: string, entry: FileEntry, bytes: Uint8Array, auth: Event): Promise<Result> {
	try {
		const response = await authorized(auth, (authorization) =>
			attempt(() =>
				fetch(`${server}/upload`, {
					method: 'PUT',
					headers: { Authorization: authorization, 'Content-Type': entry.type, 'Content-Length': String(entry.bytes), 'X-SHA-256': entry.sha256 },
					body: bytes as BodyInit,
					signal: AbortSignal.timeout(TIMEOUT * 5)
				})
			)
		);
		return result(response);
	} catch (err) {
		return { ok: false, status: 0, reason: describe(err) };
	}
}

/** BUD-04: the server fetches the file from another server; the auth's x tag names the hash it must get. */
export async function mirror(server: string, sourceUrl: string, auth: Event): Promise<Result> {
	try {
		const response = await authorized(auth, (authorization) =>
			attempt(() =>
				fetch(`${server}/mirror`, {
					method: 'PUT',
					headers: { Authorization: authorization, 'Content-Type': 'application/json' },
					body: JSON.stringify({ url: sourceUrl }),
					signal: AbortSignal.timeout(TIMEOUT * 5)
				})
			)
		);
		return result(response);
	} catch (err) {
		return { ok: false, status: 0, reason: describe(err) };
	}
}

/** Downloads the file and checks its hash: what a gateway or shell will do. */
export async function verify(server: string, entry: FileEntry): Promise<Result> {
	try {
		const response = await attempt(() => fetch(blobUrl(server, entry.sha256, extOf(entry.path)), { signal: AbortSignal.timeout(TIMEOUT * 5), redirect: 'follow' }));
		if (!response.ok) return result(response);
		const data = new Uint8Array(await response.arrayBuffer());
		if (entry.bytes > 0 && data.byteLength !== entry.bytes) return { ok: false, status: response.status, reason: `${data.byteLength} bytes, expected ${entry.bytes}` };
		const hash = createHash('sha256').update(data).digest('hex');
		if (hash !== entry.sha256) return { ok: false, status: response.status, reason: `sha256 ${hash.slice(0, 12)}… does not match` };
		return { ok: true, status: response.status, reason: 'ok' };
	} catch (err) {
		return { ok: false, status: 0, reason: describe(err) };
	}
}
