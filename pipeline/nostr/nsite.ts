// nsite hostnames (NIP-5A). A named site is served at <pubkey in base36><d>.<gateway>: the pubkey takes 50 base36
// digits (2^256 fits in 50), left-padded, and the d tag is 1 to 13 of [a-z0-9-] not ending in "-".

export const SITE_ID = /^[a-z0-9-]{1,13}$/;

export function nsiteLabel(pubkeyHex: string) {
	if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) throw new Error('pubkey must be 64 hex characters');
	return BigInt(`0x${pubkeyHex}`).toString(36).padStart(50, '0');
}

export function assertSiteId(id: string) {
	if (!SITE_ID.test(id) || id.endsWith('-')) throw new Error(`site id "${id}" must match ${SITE_ID} and not end in "-"`);
	return id;
}

/** https://<label><id>.<gateway> for a named site, https://<npub>.<gateway> is the root site's form. */
export function siteOrigin(pubkeyHex: string, id: string, gateway: string) {
	return `https://${nsiteLabel(pubkeyHex)}${assertSiteId(id)}.${gateway}`;
}

/** v<event id in base36>.<gateway>: a snapshot pinned forever. */
export function snapshotOrigin(eventIdHex: string, gateway: string) {
	return `https://v${BigInt(`0x${eventIdHex}`).toString(36)}.${gateway}`;
}
