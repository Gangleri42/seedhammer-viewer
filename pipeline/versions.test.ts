import { describe, expect, it } from 'vitest';
import { pickVersions } from './versions.ts';

// Committer times: 2026-09-27 12:00, 2026-09-28 12:00 and so on, UTC.
const day = (n: number) => String(Date.UTC(2026, 8, 27 + n, 12) / 1000);

// The hardware repository's history, oldest first as `git log --reverse` gives it: renames show under the new name.
const log = [
	`@c1000000000 ${day(0)} Export the Seed at version 7`,
	'',
	'seed/Seed-v7.step',
	'hammer/Hammer-v41.step',
	`@c2000000000 ${day(1)} Export the Seed at version 13`,
	'',
	'seed/Seed-v13.step',
	`@c3000000000 ${day(1)} Export the Seed at version 15`,
	'',
	'seed/Seed-v15.step',
	`@c4000000000 ${day(2)} Fix the Seed export`,
	'',
	'seed/Seed-v13.step',
	'seed/notes/Seed-v99.step',
	'seed/Seed-v16.stp',
	`@c5000000000 ${day(3)} Export the Hammer at version 75`,
	'',
	'hammer/hammer.step',
	`@c6000000000 ${day(4)} Export the Hammer at version 76`,
	'',
	'hammer/hammer.step',
	`@c7000000000 ${day(5)} Tidy the Hammer's names`,
	'',
	'hammer/hammer.step',
	'hammer/notes.md'
].join('\n');

describe('model versions', () => {
	it('freezes each numbered file at the commit that added it, newest commit first', () => {
		const { sources } = pickVersions(log, 'seed');
		expect(sources.map((s) => [s.id, s.date, s.number])).toEqual([
			['c300000', '2026-09-28', 15],
			['c200000', '2026-09-28', 13],
			['c100000', '2026-09-27', 7]
		]);
		expect(sources[0]).toMatchObject({ commit: 'c3000000000', path: 'seed/Seed-v15.step' });
	});

	it('reports a later change to a numbered file instead of taking it', () => {
		expect(pickVersions(log, 'seed').ignored).toEqual([{ commit: 'c4000000000', path: 'seed/Seed-v13.step', reason: 'changed' }]);
	});

	it('takes every commit to the versionless file, with the number from its subject', () => {
		const { sources, ignored } = pickVersions(log, 'hammer');
		expect(sources.map((s) => [s.id, s.path, s.number])).toEqual([
			['c700000', 'hammer/hammer.step', Infinity],
			['c600000', 'hammer/hammer.step', 76],
			['c500000', 'hammer/hammer.step', 75],
			['c100000', 'hammer/Hammer-v41.step', 41]
		]);
		expect(ignored).toEqual([]);
	});

	it('reads the number only from an export of this model', () => {
		const other = `@d1000000000 ${day(0)} Export the Seed at version 9\n\nhammer/hammer.step`;
		expect(pickVersions(other, 'hammer').sources[0].number).toBe(Infinity);
		const ii = `@d2000000000 ${day(0)} Export the II at version 75\n\nII/II.step\nII/bom.csv`;
		expect(pickVersions(ii, 'II').sources).toEqual([{ id: 'd200000', commit: 'd2000000000', date: '2026-09-27', path: 'II/II.step', number: 75 }]);
	});

	it('dates a commit in UTC', () => {
		const late = `@e1000000000 ${Date.UTC(2026, 9, 13, 23, 30) / 1000} Export the II at version 74\n\nII/II-v74.step`;
		expect(pickVersions(late, 'II').sources[0].date).toBe('2026-10-13');
	});

	it('makes one version of a commit with two STEP files, the higher number', () => {
		const both = `@f1000000000 ${day(0)} Export the Seed at version 43\n\nseed/Seed-v42.step\nseed/seed.step`;
		const { sources, ignored } = pickVersions(both, 'seed');
		expect(sources.map((s) => [s.path, s.number])).toEqual([['seed/seed.step', 43]]);
		expect(ignored).toEqual([{ commit: 'f1000000000', path: 'seed/Seed-v42.step', reason: 'same commit' }]);
	});
});
