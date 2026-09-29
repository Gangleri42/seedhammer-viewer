import type { ModelSource } from '$lib/host/host';
import type { ModelIndex } from './types';

/** Reads a response body in chunks so the loading bar can follow. */
export async function readWithProgress(response: Response, expected: number, onProgress?: (fraction: number | null) => void): Promise<ArrayBuffer> {
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	const total = Number(response.headers.get('content-length')) || expected;
	if (!response.body) return response.arrayBuffer();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		onProgress?.(total ? Math.min(1, received / total) : null);
	}
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
}

/** Files served next to the page, under <base>/models/. */
export function webModels(base: string): ModelSource {
	return {
		async index() {
			const response = await fetch(`${base}/models/index.json`);
			if (!response.ok) throw new Error(`index.json: ${response.status}`);
			return (await response.json()) as ModelIndex;
		},
		async bytes(file, onProgress) {
			return readWithProgress(await fetch(`${base}/models/${file.path}`), file.bytes, onProgress);
		}
	};
}
