// What the publisher needs to know about the site: .nsite/config.json is the single source of relay and server lists,
// shared with the napplet build (vite.napplet.config.ts) and readable by ngit's nsite publisher as a fallback.
import { readFileSync } from 'node:fs';

export type SiteConfig = {
	/** The NIP-5A site id (d tag), 1 to 13 of [a-z0-9-]. The napplet uses the same id. */
	id: string;
	title: string;
	description: string;
	source?: string;
	/** Hex pubkey of the identity that signs everything. */
	pubkey: string;
	/** Relays the manifests go to; the first is the one we run. */
	relays: string[];
	/**
	 * Read-only relays that hold our events permanently (fed by a harvest job, not by publishing). Listed in the
	 * relay list as outboxes so gateways and clients keep finding the manifests after the edge relays prune them.
	 */
	archiveRelays?: string[];
	/** Blossom servers, most reliable first; the first is the one we run and must hold every file. */
	servers: string[];
	gatewayHostnames?: string[];
};

export const CONFIG_PATH = '.nsite/config.json';

/** Where nsite gateways look up an author's relay and server lists (nsite-gateway LOOKUP_RELAYS defaults). */
export const LOOKUP_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es'];

export const KIND = {
	site: 35128,
	siteSnapshot: 5128,
	napplet: 35129,
	nappletSnapshot: 5129,
	relayList: 10002,
	serverList: 10063,
	blobAuth: 24242
} as const;

const MIME: Record<string, string> = {
	html: 'text/html',
	js: 'text/javascript',
	mjs: 'text/javascript',
	css: 'text/css',
	json: 'application/json',
	map: 'application/json',
	webmanifest: 'application/manifest+json',
	txt: 'text/plain',
	xml: 'application/xml',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	webp: 'image/webp',
	ico: 'image/x-icon',
	woff2: 'font/woff2',
	wasm: 'application/wasm',
	glb: 'model/gltf-binary',
	gltf: 'model/gltf+json',
	step: 'model/step',
	zip: 'application/zip'
};

export const mimeOf = (path: string) => MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export function readConfig(path = CONFIG_PATH): SiteConfig {
	const config: SiteConfig = JSON.parse(readFileSync(path, 'utf8'));
	const problems: string[] = [];
	if (!/^[a-z0-9-]{1,13}$/.test(config.id) || config.id.endsWith('-')) problems.push(`id "${config.id}" must be 1-13 of [a-z0-9-] and not end in "-"`);
	if (!/^[0-9a-f]{64}$/.test(config.pubkey ?? '')) problems.push('pubkey must be 64 hex characters');
	if (!config.relays?.length || config.relays.some((r) => !/^wss?:\/\//.test(r))) problems.push('relays must be a non-empty list of ws(s):// URLs');
	config.archiveRelays ??= [];
	if (config.archiveRelays.some((r) => !/^wss?:\/\//.test(r))) problems.push('archiveRelays must be ws(s):// URLs');
	if (!config.servers?.length || config.servers.some((s) => !/^https?:\/\//.test(s))) problems.push('servers must be a non-empty list of http(s):// URLs');
	if (!config.title) problems.push('title is required');
	if (problems.length) throw new Error(`${path}: ${problems.join('; ')}`);
	config.servers = config.servers.map((s) => s.replace(/\/+$/, ''));
	return config;
}
