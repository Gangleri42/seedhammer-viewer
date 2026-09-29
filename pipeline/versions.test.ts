import { describe, expect, it } from 'vitest';
import { pickVersions } from './versions.ts';

// sh-hardware's history, oldest first as `git log --reverse` gives it: renames show under the new name.
const log = [
	'@c1 2026-09-27',
	'',
	'seed/Seed-v7.step',
	'hammer/Hammer-v41.step',
	'@c2 2026-09-28',
	'',
	'seed/Seed-v13.step',
	'@c3 2026-09-28',
	'',
	'seed/Seed-v15.step',
	'@c4 2026-09-29',
	'',
	'seed/Seed-v13.step',
	'seed/notes/Seed-v99.step',
	'seed/Seed-v16.stp'
].join('\n');

describe('model versions', () => {
	it('freezes each version at the commit that added it, newest version first', () => {
		const { sources } = pickVersions(log, 'seed');
		expect(sources.map((s) => [s.version, s.commit, s.date])).toEqual([
			[15, 'c3', '2026-09-28'],
			[13, 'c2', '2026-09-28'],
			[7, 'c1', '2026-09-27']
		]);
		expect(sources[0].path).toBe('seed/Seed-v15.step');
	});

	it('reports a later change to a published version instead of taking it', () => {
		expect(pickVersions(log, 'seed').ignored).toEqual([{ version: 13, commit: 'c4', path: 'seed/Seed-v13.step' }]);
		expect(pickVersions(log, 'hammer')).toEqual({ sources: [{ version: 41, commit: 'c1', date: '2026-09-27', path: 'hammer/Hammer-v41.step' }], ignored: [] });
	});
});
