// Blossom names a file by its sha256 (BUD-01); a blossom: URI adds server hints (BUD-10).
import type { ModelFile } from './types';

export const HEX64 = /^[0-9a-f]{64}$/;

export const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';

/** https://<server>/<sha256>.<ext>, the BUD-01 address of a blob. */
export function blobUrl(server: string, sha256: string, ext?: string) {
	return `${server.replace(/\/+$/, '')}/${sha256}${ext ? `.${ext}` : ''}`;
}

/** blossom:<sha256>.<ext>?xs=<server>&…&sz=<bytes>, the BUD-10 form with the servers known to hold the file. */
export function blossomUri(file: ModelFile, servers: string[], author?: string) {
	const params = new URLSearchParams();
	for (const server of servers) params.append('xs', server);
	if (author) params.set('as', author);
	params.set('sz', String(file.bytes));
	const ext = extOf(file.path);
	return `blossom:${file.sha256}${ext ? `.${ext}` : ''}?${params}`;
}

export type BlossomRef = { sha256: string; ext: string; servers: string[]; author?: string; size?: number };

export function parseBlossomUri(uri: string): BlossomRef | null {
	const match = /^blossom:([0-9a-f]{64})(?:\.([a-z0-9]+))?(?:\?(.*))?$/i.exec(uri);
	if (!match) return null;
	const params = new URLSearchParams(match[3] ?? '');
	const size = Number(params.get('sz'));
	return {
		sha256: match[1].toLowerCase(),
		ext: (match[2] ?? '').toLowerCase(),
		servers: params.getAll('xs').map((s) => (/^https?:\/\//.test(s) ? s : `https://${s}`)),
		author: params.get('as') ?? undefined,
		size: Number.isInteger(size) && size > 0 ? size : undefined
	};
}
