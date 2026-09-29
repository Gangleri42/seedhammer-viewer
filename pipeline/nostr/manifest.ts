// NIP-5A manifests: one event lists every file of the site by absolute path and sha256, plus the aggregate hash over
// those pairs. Napplets (NIP-5D) reuse the schema with their own kinds and two more tags. Snapshots copy a manifest
// under an unchangeable kind and point back at it.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import type { Event, EventTemplate } from 'nostr-tools/core';
import { KIND, mimeOf } from './config.ts';

/** A file of the site. `file` is the local copy; a carried-over file has none, and its size may be unknown (0). */
export type FileEntry = { path: string; sha256: string; bytes: number; type: string; file?: string };

export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

const SITE_ID = /^[a-z0-9-]{1,13}$/;
const hasExtension = (path: string) => /^[^.].*\.[A-Za-z0-9]+$/.test(posix.basename(path));

/** Every file below `root` as an absolute site path. Files without an extension are not allowed by NIP-5A. */
export function collectFiles(root: string, exclude: string[] = []): FileEntry[] {
	const entries: FileEntry[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			const file = `${dir}/${name}`;
			const path = `${prefix}/${name}`;
			if (statSync(file).isDirectory()) walk(file, path);
			else if (!exclude.includes(path)) entries.push({ path, file, ...hashFile(file), type: mimeOf(path) });
		}
	};
	walk(root, '');
	const bare = entries.filter((e) => !hasExtension(e.path)).map((e) => e.path);
	if (bare.length) throw new Error(`NIP-5A paths need a filename extension; exclude or rename: ${bare.join(', ')}`);
	return entries;
}

export function hashFile(file: string) {
	const data = readFileSync(file);
	return { sha256: sha256(data), bytes: data.byteLength };
}

/** sha256 over the sorted lines "<sha256> <path>\n" (NIP-5A). */
export function aggregate(entries: { path: string; sha256: string }[]) {
	return sha256(
		entries
			.map((e) => `${e.sha256} ${e.path}\n`)
			.sort()
			.join('')
	);
}

export const pathTags = (entries: FileEntry[]) => [...entries].sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => ['path', e.path, e.sha256]);

export type ManifestOptions = {
	id: string;
	entries: FileEntry[];
	servers: string[];
	title: string;
	description: string;
	source?: string;
	/** ["app", "<kind>:<pubkey>:<d>", "<relay>"]: the NIP-89 handler that opens this site's things. */
	app?: [address: string, relay: string];
	created_at?: number;
};

export function siteTemplate(o: ManifestOptions): EventTemplate {
	return template(KIND.site, o, []);
}

export type NappletOptions = ManifestOptions & { requires: string[]; archetypes: { slug: string; convention: string }[] };

export function nappletTemplate(o: NappletOptions): EventTemplate {
	const extra = [...o.requires.map((r) => ['requires', r]), ...o.archetypes.map((a) => ['archetype', a.slug, a.convention])];
	return template(KIND.napplet, o, extra);
}

function template(kind: number, o: ManifestOptions, extra: string[][]): EventTemplate {
	if (!SITE_ID.test(o.id) || o.id.endsWith('-')) throw new Error(`d tag "${o.id}" must match ${SITE_ID} and not end in "-"`);
	const tags: string[][] = [
		['d', o.id],
		...pathTags(o.entries),
		['x', aggregate(o.entries), 'aggregate'],
		...o.servers.map((s) => ['server', s]),
		['title', o.title],
		['description', o.description]
	];
	if (o.source) tags.push(['source', o.source]);
	if (o.app) tags.push(['app', o.app[0], o.app[1]]);
	tags.push(...extra);
	return { kind, created_at: o.created_at ?? Math.floor(Date.now() / 1000), content: '', tags };
}

/** A snapshot of a signed manifest: same paths, one aggregate, one address back to the source. */
export function snapshotTemplate(source: Event, relayHint: string, created_at = Math.floor(Date.now() / 1000)): EventTemplate {
	const kind = source.kind === KIND.site ? KIND.siteSnapshot : source.kind === KIND.napplet ? KIND.nappletSnapshot : null;
	if (!kind) throw new Error(`no snapshot kind for kind ${source.kind}`);
	const d = source.tags.find((t) => t[0] === 'd')?.[1];
	if (!d) throw new Error('the source manifest has no d tag');
	return {
		kind,
		created_at,
		content: '',
		tags: [['a', `${source.kind}:${source.pubkey}:${d}`, relayHint], ...source.tags.filter((t) => t[0] !== 'd' && t[0] !== 'a')]
	};
}

/** Checks a manifest against the NIP-5A rules before it is signed, and again after it is fetched back. */
export function validate(event: EventTemplate | Event, options: { snapshot?: boolean } = {}) {
	const tags = event.tags;
	const of = (name: string) => tags.filter((t) => t[0] === name);
	const problems: string[] = [];
	const paths = of('path');
	if (!paths.length) problems.push('no path tags');
	for (const [, path, hash] of paths) {
		if (!path?.startsWith('/') || !hasExtension(path)) problems.push(`path "${path}" is not absolute with an extension`);
		if (!/^[0-9a-f]{64}$/.test(hash ?? '')) problems.push(`path "${path}" has no sha256`);
	}
	if (new Set(paths.map((t) => t[1])).size !== paths.length) problems.push('duplicate paths');
	const x = of('x');
	if (x.length !== 1) problems.push(`expected one x tag, found ${x.length}`);
	else if (x[0][1] !== aggregate(paths.map((t) => ({ path: t[1], sha256: t[2] })))) problems.push('x tag does not match the aggregate of the path tags');
	const a = of('a');
	if (options.snapshot) {
		if (of('d').length) problems.push('a snapshot must not have a d tag');
		if (a.length !== 1) problems.push(`a snapshot needs exactly one a tag, found ${a.length}`);
		if (![KIND.siteSnapshot, KIND.nappletSnapshot].includes(event.kind as 5128 | 5129)) problems.push(`kind ${event.kind} is not a snapshot kind`);
	} else {
		const d = of('d');
		if (d.length !== 1 || !SITE_ID.test(d[0][1] ?? '') || d[0][1].endsWith('-')) problems.push('d tag missing or invalid');
	}
	if (problems.length) throw new Error(`manifest is invalid: ${problems.join('; ')}`);
	return true;
}

export const tagValue = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1];
export const tagValues = (event: { tags: string[][] }, name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1]);
