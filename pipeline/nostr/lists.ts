// The identity's relay list (NIP-65, kind 10002) and Blossom server list (BUD-03, kind 10063) are shared with
// everything else that identity does, so publishing them means merging, never overwriting, unless asked to.
import type { Event } from 'nostr-tools/core';

const normalize = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

export type Merge = { tags: string[][]; added: string[]; kept: string[]; dropped: string[] };

/** A relay for the list: plain means read and write, "write" marks an outbox others read our events from. */
export type WantedRelay = string | { url: string; marker: 'read' | 'write' };

const urlOf = (w: WantedRelay) => (typeof w === 'string' ? w : w.url);
const tagOf = (w: WantedRelay) => (typeof w === 'string' ? ['r', w] : ['r', w.url, w.marker]);

/** kind 10002: existing entries first with their read/write markers, then the wanted relays not yet listed. */
export function mergeRelayList(existing: Event | null, wanted: WantedRelay[], replace = false): Merge {
	const current = existing?.tags.filter((t) => t[0] === 'r' && t[1]) ?? [];
	const urls = wanted.map(urlOf);
	if (replace) return { tags: wanted.map(tagOf), added: urls, kept: [], dropped: current.map((t) => t[1]).filter((r) => !urls.some((w) => normalize(w) === normalize(r))) };
	const have = new Set(current.map((t) => normalize(t[1])));
	const added = wanted.filter((w) => !have.has(normalize(urlOf(w))));
	return { tags: [...current, ...added.map(tagOf)], added: added.map(urlOf), kept: current.map((t) => t[1]), dropped: [] };
}

/** kind 10063: order is trust, so the wanted servers lead in their order and anything else already listed follows. */
export function mergeServerList(existing: Event | null, wanted: string[], replace = false): Merge {
	const current = existing?.tags.filter((t) => t[0] === 'server' && t[1]).map((t) => t[1]) ?? [];
	const wantedSet = new Set(wanted.map(normalize));
	const extra = current.filter((s) => !wantedSet.has(normalize(s)));
	const kept = current.filter((s) => wantedSet.has(normalize(s)));
	const list = replace ? wanted : [...wanted, ...extra];
	return {
		tags: list.map((s) => ['server', s]),
		added: wanted.filter((s) => !current.some((c) => normalize(c) === normalize(s))),
		kept: replace ? kept : [...kept, ...extra],
		dropped: replace ? extra : []
	};
}

export const serversOf = (event: Event | null) => event?.tags.filter((t) => t[0] === 'server' && t[1]).map((t) => t[1]) ?? [];
