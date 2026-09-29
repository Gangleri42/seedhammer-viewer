// Checks a published site and napplet the way a stranger would: fetch the manifests from the relays, verify the
// signatures, recompute the aggregate, and confirm every listed file on every listed server. No keys involved.
// Usage: npm run verify:nostr -- [npub-or-hex] [site-id] [--full]
import { createHash } from 'node:crypto';
import * as nip19 from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { blobUrl, head } from './nostr/blossom.ts';
import { KIND, LOOKUP_RELAYS, readConfig } from './nostr/config.ts';
import { aggregate, tagValue, tagValues, validate } from './nostr/manifest.ts';
import { siteOrigin } from './nostr/nsite.ts';
import { Relays } from './nostr/relays.ts';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const full = process.argv.includes('--full');
const config = readConfig();
const who = positional[0] ?? config.pubkey;
const pubkey = who.startsWith('npub1') ? (nip19.decode(who).data as string) : who;
const id = positional[1] ?? config.id;
const relays = new Relays();
let failures = 0;
const check = (ok: boolean, line: string) => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`);
	if (!ok) failures++;
};

async function checkManifest(kind: 35128 | 35129, name: string) {
	console.log(`\n${name} (kind ${kind}) of ${nip19.npubEncode(pubkey)}, d=${id}`);
	const { event, seen } = await relays.latest([...new Set([...config.relays, ...config.archiveRelays!, ...LOOKUP_RELAYS])], { kinds: [kind], authors: [pubkey], '#d': [id] });
	if (!event) {
		check(false, 'no manifest found on any relay');
		return;
	}
	check(verifyEvent(event), `signature of ${event.id.slice(0, 12)}… (${new Date(event.created_at * 1000).toISOString()})`);
	const holders = Object.entries(seen).filter(([, eid]) => eid === event.id).map(([r]) => r.replace('wss://', ''));
	const stale = Object.entries(seen).filter(([, eid]) => eid && eid !== event.id).map(([r]) => r.replace('wss://', ''));
	check(holders.length >= 2, `newest copy on ${holders.length} relays: ${holders.join(', ')}${stale.length ? `; STALE on ${stale.join(', ')}` : ''}`);
	try {
		validate(event);
		check(true, 'NIP-5A shape and aggregate');
	} catch (err) {
		check(false, String(err));
	}
	const paths = event.tags.filter((t) => t[0] === 'path').map((t) => ({ path: t[1], sha256: t[2] }));
	console.log(`  ${paths.length} files, aggregate ${aggregate(paths).slice(0, 16)}…; servers: ${tagValues(event, 'server').join(', ')}`);
	for (const server of tagValues(event, 'server')) {
		let missing = 0, wrong = 0;
		for (const { path, sha256 } of paths) {
			if (full) {
				const response = await fetch(blobUrl(server, sha256, path.split('.').pop()), { signal: AbortSignal.timeout(120_000) }).catch(() => null);
				const data = response?.ok ? new Uint8Array(await response.arrayBuffer()) : null;
				if (!data) missing++;
				else if (createHash('sha256').update(data).digest('hex') !== sha256) wrong++;
			} else if ((await head(server, sha256)).status !== 200) missing++;
		}
		check(!missing && !wrong, `${server}: ${paths.length - missing - wrong}/${paths.length} files${wrong ? `, ${wrong} with a wrong hash` : ''}${full ? ' (downloaded and hashed)' : ' (HEAD)'}`);
	}
	if (kind === KIND.napplet) {
		const requires = tagValues(event, 'requires');
		const archetypes = event.tags.filter((t) => t[0] === 'archetype').map((t) => `${t[1]} (${t[2]})`);
		console.log(`  requires ${requires.join(', ') || 'nothing'}; archetypes ${archetypes.join(', ') || 'none'}`);
	}
	return event;
}

async function checkList(kind: 10002 | 10063, name: string, tag: string) {
	const { event, seen } = await relays.latest(LOOKUP_RELAYS, { kinds: [kind], authors: [pubkey] });
	const where = Object.entries(seen).filter(([, eid]) => eid).map(([r]) => r.replace('wss://', ''));
	check(!!event && where.length > 0, `${name} (kind ${kind}) on the lookup relays: ${where.join(', ') || 'none'}${event ? `; ${tagValues(event, tag).length} entries` : ''}`);
	if (event) console.log(`       ${tagValues(event, tag).join(', ')}`);
}

console.log(`lists of ${nip19.npubEncode(pubkey)}`);
await checkList(KIND.relayList, 'relay list', 'r');
await checkList(KIND.serverList, 'server list', 'server');
const site = await checkManifest(KIND.site, 'site');
await checkManifest(KIND.napplet, 'napplet');
if (site) {
	const gateway = config.gatewayHostnames?.[0] ?? 'nsite.lol';
	const origin = siteOrigin(pubkey, id, gateway);
	const index = site.tags.find((t) => t[0] === 'path' && t[1] === '/models/index.json');
	if (index) {
		const response = await fetch(`${origin}/models/index.json`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' }).catch(() => null);
		const hash = response?.ok ? createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex') : null;
		check(hash === index[2], `${origin}/models/index.json ${response?.status ?? 'unreachable'}${hash ? (hash === index[2] ? ' matches the manifest' : ' differs from the manifest (gateway cache?)') : ''}`);
	}
	console.log(`\n  ${origin}/  naddr ${nip19.naddrEncode({ kind: KIND.site, pubkey, identifier: id })}`);
}
relays.destroy();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
