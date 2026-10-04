// The record a publish leaves (publish-nostr.ts --overview): every file with its Blossom address and the nevent of
// the manifest and snapshot that publish it, and those events with the relays that hold them. Public facts only.
import type { Event } from 'nostr-tools/core';
import * as nip19 from 'nostr-tools/nip19';
import { blossomUri } from '../../src/lib/models/blossom.ts';
import type { FileEntry } from './manifest.ts';
import { siteOrigin, snapshotOrigin } from './nsite.ts';

/** A manifest as published: the relays that returned it, and its snapshot with the relays that took that. */
export type Published = { event: Event; relays: string[]; snapshot: Event | null; snapshotRelays: string[] };

export function overview(o: {
	/** Hex pubkey of the site. */
	author: string;
	/** The site's d tag. */
	id: string;
	/** Relay hint for the nevents and naddrs. */
	relay: string;
	gateway: string;
	/** The servers that hold every file. */
	servers: string[];
	/** The viewer commit the files were built from. */
	viewer: string;
	site: Published;
	napplet: Published | null;
	/** Chunks of the previous deploy are listed by hash only: their size is not known here. */
	files: { site: FileEntry[]; napplet: FileEntry[]; carried: FileEntry[] };
	/** The sha256 of each file this publish downloaded and hashed; the rest were verified by an earlier one. */
	downloaded: Set<string>;
}) {
	const nevent = (event: Event) => nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind, relays: [o.relay] });
	const events = (p: Published) => ({
		manifest: {
			kind: p.event.kind,
			id: p.event.id,
			nevent: nevent(p.event),
			naddr: nip19.naddrEncode({ kind: p.event.kind, pubkey: o.author, identifier: o.id, relays: [o.relay] }),
			relays: p.relays
		},
		snapshot: p.snapshot ? { kind: p.snapshot.kind, id: p.snapshot.id, nevent: nevent(p.snapshot), relays: p.snapshotRelays } : null
	});
	const files = (entries: FileEntry[], p: Published) =>
		[...entries]
			.sort((a, b) => (a.path < b.path ? -1 : 1))
			.map((e) => ({
				path: e.path,
				sha256: e.sha256,
				bytes: e.bytes,
				type: e.type,
				blossom: blossomUri(e, o.servers, o.author),
				manifest: nevent(p.event),
				snapshot: p.snapshot ? nevent(p.snapshot) : null,
				verified: o.downloaded.has(e.sha256) ? 'now' : 'before'
			}));
	return {
		published: new Date(o.site.event.created_at * 1000).toISOString().replace('.000', ''),
		viewer: o.viewer,
		author: nip19.npubEncode(o.author),
		servers: o.servers,
		site: {
			url: `${siteOrigin(o.author, o.id, o.gateway)}/`,
			...(o.site.snapshot ? { snapshotUrl: `${snapshotOrigin(o.site.snapshot.id, o.gateway)}/` } : {}),
			...events(o.site)
		},
		napplet: o.napplet ? events(o.napplet) : null,
		files: [...files(o.files.site, o.site), ...(o.napplet ? files(o.files.napplet, o.napplet) : [])],
		carried: o.files.carried.map((e) => ({ path: e.path, sha256: e.sha256, manifest: nevent(o.site.event) }))
	};
}
