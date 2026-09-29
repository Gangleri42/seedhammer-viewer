// Publishes the viewer to Nostr, signed end to end:
//   1. builds the site (build/) and the napplet (dist-napplet/index.html)
//   2. checks which Blossom servers take every file type, then uploads to our server and mirrors to the others
//   3. verifies every file on every server by downloading it and hashing it
//   4. merges and publishes the relay list (10002) and server list (10063)
//   5. publishes the site manifest (35128) with a snapshot (5128), then the napplet manifest (35129) with its snapshot (5129)
//   6. fetches everything back from the relays and checks signatures and aggregates
// Usage: npm run publish:nostr -- [--models] [--if-changed] [--no-ledger] [--dry-run] [--skip-build] [--skip-napplet] [--replace-lists] [--no-snapshot] [--min-public N]
// It runs on the forge only: the forge's container sets SEEDHAMMER_PUBLISHER=forge and NOSTR_NSEC_FILE, and anywhere
// else the script refuses to start, dry runs included, since those talk to the relays and servers too.
// The models are built, not committed: run `npm run models` first, or pass --models to have it run here.
// --if-changed stops early when the manifests on the relays already describe this build; --no-ledger leaves
// pipeline/nostr/ledger.json alone (the relays are the record then).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Event, EventTemplate } from 'nostr-tools/core';
import * as nip19 from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { blobUrl, extOf, head, mirror, preflight, upload, verify } from './nostr/blossom.ts';
import { KIND, LOOKUP_RELAYS, mimeOf, readConfig } from './nostr/config.ts';
import { appendDeploy, lastDeploy, previousImmutable, readLedger, type Deploy } from './nostr/ledger.ts';
import { mergeRelayList, mergeServerList } from './nostr/lists.ts';
import { aggregate, collectFiles, nappletTemplate, siteTemplate, snapshotTemplate, tagValue, validate, type FileEntry } from './nostr/manifest.ts';
import { siteOrigin, snapshotOrigin } from './nostr/nsite.ts';
import { Relays } from './nostr/relays.ts';
import { openSigner, type Signer } from './nostr/signer.ts';

const log = (line = '') => console.log(line);
function fail(message: string): never {
	console.error(`\nerror: ${message}`);
	process.exit(1);
}

if (process.env.SEEDHAMMER_PUBLISHER !== 'forge') fail('publishing runs on the forge only, over its VPN; this is not the forge');

