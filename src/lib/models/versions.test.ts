import { describe, expect, it } from 'vitest';
import type { ModelEntry, ModelVersion } from './types';
import { findVersion, versionLabel } from './versions';

const file = (path: string) => ({ path, bytes: 1, sha256: path });
const version = (id: string, date: string): ModelVersion => ({ id, date, glb: file(`${id}.glb`), step: file(`hammer-${id}.step.zip`), triangles: 0, bodies: 0 });
const entry: ModelEntry = { title: 'Hammer', latest: '02a4106', versions: [version('02a4106', '2026-10-14'), version('16ccf13', '2026-10-07'), version('4106aaa', '2026-10-06')] };

describe('which version a route names', () => {
	it('finds a listed id, also from the full commit hash', () => {
		expect(findVersion(entry, '16ccf13')?.id).toBe('16ccf13');
		expect(findVersion(entry, '02a410612857b15c8a2dfa9c916df7c728bdf2f2')?.id).toBe('02a4106');
	});

	it('finds nothing for an id the index no longer lists, an old version number or no version', () => {
		expect(findVersion(entry, 'af250cb')).toBeUndefined();
		expect(findVersion(entry, '41')).toBeUndefined();
		expect(findVersion(entry, '4106')).toBeUndefined();
		expect(findVersion(entry, null)).toBeUndefined();
	});

	it('labels a version by id and day', () => {
		expect(versionLabel(entry.versions[0])).toBe('02a4106 · 14 Oct');
		expect(versionLabel({ ...entry.versions[0], date: '' })).toBe('02a4106');
	});
});
