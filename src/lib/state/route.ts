// The hash grammar is the viewer's route (see hash.ts). Outside a URL it travels as a NAP-INTENT payload: one string
// field, `route`, holding the hash without its "#". The convention below is what a shell or another napplet emits to
// open a view; runtimes turn its query into the payload.
import { ARCHETYPE, CONVENTION, OPEN_TOPICS, READY_TOPIC } from './archetype';
import { isRoute } from './hash';

export { ARCHETYPE, CONVENTION, OPEN_TOPICS, READY_TOPIC };

/** A route in the hash grammar with its leading "#", or null when the text is not one. */
export function normalizeRoute(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const trimmed = text.trim();
	const hash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
	return isRoute(hash) ? hash : null;
}

export function conventionUri(route: string) {
	return `${CONVENTION}?route=${encodeURIComponent(route.replace(/^#/, ''))}`;
}

export function toPayload(route: string): Record<string, string> {
	return { route: route.replace(/^#/, '') };
}

const decoded = (text: unknown) => {
	if (typeof text !== 'string') return null;
	try {
		return decodeURIComponent(text);
	} catch {
		return null;
	}
};

/** The route carried by an intent payload. `route` wins; `model` plus optional `version` is the weaker form. */
export function routeFromPayload(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const p = payload as Record<string, unknown>;
	// A runtime that did not percent-decode the query hands over "%2Fhammer%4041"; accept that too.
	const route = normalizeRoute(p.route) ?? normalizeRoute(decoded(p.route));
	if (route) return route;
	if (typeof p.model === 'string' && /^[a-z0-9-]+$/i.test(p.model)) {
		const version = typeof p.version === 'string' && /^\d+$/.test(p.version) ? `@${p.version}` : '';
		return `#/${p.model.toLowerCase()}${version}`;
	}
	return null;
}
