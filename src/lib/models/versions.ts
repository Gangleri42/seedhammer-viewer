import type { ModelEntry, ModelVersion } from './types';

/**
 * The version a route names: an id the index lists, also when the link spells the commit out longer. Undefined for a
 * version the index no longer lists, or a number from a link made before versions were commits.
 */
export function findVersion(entry: ModelEntry, version: string | null): ModelVersion | undefined {
	if (!version || version.length < 7) return undefined;
	return entry.versions.find((v) => version.startsWith(v.id) || v.id.startsWith(version));
}

/** "02a4106 · 14 Oct" for the version picker, like a board revision. */
export function versionLabel(version: ModelVersion) {
	const date = new Date(version.date);
	const day = Number.isNaN(date.getTime()) ? '' : ` · ${date.getUTCDate()} ${date.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
	return `${version.id}${day}`;
}
