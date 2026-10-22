import { describe, expect, it } from 'vitest';
import { finishesFor, followHistory, resolveFinishes, type ModelConfig } from './finishes.ts';
import models from './models.json' with { type: 'json' };

const history = ['a000001', 'a000002', 'a000003', 'a000004'];
const metal = { appearance: 'chrome', kind: 'metal' as const, parts: ['housing'], versions: [{ until: 'a000002' }] };
const glass = { appearance: 'clear', kind: 'glass' as const, parts: ['housing'], versions: [{ from: 'a000003' }] };
// The Seed's and the Hammer's versions, oldest first, as the hardware repository has them.
const SEED = [
	'546c9ea', '2cf15c5', '23b847f', '32070c0', '86e15e8', '48c1424', '5b29ec7', '5678da4', '9a0b3ae', '36ee178', 'ec4f1a7',
	'e6f4bdc', 'df6027e', '59c387a', '7f34f0f', '36033ee', '4d4407e', 'cd40582'
];
const HAMMER = [
	'546c9ea', '2cf15c5', '9889e2b', '84dcb67', 'aa4a8b7', 'd847263', 'f75d18c', '36748c5', 'af250cb', '16ccf13', '02a4106',
	'b221d84', '928c7f1', '3676e2f', 'b150700', 'c4e3c4b', '53eee4c', 'b54058c', '1e7573c', '91bde75', '71264ee', '119c2ba'
];

describe('finishes by version', () => {
	it('applies a rule only inside its range, bounds included', () => {
		expect(finishesFor([metal, glass], 'a000002', history).get('housing')?.kind).toBe('metal');
		expect(finishesFor([metal, glass], 'a000003', history).get('housing')?.kind).toBe('glass');
		expect(finishesFor([metal], 'a000003', history).has('housing')).toBe(false);
		expect(finishesFor([glass], 'a000002', history).has('housing')).toBe(false);
	});

	it('applies a rule without ranges to every version, and a later rule wins', () => {
		const always = { appearance: 'steel', kind: 'metal' as const, parts: ['housing', 'screw'] };
		expect(finishesFor([always], 'a000001', history).get('screw')?.kind).toBe('metal');
		expect(finishesFor([always, glass], 'a000004', history).get('housing')?.kind).toBe('glass');
		expect(finishesFor(undefined, 'a000001', history).size).toBe(0);
	});

	it('shows the Seed housing as black chrome in the early exports and the restarted ones, and as clear glass between', () => {
		const seed = (models as Record<string, ModelConfig>).seed.materials;
		expect(finishesFor(seed, '86e15e8', SEED).get('Skeleton')).toMatchObject({ kind: 'metal', appearance: 'Chrom - Schwarz' });
		expect(finishesFor(seed, '48c1424', SEED).get('Skeleton')).toMatchObject({ kind: 'glass', appearance: 'Polykarbonat (klar)', opacity: 0.4 });
		expect(finishesFor(seed, '5b29ec7', SEED).has('Skeleton')).toBe(false);
		expect(finishesFor(seed, 'cd40582', SEED).get('Skeleton')).toMatchObject({ kind: 'metal', appearance: 'Chrom - Schwarz' });
	});

	it('stops at a range that names no version', () => {
		expect(() => resolveFinishes([{ ...glass, versions: [{ from: 'fffffff' }] }], 'a000001', history)).toThrow(/fffffff, which is no version/);
	});

	it('blackens the Hammer fasteners under their German and their English names', () => {
		const hammer = (models as Record<string, ModelConfig>).hammer.materials;
		for (const name of ['Innensechskantschraube DIN 912 - M3 x 0.5 x 12 Stahl 4.6 Einfach', 'M3x12 cyl. hex', 'M5 self-locking Nut', 'M5x8 set screw']) {
			expect(finishesFor(hammer, '02a4106', HAMMER).get(name)).toMatchObject({ kind: 'metal', appearance: 'Beschichtung - brüniert' });
		}
	});

	it('resolves the rules in force into the catalogue, in their order and without their ranges', () => {
		expect(resolveFinishes([metal, glass], 'a000001', history)).toEqual([{ appearance: 'chrome', kind: 'metal', parts: ['housing'] }]);
		expect(resolveFinishes([metal, glass], 'a000004', history)).toEqual([{ appearance: 'clear', kind: 'glass', parts: ['housing'] }]);
	});

	it('finds a commit of a rebuilt history again by its STEP file, and says so', () => {
		const rebuilt = history.map((id, i) => ({ id: id.replace('a', 'b'), blob: `blob${i + 1}`, committed: `2026-10-0${i + 1}T12:00:00Z` }));
		const commits = { a000002: { blob: 'blob2' }, a000003: { blob: 'blob3' } };
		const warnings: string[] = [];
		const rules = followHistory([metal, glass], commits, rebuilt, (message) => warnings.push(message));
		expect(rules.map((rule) => rule.versions)).toEqual([[{ until: 'b000002' }], [{ from: 'b000003' }]]);
		expect(warnings).toEqual([
			'a finish rule names a000002, which is no version of the model; b000002 has its STEP file and takes its place',
			'a finish rule names a000003, which is no version of the model; b000003 has its STEP file and takes its place'
		]);
		const ids = rebuilt.map((version) => version.id);
		expect(finishesFor(rules, 'b000002', ids).get('housing')?.kind).toBe('metal');
		expect(finishesFor(rules, 'b000003', ids).get('housing')?.kind).toBe('glass');
	});

	it('tells two versions with the same STEP file apart by their committer time', () => {
		const rebuilt = [
			{ id: 'b000001', blob: 'same', committed: '2026-10-01T12:00:00Z' },
			{ id: 'b000002', blob: 'same', committed: '2026-10-02T12:00:00Z' }
		];
		const rules = followHistory([metal], { a000002: { blob: 'same', committed: '2026-10-02T12:00:00Z' } }, rebuilt, () => {});
		expect(rules[0].versions).toEqual([{ until: 'b000002' }]);
		expect(() => followHistory([metal], { a000002: { blob: 'same' } }, rebuilt)).toThrow(/several versions have its STEP file/);
	});

	it('stops when a missing commit has no STEP file recorded, or no version has it', () => {
		const rebuilt = [{ id: 'b000001', blob: 'blob1', committed: '2026-10-01T12:00:00Z' }];
		expect(() => followHistory([metal], {}, rebuilt)).toThrow(/a000002, which is no version of the model$/);
		expect(() => followHistory([metal], { a000002: { blob: 'gone' } }, rebuilt)).toThrow(/no version has its STEP file/);
	});

	it('keeps the STEP file of every commit a rule of models.json names', () => {
		for (const model of Object.values(models as Record<string, ModelConfig>)) {
			const named = (model.materials ?? []).flatMap((rule) => (rule.versions ?? []).flatMap((range) => [range.from, range.until])).filter(Boolean);
			expect(named.filter((id) => !/^[0-9a-f]{40}$/.test(model.commits?.[id!]?.blob ?? ''))).toEqual([]);
		}
	});
});