// Strict: a mistyped flag (--dryrun) stops the run instead of publishing for real.
const { values } = (() => {
	try {
		return parseArgs({
			strict: true,
			allowPositionals: false,
			options: {
				models: { type: 'boolean' },
				'if-changed': { type: 'boolean' },
				'no-ledger': { type: 'boolean' },
				'dry-run': { type: 'boolean' },
				'skip-build': { type: 'boolean' },
				'skip-napplet': { type: 'boolean' },
				'replace-lists': { type: 'boolean' },
				'no-snapshot': { type: 'boolean' },
				'min-public': { type: 'string', default: '3' }
			}
		});
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
})();
const minPublic = Number(values['min-public']);
if (!Number.isInteger(minPublic) || minPublic < 0) fail(`--min-public must be a whole number, got "${values['min-public']}"`);
const opts = {
	models: !!values.models,
	ifChanged: !!values['if-changed'],
	ledger: !values['no-ledger'],
	dryRun: !!values['dry-run'],
	skipBuild: !!values['skip-build'],
	skipNapplet: !!values['skip-napplet'],
	replaceLists: !!values['replace-lists'],
	snapshot: !values['no-snapshot'],
	minPublic
};

const config = readConfig();
const npub = nip19.npubEncode(config.pubkey);
const ownServer = config.servers[0];
const ownRelay = config.relays[0];
const unixNow = () => Math.floor(Date.now() / 1000);

// ---- build and file sets --------------------------------------------------------------------------------------------

if (opts.models) {
	log('converting the models from the hardware repository');
	execFileSync('npm', ['run', 'models'], { stdio: 'inherit' });
}
if (!existsSync('static/models/index.json')) fail('static/models is not built; run npm run models (HARDWARE_DIR, CONVERT: see the README) or pass --models');
if (!opts.skipBuild) {
	log('building the site and the napplet');
	execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
	if (!opts.skipNapplet) execFileSync('npm', ['run', 'build:napplet'], { stdio: 'inherit' });
}
if (!existsSync('build/index.html')) fail('build/index.html is missing; run npm run build');

// GitHub Pages files have no extension and mean nothing to a gateway.
const site = collectFiles('build', ['/CNAME', '/.nojekyll']);
const ledger = readLedger();
const relays = new Relays();
const readRelays = [...new Set([...config.relays, ...config.archiveRelays!])];

// The manifests as the relays have them now: the record an unattended run works from.
const current = {
	site: (await relays.latest(readRelays, { kinds: [KIND.site], authors: [config.pubkey], '#d': [config.id] })).event,
	napplet: opts.skipNapplet ? null : (await relays.latest(readRelays, { kinds: [KIND.napplet], authors: [config.pubkey], '#d': [config.id] })).event
};
const listed = (event: Event | null) => new Map(event?.tags.filter((t) => t[0] === 'path').map((t) => [t[1], t[2]]) ?? []);

// A returning browser may hold the previous index.html for an hour: its hashed chunks stay in the manifest for one
// more deploy. They come from the manifest on the relays, or from the ledger when no relay has one.
const previousChunks: { path: string; sha256: string; bytes: number }[] = current.site
	? [...listed(current.site)].filter(([path]) => path.startsWith('/_app/immutable/')).map(([path, sha256]) => ({ path, sha256, bytes: 0 }))
	: previousImmutable(ledger);
const previous: FileEntry[] = previousChunks.filter((p) => !site.some((s) => s.path === p.path)).map((p) => ({ ...p, type: mimeOf(p.path) }));
const napplet = opts.skipNapplet ? [] : collectFiles('dist-napplet', ['/.nip5a-manifest.json']);
if (!opts.skipNapplet && (napplet.length !== 1 || napplet[0].path !== '/index.html')) fail('dist-napplet must hold exactly /index.html; run npm run build:napplet');
const sidecar = opts.skipNapplet ? null : (JSON.parse(readFileSync('dist-napplet/.nip5a-manifest.json', 'utf8')) as { tags: string[][] });
if (sidecar && tagValue(sidecar, 'd') !== config.id) fail(`the napplet was built as "${tagValue(sidecar, 'd')}", the site id is "${config.id}"; keep NAPPLET_TYPE in vite.napplet.config.ts equal to .nsite/config.json id`);
if (sidecar && tagValue(sidecar, 'path') !== undefined && sidecar.tags.find((t) => t[0] === 'path')?.[2] !== napplet[0].sha256) fail('dist-napplet/.nip5a-manifest.json does not describe dist-napplet/index.html');

const uploads: FileEntry[] = [...site, ...napplet];
const everything: FileEntry[] = [...uploads, ...previous];
const megabytes = (entries: { bytes: number }[]) => (entries.reduce((n, e) => n + e.bytes, 0) / 1e6).toFixed(2);

log(`\nsite ${config.id} for ${npub}`);
log(`  ${site.length} files, ${megabytes(site)} MB, aggregate ${aggregate([...site, ...previous]).slice(0, 16)}…`);
if (previous.length) log(`  keeping ${previous.length} chunk paths of the previous deploy for browsers holding the old index.html`);
if (napplet.length) log(`  napplet /index.html ${megabytes(napplet)} MB, aggregate ${aggregate(napplet).slice(0, 16)}…`);
log(`  relays  ${config.relays.join(', ')}`);
log(`  servers ${config.servers.join(', ')}`);

// Already published: every file of this build is in the current manifest with the same hash (old chunks may linger).
const published = (files: FileEntry[], event: Event | null) => files.length > 0 && !!event && files.every((f) => listed(event).get(f.path) === f.sha256);
if (opts.ifChanged && published(site, current.site) && (opts.skipNapplet || published(napplet, current.napplet))) {
	log(`\nnothing changed: the manifests on the relays already describe this build (site ${current.site!.id.slice(0, 12)}…)`);
	relays.destroy();
	process.exit(0);
}

// ---- dry run: what would happen, with no signer and no writes ------------------------------------------------------

if (opts.dryRun) {
	log('\ndry run: presence on each server (unauthenticated HEAD)');
	for (const server of config.servers) {
		const present = await Promise.all(everything.map(async (e) => (await head(server, e.sha256)).status === 200));
		log(`  ${server}: ${present.filter(Boolean).length}/${everything.length} files already there`);
	}
	const siteEvent = siteTemplate({ id: config.id, entries: [...site, ...previous], servers: config.servers, title: config.title, description: config.description, source: config.source });
	validate(siteEvent);
	log(`\nsite manifest (unsigned): kind ${siteEvent.kind}, ${siteEvent.tags.length} tags, ${JSON.stringify(siteEvent).length} bytes`);
	if (sidecar) {
		const nappletEvent = nappletTemplate({ id: config.id, entries: napplet, servers: config.servers, title: config.title, description: config.description, source: config.source, requires: sidecar.tags.filter((t) => t[0] === 'requires').map((t) => t[1]), archetypes: sidecar.tags.filter((t) => t[0] === 'archetype').map((t) => ({ slug: t[1], convention: t[2] })) });
		validate(nappletEvent);
		log(`napplet manifest (unsigned): kind ${nappletEvent.kind}, ${nappletEvent.tags.length} tags; sidecar aggregate ${tagValue(sidecar, 'x') === tagValue(nappletEvent, 'x') ? 'matches' : 'DIFFERS'}`);
	}
	log(`\nwould publish to ${config.relays.length} relays and the lists also to ${LOOKUP_RELAYS.join(', ')}`);
	log(`site URL: ${siteOrigin(config.pubkey, config.id, config.gatewayHostnames?.[0] ?? 'nsite.lol')}/`);
	relays.destroy();
	process.exit(0);
}

// ---- signer ---------------------------------------------------------------------------------------------------------

const signer: Signer = (() => {
	try {
		return openSigner(config.pubkey);
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
})();
log(`\nsigning as ${signer.npub}`);
const shutdown = async () => {
	await signer.close();
	relays.destroy();
};

// One upload authorisation covers a batch of hashes on every server, so a run signs a handful of tokens, not hundreds.
// The token is scoped by the file hashes and a short expiry only. BUD-11's optional `server` tags are read
// differently by the servers out there (hzrd149's blossom-server wants the bare domain, blssm.us and nsite.run
// reject anything but a URL), and a hash-scoped token replayed elsewhere can only place the same public bytes.
// Some servers also want the token minted within the last two minutes, so a batch is re-signed once its token
// is 90 seconds old; a long run of uploads through a slow link spans many minutes.
const batches = new Map<string, FileEntry[]>();
for (let i = 0; i < everything.length; i += 20) {
	const batch = everything.slice(i, i + 20);
	for (const entry of batch) batches.set(entry.sha256, batch);
}
const auths = new Map<FileEntry[], Event>();
async function authFor(entry: { sha256: string }): Promise<Event> {
	const batch = batches.get(entry.sha256)!;
	const cached = auths.get(batch);
	if (cached && unixNow() - cached.created_at < 90) return cached;
	const auth = await signer.signEvent({
		kind: KIND.blobAuth,
		created_at: unixNow(),
		content: 'Publish the SeedHammer viewer',
		tags: [['t', 'upload'], ['expiration', String(unixNow() + 600)], ...batch.map((e) => ['x', e.sha256])]
	});
	auths.set(batch, auth);
	return auth;
}

// ---- gate: which servers take what we have ----------------------------------------------------------------------

log('\nchecking servers (BUD-06 preflight per file type)');
const largestPerType = [...new Map(uploads.map((e) => [e.type, e])).values()].map((probe) => uploads.filter((e) => e.type === probe.type).sort((a, b) => b.bytes - a.bytes)[0]);
const servers: string[] = [];
for (const server of config.servers) {
	const failures: string[] = [];
	let unknown = false;
	for (const probe of largestPerType) {
		const r = await preflight(server, probe, await authFor(probe));
		if (!r.ok) failures.push(`${probe.type} ${r.status} ${r.reason}`);
		else if (r.reason === 'no preflight endpoint') unknown = true;
	}
	log(`  ${failures.length ? 'skip' : 'ok  '} ${server}${failures.length ? `: ${failures.join('; ')}` : unknown ? ' (no preflight endpoint; the upload decides)' : ''}`);
	if (!failures.length) servers.push(server);
}
if (!servers.includes(ownServer)) {
	await shutdown();
	fail(`${ownServer} (our server) refused the preflight; fix it before publishing`);
}
if (servers.length - 1 < opts.minPublic) {
	await shutdown();
	fail(`only ${servers.length - 1} public servers passed, ${opts.minPublic} needed (--min-public to change)`);
}

// ---- blobs: upload to our server, mirror to the rest, verify everywhere ------------------------------------------

log('\nplacing files');
// The bytes to upload: the local file, or for a chunk carried over from the previous deploy, a verified copy
// from our own server.
const fetched = new Map<string, Uint8Array>();
const bytesOf = async (entry: FileEntry): Promise<Uint8Array | null> => {
	if (entry.file) return readFileSync(entry.file);
	const cached = fetched.get(entry.sha256);
	if (cached) return cached;
	try {
		const response = await fetch(blobUrl(ownServer, entry.sha256, extOf(entry.path)), { signal: AbortSignal.timeout(300_000) });
		if (!response.ok) return null;
		const data = new Uint8Array(await response.arrayBuffer());
		if (createHash('sha256').update(data).digest('hex') !== entry.sha256) return null;
		fetched.set(entry.sha256, data);
		return data;
	} catch {
		return null;
	}
};
const place = async (server: string, entry: FileEntry) => {
	if ((await head(server, entry.sha256)).status === 200) return { ok: true, status: 200, reason: 'present' };
	if (server !== ownServer) {
		const mirrored = await mirror(server, blobUrl(ownServer, entry.sha256, extOf(entry.path)), await authFor(entry));
		if (mirrored.ok) return mirrored;
	}
	const bytes = await bytesOf(entry);
	if (!bytes) return { ok: false, status: 0, reason: 'previous deploy file is gone from our server and cannot be re-uploaded' };
	return upload(server, entry, bytes, await authFor(entry));
};
const surviving = new Set(servers);
const lostPrevious = new Set<string>();
for (const entry of everything) {
	const own = await place(ownServer, entry);
	if (!own.ok) {
		if (!entry.file) {
			lostPrevious.add(entry.path);
			continue;
		}
		await shutdown();
		fail(`${ownServer} did not take ${entry.path}: ${own.status} ${own.reason}`);
	}
	for (const server of servers.filter((s) => s !== ownServer && surviving.has(s))) {
		const r = await place(server, entry);
		if (!r.ok) {
			log(`  ${server} did not take ${entry.path}: ${r.status} ${r.reason}; dropping the server for this deploy`);
			surviving.delete(server);
		}
	}
	log(`  ${entry.path} (${(entry.bytes / 1e3).toFixed(0)} kB) on ${[...surviving].length} servers`);
}
const carried = previous.filter((p) => !lostPrevious.has(p.path));
if (lostPrevious.size) log(`  ${lostPrevious.size} previous chunk paths are no longer on ${ownServer} and are dropped`);

log('\nverifying every file on every server (download and hash)');
// Everything that must be served (verified below), and the site's own file set (the napplet is its own manifest).
const finalEntries: FileEntry[] = [...uploads, ...carried];
const siteEntries: FileEntry[] = [...site, ...carried];
for (const server of [...surviving]) {
	const bad: string[] = [];
	for (const entry of finalEntries) {
		const r = await verify(server, entry);
		if (!r.ok) bad.push(`${entry.path}: ${r.status} ${r.reason}`);
	}
	log(`  ${bad.length ? 'FAIL' : 'ok  '} ${server}${bad.length ? `: ${bad.slice(0, 3).join('; ')}` : ''}`);
	if (bad.length) surviving.delete(server);
}
if (!surviving.has(ownServer)) {
	await shutdown();
	fail(`${ownServer} does not serve what it accepted; refusing to publish a manifest that points at it`);
}
if (surviving.size - 1 < opts.minPublic) {
	await shutdown();
	fail(`only ${surviving.size - 1} public servers hold every file, ${opts.minPublic} needed`);
}
const serverTags = config.servers.filter((s) => surviving.has(s));

// ---- relay and server lists -----------------------------------------------------------------------------------------

const listRelays = [...new Set([...config.relays, ...LOOKUP_RELAYS])];
const report = (r: Record<string, { ok: boolean; reason: string }>) =>
	Object.entries(r)
		.map(([relay, v]) => `${v.ok ? 'ok' : 'NO'} ${relay.replace('wss://', '')}${v.ok ? '' : ` (${v.reason})`}`)
		.join(', ');
const laterThan = (existing: Event | null) => Math.max(unixNow(), (existing?.created_at ?? 0) + 1);

async function publishList(kind: 10002 | 10063, tagsFor: (existing: Event | null) => { tags: string[][]; added: string[]; dropped: string[] }) {
	const { event: existing } = await relays.latest(listRelays, { kinds: [kind], authors: [config.pubkey] });
	const merge = tagsFor(existing);
	if (merge.dropped.length) log(`  kind ${kind}: replacing, dropping ${merge.dropped.join(', ')}`);
	if (existing && !merge.added.length && !merge.dropped.length && JSON.stringify(existing.tags) === JSON.stringify(merge.tags)) {
		log(`  kind ${kind}: unchanged (${merge.tags.length} entries)`);
		return;
	}
	const event = await signer.signEvent({ kind, created_at: laterThan(existing), content: existing?.content ?? '', tags: merge.tags });
	log(`  kind ${kind}: ${merge.tags.length} entries${merge.added.length ? `, added ${merge.added.join(', ')}` : ''} → ${report(await relays.publish(listRelays, event))}`);
}

log('\npublishing the relay list and the server list');
// The archive relays are read-only to us but hold our events for good: outboxes, from a reader's point of view.
await publishList(KIND.relayList, (existing) => mergeRelayList(existing, [...config.relays, ...config.archiveRelays!.map((url) => ({ url, marker: 'write' as const }))], opts.replaceLists));
await publishList(KIND.serverList, (existing) => mergeServerList(existing, serverTags, opts.replaceLists));

// ---- manifests and snapshots ----------------------------------------------------------------------------------------

async function publishManifest(name: string, build: (created_at: number) => EventTemplate, kind: 35128 | 35129) {
	const { event: remote, seen } = await relays.latest(readRelays, { kinds: [kind], authors: [config.pubkey], '#d': [config.id] });
	// The relays are the record: the forge and a laptop may both publish, and the newer manifest simply replaces the
	// older. A manifest the local ledger does not know is only worth a line.
	const known = kind === KIND.site ? lastDeploy(ledger)?.site : lastDeploy(ledger)?.napplet;
	if (remote && known && remote.id !== known.id && remote.created_at > known.created_at) {
		log(`  the relays hold a ${name} manifest not in the local ledger (${remote.id.slice(0, 12)}…, ${new Date(remote.created_at * 1000).toISOString()}); replacing it`);
	}
	const template = build(laterThan(remote));
	validate(template);
	const event = await signer.signEvent(template);
	const published = await relays.publish(config.relays, event);
	log(`  ${name} ${kind} ${event.id.slice(0, 12)}… → ${report(published)}`);
	if (!Object.values(published).some((r) => r.ok)) {
		await shutdown();
		fail(`no relay accepted the ${name} manifest`);
	}
	let snapshot: Event | null = null;
	if (opts.snapshot) {
		snapshot = await signer.signEvent(snapshotTemplate(event, ownRelay, event.created_at + 1));
		validate(snapshot, { snapshot: true });
		log(`  ${name} snapshot ${snapshot.kind} ${snapshot.id.slice(0, 12)}… → ${report(await relays.publish(config.relays, snapshot))}`);
	}
	// Read back: the manifest must come back from at least two relays, valid, with the aggregate we computed.
	const back = await relays.latest(readRelays, { kinds: [kind], authors: [config.pubkey], '#d': [config.id] });
	const holders = Object.entries(back.seen).filter(([, id]) => id === event.id).map(([relay]) => relay);
	if (!back.event || back.event.id !== event.id || !verifyEvent(back.event)) {
		await shutdown();
		fail(`${name}: the relays return ${back.event?.id.slice(0, 12) ?? 'nothing'} instead of ${event.id.slice(0, 12)}…`);
	}
	validate(back.event);
	log(`  ${name} read back from ${holders.length} relays, signature and aggregate verified${holders.length < 2 ? ' (WARNING: fewer than two relays hold it)' : ''}`);
	void seen;
	return { event, snapshot };
}

log('\npublishing the site');
const siteResult = await publishManifest(
	'site',
	(created_at) => siteTemplate({ id: config.id, entries: siteEntries, servers: serverTags, title: config.title, description: config.description, source: config.source, created_at }),
	KIND.site
);
let nappletResult: { event: Event; snapshot: Event | null } | null = null;
if (sidecar) {
	log('\npublishing the napplet');
	nappletResult = await publishManifest(
		'napplet',
		(created_at) =>
			nappletTemplate({
				id: config.id,
				entries: napplet,
				servers: serverTags,
				title: tagValue(sidecar, 'title') ?? config.title,
				description: config.description,
				source: config.source,
				requires: sidecar.tags.filter((t) => t[0] === 'requires').map((t) => t[1]),
				archetypes: sidecar.tags.filter((t) => t[0] === 'archetype').map((t) => ({ slug: t[1], convention: t[2] })),
				created_at
			}),
		KIND.napplet
	);
	if (tagValue(sidecar, 'x') !== tagValue(nappletResult.event, 'x')) log('  WARNING: the published napplet aggregate differs from the build sidecar');
}

// ---- gateway check and ledger ---------------------------------------------------------------------------------------

const gateway = config.gatewayHostnames?.[0] ?? 'nsite.lol';
const origin = siteOrigin(config.pubkey, config.id, gateway);
const indexEntry = siteEntries.find((e) => e.path === '/models/index.json');
if (indexEntry) {
	try {
		const response = await fetch(`${origin}/models/index.json`, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
		const served = new Uint8Array(await response.arrayBuffer());
		const same = createHash('sha256').update(served).digest('hex') === indexEntry.sha256;
		log(`\n${gateway}: /models/index.json ${response.status}, ${same ? 'matches this deploy' : 'differs (the gateway may still cache the previous deploy for up to an hour)'}`);
	} catch (err) {
		log(`\n${gateway}: could not fetch /models/index.json (${err instanceof Error ? err.message : err})`);
	}
}

const commit = (() => {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		return undefined;
	}
})();
const deploy: Deploy = {
	at: new Date().toISOString(),
	commit,
	site: {
		id: siteResult.event.id,
		x: tagValue(siteResult.event, 'x')!,
		created_at: siteResult.event.created_at,
		snapshot: siteResult.snapshot?.id,
		files: siteEntries.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
	},
	servers: serverTags
};
if (nappletResult) deploy.napplet = { id: nappletResult.event.id, x: tagValue(nappletResult.event, 'x')!, created_at: nappletResult.event.created_at, snapshot: nappletResult.snapshot?.id };
if (opts.ledger) appendDeploy(ledger, deploy);

const naddr = (kind: number) => nip19.naddrEncode({ kind, pubkey: config.pubkey, identifier: config.id, relays: [ownRelay] });
log('\npublished');
log(`  site      ${origin}/`);
for (const host of config.gatewayHostnames?.slice(1) ?? []) log(`            ${siteOrigin(config.pubkey, config.id, host)}/`);
if (siteResult.snapshot) log(`  snapshot  ${snapshotOrigin(siteResult.snapshot.id, gateway)}/`);
log(`  naddr     ${naddr(KIND.site)}`);
if (nappletResult) {
	log(`  napplet   ${naddr(KIND.napplet)}`);
	if (nappletResult.snapshot) log(`            snapshot nevent ${nip19.neventEncode({ id: nappletResult.snapshot.id, author: config.pubkey, kind: nappletResult.snapshot.kind, relays: [ownRelay] })}`);
}
if (opts.ledger) log(`  ledger    pipeline/nostr/ledger.json (commit it)`);
await shutdown();
