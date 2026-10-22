import { describe, expect, it } from 'vitest';
import { pickVersions } from './versions.ts';

// Committer times: 2026-09-27 12:00, 2026-09-28 12:00 and so on, UTC.
const day = (n: number) => String(Date.UTC(2026, 8, 27 + n, 12) / 1000);

// The hardware repository's history, oldest first as `git log --reverse` gives it: renames show under the new name.
const log = [
	`@c1000000000 ${day(0)} Add the Seed and Hammer`,
	'',
	'seed/Seed-v7.step',
	'hammer/Hammer-v41.step',
	`@c2000000000 ${day(1)} Widen the Seed's slot`,
	'',
	'seed/Seed-v13.step',
	`@c3000000000 ${day(1)} Round the Seed's corners`,
	'',
	'seed/Seed-v15.step',
	`@c4000000000 ${day(2)} Fix the Seed export`,
	'',
	'seed/Seed-v13.step',
	'seed/notes/Seed-v99.step',
	'seed/Seed-v16.stp',
	`@c5000000000 ${day(3)} Export the Hammer`,
	'',
	'hammer/hammer.step',
	`@c6000000000 ${day(4)} Move the Hammer's dock`,
	'',
	'hammer/hammer.step',
	`@c7000000000 ${day(5)} Tidy the Hammer's names`,
	'',
	'hammer/hammer.step',
	'hammer/notes.md'
].join('\n');

describe('model versions', () => {
	it('freezes each file of the older naming at the commit that added it, newest commit first', () => {
		const { sources } = pickVersions(log, 'seed');
		expect(sources.map((s) => [s.id, s.date, s.path])).toEqual([
			['c300000', '2026-09-28', 'seed/Seed-v15.step'],
			['c200000', '2026-09-28', 'seed/Seed-v13.step'],
			['c100000', '2026-09-27', 'seed/Seed-v7.step']
		]);
		expect(sources[0]).toEqual({
			id: 'c300000', commit: 'c3000000000', date: '2026-09-28', committed: '2026-09-28T12:00:00Z', subject: 'Round the Seed\'s corners', path: 'seed/Seed-v15.step'
		});
	});

	it('reports a later change to a file of the older naming instead of taking it', () => {
		expect(pickVersions(log, 'seed').ignored).toEqual([{ commit: 'c4000000000', path: 'seed/Seed-v13.step', reason: 'changed' }]);
	});

	it('takes every commit to the current file, and the older files before it', () => {
		const { sources, ignored } = pickVersions(log, 'hammer');
		expect(sources.map((s) => [s.id, s.path])).toEqual([
			['c700000', 'hammer/hammer.step'],
			['c600000', 'hammer/hammer.step'],
			['c500000', 'hammer/hammer.step'],
			['c100000', 'hammer/Hammer-v41.step']
		]);
		expect(ignored).toEqual([]);
	});

	it('dates a commit in UTC, to the day and to the second', () => {
		const late = `@e1000000000 ${Date.UTC(2026, 9, 13, 23, 30, 5) / 1000} Export the II\n\nII/II-v74.step`;
		expect(pickVersions(late, 'II').sources[0]).toMatchObject({ date: '2026-10-13', committed: '2026-10-13T23:30:05Z' });
	});

	it('makes one version of a commit with two STEP files: the current file, else the later name', () => {
		const both = `@f1000000000 ${day(0)} Rename the Seed's file\n\nseed/Seed-v42.step\nseed/seed.step`;
		const { sources, ignored } = pickVersions(both, 'seed');
		expect(sources.map((s) => s.path)).toEqual(['seed/seed.step']);
		expect(ignored).toEqual([{ commit: 'f1000000000', path: 'seed/Seed-v42.step', reason: 'same commit' }]);
		const two = `@f2000000000 ${day(0)} Export the Seed twice\n\nseed/Seed-v10.step\nseed/Seed-v9.step`;
		expect(pickVersions(two, 'seed').sources.map((s) => s.path)).toEqual(['seed/Seed-v10.step']);
	});
});
