import { describe, expect, it } from 'vitest';
import { finishesFor, type ModelConfig } from './build-model.ts';
import models from './models.json' with { type: 'json' };

const metal = { appearance: 'chrome', kind: 'metal' as const, parts: ['housing'], until: 21 };
const glass = { appearance: 'clear', kind: 'glass' as const, parts: ['housing'], from: 22 };

describe('finishes by version', () => {
	it('applies an entry only inside its version range, bounds included', () => {
		expect(finishesFor([metal, glass], 21).get('housing')?.kind).toBe('metal');
		expect(finishesFor([metal, glass], 22).get('housing')?.kind).toBe('glass');
		expect(finishesFor([metal], 22).has('housing')).toBe(false);
		expect(finishesFor([glass], 21).has('housing')).toBe(false);
	});

	it('applies an entry without bounds to every version, and a later entry wins', () => {
		const always = { appearance: 'steel', kind: 'metal' as const, parts: ['housing', 'screw'] };
		expect(finishesFor([always], 1).get('screw')?.kind).toBe('metal');
		expect(finishesFor([always, glass], 30).get('housing')?.kind).toBe('glass');
		expect(finishesFor(undefined, 1).size).toBe(0);
	});

	it('shows the Seed housing as black chrome up to v21 and as clear glass from v22', () => {
		const seed = (models as Record<string, ModelConfig>).seed.materials;
		expect(finishesFor(seed, 20).get('Skeleton')).toMatchObject({ kind: 'metal', appearance: 'Chrom - Schwarz' });
		expect(finishesFor(seed, 22).get('Skeleton')).toMatchObject({ kind: 'glass', appearance: 'Polykarbonat (klar)', opacity: 0.4 });
	});
});
