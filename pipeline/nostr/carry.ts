// What a browser still holding the previous deploy's index.html needs: the hashed files that index.html loads,
// directly or through their imports. Only those stay in the next manifest for one more deploy, so files carried from
// older deploys drop out instead of piling up.
import { posix } from 'node:path';

// Quoted relative references, as Vite and SvelteKit write them: "./_app/immutable/…", "./X.js", `../chunks/X.js`.
const REFERENCE = /["'`](\.{1,2}\/[\w./-]+?\.(?:js|css))["'`]/g;

/**
 * The /_app/immutable/ paths reachable from /index.html among `files` (site path to sha256). `read` returns a file's
 * text by site path, or null when it cannot be had; references to files not in the list are ignored.
 */
export async function chunksNeeded(files: Map<string, string>, read: (path: string) => Promise<string | null>) {
	const needed = new Set<string>();
	const queue = ['/index.html'];
	const seen = new Set(queue);
	while (queue.length) {
		const from = queue.shift()!;
		const text = await read(from);
		if (text === null) continue;
		for (const [, reference] of text.matchAll(REFERENCE)) {
			const path = posix.normalize(posix.join(posix.dirname(from), reference));
			if (!files.has(path) || seen.has(path)) continue;
			seen.add(path);
			if (path.startsWith('/_app/immutable/')) needed.add(path);
			if (path.endsWith('.js')) queue.push(path);
		}
	}
	return needed;
}
