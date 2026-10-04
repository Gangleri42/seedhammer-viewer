import { describe, expect, it } from 'vitest';
import type { Manifest } from '../build-model.ts';
import { exportedRefs, nameTree } from './tree.ts';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const occ = (path: string, parent: string | null, name: string, component: string) => ({ path, parent, name, component, linked: false, matrix: I });

// As step_to_manifest.py reads a KiCad export: parts by reference, models and the board body by placeholder, and two
// parts that share a reference (it happens).
const manifest: Manifest = {
	doc: 'seed 1', version: 0, units: 'mm', appearances: {}, fastener_partners: {}, meshes: [],
	occurrences: [
		occ('C59', null, 'C59', 'C_0402_1005Metric'),
		occ('C59+=>[0:1:1:3]', 'C59', '=>[0:1:1:3]', 'C_0402_1005Metric'),
		occ('=>[0:1:1:42]', null, '=>[0:1:1:42]', 'seed_PCB'),
		occ('Q3', null, 'Q3', 'SOT-23'),
		occ('Q3+=>[0:1:1:9]', 'Q3', '=>[0:1:1:9]', 'SOT-23'),
		occ('Q3', null, 'Q3', 'SOT-23-5'),
		occ('Q3+=>[0:1:1:11]', 'Q3', '=>[0:1:1:11]', 'SOT-23-5'),
		occ('=>[0:1:1:44]', null, '=>[0:1:1:44]', 'seed_PCB_2')
	],
	bodies: [
		{ occ: 'C59+=>[0:1:1:3]', body: 'C_0402_1005Metric', mesh: 0, appearance: null },
		{ occ: '=>[0:1:1:42]', body: 'seed_PCB', mesh: 1, appearance: null },
		{ occ: 'Q3+=>[0:1:1:11]', body: 'SOT-23-5', mesh: 2, appearance: null }
	]
};

describe('board names', () => {
	const named = nameTree(manifest);

	it('names models after themselves, the body PCB, and numbers parts that share a reference', () => {
		expect(named.occurrences.map((o) => [o.path, o.parent])).toEqual([
			['C59', null],
			['C59+C_0402_1005Metric', 'C59'],
			['PCB', null],
			['Q3', null],
			['Q3+SOT-23', 'Q3'],
			['Q3:2', null],
			['Q3:2+SOT-23-5', 'Q3:2'],
			['PCB:2', null]
		]);
	});

	it('moves the bodies along', () => {
		expect(named.bodies.map((b) => b.occ)).toEqual(['C59+C_0402_1005Metric', 'PCB', 'Q3:2+SOT-23-5']);
	});

	it('lists the references the export has parts for', () => {
		expect([...exportedRefs(named)].sort()).toEqual(['C59', 'Q3']);
	});

	it('refuses an occurrence listed before its parent', () => {
		expect(() => nameTree({ ...manifest, occurrences: [manifest.occurrences[1], manifest.occurrences[0]] })).toThrow(/before its parent/);
	});
});
