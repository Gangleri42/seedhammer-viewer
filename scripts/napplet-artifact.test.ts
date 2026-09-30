// The napplet artefact must be one self-contained file: a shell injects it as srcdoc into an opaque-origin frame,
// where nothing can be loaded by URL and no ambient network or storage exists. Runs against dist-napplet when built.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModelIndex } from '../src/lib/models/types.ts';
import { ARCHETYPE, CONVENTION } from '../src/lib/state/archetype.ts';

const dir = 'dist-napplet';
const built = existsSync(`${dir}/index.html`);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

describe.skipIf(!built)('napplet artefact', () => {
	const html = built ? readFileSync(`${dir}/index.html`) : Buffer.alloc(0);
	const text = html.toString('utf8');
	const manifest = built ? JSON.parse(readFileSync(`${dir}/.nip5a-manifest.json`, 'utf8')) : { tags: [] };
	const tags = (name: string) => (manifest.tags as string[][]).filter((t) => t[0] === name);

	it('is a single file', () => {
		expect(readdirSync(dir).sort()).toEqual(['.nip5a-manifest.json', 'index.html']);
		// The latest GLB of each model rides inside; a shell loads it as one srcdoc string.
		expect(html.byteLength).toBeLessThan(12_000_000);
	});

	it('carries the latest model of each kind and its measurement file, except models kept out of the napplet', () => {
		const index: ModelIndex = JSON.parse(readFileSync('static/models/index.json', 'utf8'));
		const configs: Record<string, { napplet?: boolean }> = JSON.parse(readFileSync('pipeline/models.json', 'utf8'));
		for (const [key, entry] of Object.entries(index.models)) {
			const latest = entry.versions.find((v) => v.version === entry.latest)!;
			for (const file of [latest.glb, latest.measure]) {
				if (!file) continue;
				if (configs[key]?.napplet === false) expect(text).not.toContain(file.sha256);
				else expect(text).toContain(file.sha256);
			}
		}
	});

	// The markup alone: script and style bodies are dropped, their opening tags kept.
	const markup = text
		.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>')
		.replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>');

	it('references nothing by URL', () => {
		expect(markup).not.toMatch(/<script[^>]*\ssrc=/i);
		expect(markup).not.toMatch(/<link[^>]*rel=["'](stylesheet|modulepreload)/i);
		expect(markup).not.toMatch(/(src|href)=["']https?:/i);
		expect(markup).not.toMatch(/<base\b/i);
	});

	it('touches no ambient capability', () => {
		expect(text).not.toMatch(/\bimport\s*\(/);
		expect(text).not.toMatch(/\bfetch\s*\(/);
		expect(text).not.toMatch(/XMLHttpRequest\(|WebSocket\(/);
		expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
		expect(text).not.toMatch(/window\s*\.\s*nostr/);
	});

	it('declares itself as the manifest says', () => {
		expect(manifest.kind).toBe(35129);
		expect(tags('d')).toEqual([['d', 'sh-viewer']]);
		expect(tags('requires').map((t) => t[1]).sort()).toEqual(['inc', 'link', 'resource', 'theme']);
		expect(tags('archetype')).toEqual([['archetype', ARCHETYPE, CONVENTION]]);
	});

	it('is what the manifest hashes', () => {
		const paths = tags('path');
		expect(paths).toEqual([['path', '/index.html', sha256(html)]]);
		const aggregate = sha256(paths.map((t) => `${t[2]} ${t[1]}\n`).sort().join(''));
		expect(tags('x')).toEqual([['x', aggregate, 'aggregate']]);
	});
});
