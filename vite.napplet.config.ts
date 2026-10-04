// The napplet artefact (NIP-5D): a plain Vite build of the same components, everything inlined into one index.html.
// Not SvelteKit: its bootstrap reads location, which a srcdoc sandbox cannot resolve, and it loads chunks by URL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nip5aManifest } from '@napplet/vite-plugin';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';
import { siteOrigin } from './pipeline/nostr/nsite.ts';
import { openingFiles } from './src/lib/models/boards.ts';
import type { ModelIndex } from './src/lib/models/types.ts';
import { ARCHETYPE, CONVENTION } from './src/lib/state/archetype.ts';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const NAPPLET_TYPE = 'sh-viewer';
export const REQUIRES = ['inc', 'resource', 'theme', 'link'];

type SiteConfig = { id: string; pubkey?: string; servers: string[]; gatewayHostnames?: string[] };
const site: SiteConfig = JSON.parse(readFileSync(at('./.nsite/config.json'), 'utf8'));

/** Build-time data: the manifest, the files each model opens with, and where the site lives. */
function models(): Plugin {
	const id = 'virtual:seedhammer-models';
	const resolved = `\0${id}`;
	return {
		name: 'seedhammer-models',
		resolveId: (source) => (source === id ? resolved : null),
		load(source) {
			if (source !== resolved) return null;
			const all: ModelIndex = JSON.parse(readFileSync(at('./static/models/index.json'), 'utf8'));
			// Models marked "napplet": false in pipeline/models.json stay out: the file would outgrow its size limit.
			const configs: Record<string, { napplet?: boolean }> = JSON.parse(readFileSync(at('./pipeline/models.json'), 'utf8'));
			const carried = Object.entries(all.models).filter(([key]) => configs[key]?.napplet !== false);
			const index: ModelIndex = { ...all, models: Object.fromEntries(carried) };
			const inline: Record<string, string> = {};
			for (const entry of Object.values(index.models)) {
				// What each model opens with rides inside: a shell may have no other way to fetch it.
				for (const file of openingFiles(entry)) inline[file.sha256] = readFileSync(at(`./static/models/${file.path}`)).toString('base64');
			}
			const shareOrigin = process.env.VITE_SHARE_ORIGIN ?? 'https://viewer.seedhammer.space';
			const gateway = site.gatewayHostnames?.[0];
			const nsiteOrigin = site.pubkey && gateway ? siteOrigin(site.pubkey, site.id, gateway) : null;
			return [
				`export const index = ${JSON.stringify(index)};`,
				`export const inline = ${JSON.stringify(inline)};`,
				`export const servers = ${JSON.stringify(site.servers)};`,
				`export const shareOrigin = ${JSON.stringify(shareOrigin)};`,
				`export const nsiteOrigin = ${JSON.stringify(nsiteOrigin)};`
			].join('\n');
		}
	};
}

/** three.js loaders call fetch(); in the sandbox bytes arrive through the shell, so the network paths are cut out. */
function threeNoNetwork(): Plugin {
	const stubs: Record<string, string> = {
		'/three/src/loaders/FileLoader.js': `import { Loader } from './Loader.js';
			export class FileLoader extends Loader {
				setResponseType() { return this; }
				setMimeType() { return this; }
				load() { throw new Error('FileLoader is disabled in the napplet build'); }
			}`,
		'/three/src/loaders/ImageBitmapLoader.js': `import { Loader } from './Loader.js';
			export class ImageBitmapLoader extends Loader {
				constructor(manager) { super(manager); this.isImageBitmapLoader = true; this.options = { premultiplyAlpha: 'none' }; }
				setOptions(options) { this.options = options; return this; }
				load() { throw new Error('ImageBitmapLoader is disabled in the napplet build'); }
			}`
	};
	return {
		name: 'three-no-network',
		enforce: 'pre',
		load(id) {
			const hit = Object.keys(stubs).find((suffix) => id.endsWith(suffix));
			return hit ? stubs[hit] : null;
		}
	};
}

export default defineConfig({
	root: at('./src/napplet'),
	base: './',
	publicDir: false,
	resolve: {
		alias: [
			{ find: '$lib', replacement: at('./src/lib') },
			// The source entry, so the loader stubs above reach every internal import; three/examples/* stays as is.
			{ find: /^three$/, replacement: 'three/src/Three.js' }
		]
	},
	plugins: [
		models(),
		threeNoNetwork(),
		svelte({ configFile: false, preprocess: vitePreprocess(), compilerOptions: { runes: true } }),
		nip5aManifest({
			nappletType: NAPPLET_TYPE,
			title: 'SeedHammer 3D viewer',
			description: '3D viewer for the Seed controller and the Hammer and II engraving machines',
			requires: REQUIRES,
			archetypes: [{ slug: ARCHETYPE, convention: CONVENTION }],
			artifactMode: 'single-file'
		})
	],
	build: {
		outDir: at('./dist-napplet'),
		emptyOutDir: true,
		modulePreload: { polyfill: false },
		sourcemap: false,
		target: 'es2022',
		// One chunk carries the latest models and their measurement files; napplet-artifact.test.ts holds the real limit.
		chunkSizeWarningLimit: 11000
	},
	// Paja loads the dev server into an opaque-origin frame, which sends "Origin: null".
	server: { cors: { origin: '*' } },
	preview: { cors: { origin: '*' } }
});
