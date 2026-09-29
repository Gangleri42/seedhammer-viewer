// Models inside the sandbox. The latest version of each model ships inside the artefact, so the manifest's hash pins
// it along with everything else and no capability is needed to open the viewer. Anything else is asked from the
// shell by content hash and checked on arrival.
import type { ModelSource } from '$lib/host/host';
import { has } from '$lib/host/napplet-runtime';
import { blobUrl, blossomUri, extOf } from './blossom';
import { sha256Hex } from './sha256';
import type { ModelFile, ModelIndex } from './types';

function fromBase64(text: string): ArrayBuffer {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

async function fromShell(file: ModelFile, servers: string[], onProgress?: (fraction: number | null) => void): Promise<ArrayBuffer> {
	const resource = has('resource', 'bytes');
	if (!resource) throw new Error('this host cannot fetch files; open the web viewer for this version');
	const ext = extOf(file.path);
	// The two reference runtimes spell a Blossom request differently; plain https is the last resort.
	const attempts: { url: string; servers?: string[] }[] = [
		{ url: `blossom:sha256:${file.sha256}`, servers },
		{ url: blossomUri(file, servers) },
		...servers.map((server) => ({ url: blobUrl(server, file.sha256, ext) }))
	];
	let failure: unknown = new Error('no server holds the file');
	for (const attempt of attempts) {
		try {
			onProgress?.(null);
			const blob = await resource.bytes(attempt.url, attempt.servers ? { servers: attempt.servers } : undefined);
			const buffer = await blob.arrayBuffer();
			const hash = await sha256Hex(buffer);
			if (hash ? hash !== file.sha256 : buffer.byteLength !== file.bytes) {
				failure = new Error('the file did not match its hash');
				continue;
			}
			onProgress?.(1);
			return buffer;
		} catch (err) {
			failure = err;
		}
	}
	throw failure instanceof Error ? failure : new Error(String(failure));
}

export type NappletModelOptions = {
	index: ModelIndex;
	/** GLB bytes shipped in the artefact, base64, by sha256. */
	inline: Record<string, string>;
	/** Blossom servers that hold every published file, most reliable first. */
	servers: string[];
};

export function nappletModels({ index, inline, servers }: NappletModelOptions): ModelSource {
	const hosts = [...new Set([...(index.servers ?? []), ...servers])];
	return {
		index: async () => index,
		async glb(file, onProgress) {
			const shipped = inline[file.sha256];
			if (shipped) {
				onProgress?.(1);
				return fromBase64(shipped);
			}
			return fromShell(file, hosts, onProgress);
		}
	};
}
