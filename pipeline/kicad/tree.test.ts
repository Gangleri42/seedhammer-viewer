import { describe, expect, it } from 'vitest';
import { gltfJson, partsOf } from '../glb.ts';
import { MemoryIO, partId } from '../stepstr.ts';
import { BOARD_ID_PREFIX, exportedRefs, nameBoard } from './tree.ts';

type Spec = [name: string, component: string | null, children?: Spec[]];

/**
 * A board as stepstr's converter names it: parts by reference, models and the board body after their component, two
 * parts that share a reference (it happens) made unique, and an outline in two pieces. A null component is a body.
 */
const BOARD: Spec[] = [
	['C59', 'C_0402_1005Metric', [['C_0402_1005Metric', 'C_0402_1005Metric', [['C_0402_1005Metric', null]]]]],
	['seed_PCB', 'seed_PCB', [['seed_PCB', null]]],
	['Q3', 'SOT-23', [['SOT-23', 'SOT-23']]],
	['Q3:2', 'SOT-23-5', [['SOT-23-5', 'SOT-23-5', [['SOT-23-5', null]]]]],
	['seed_PCB_2', 'seed_PCB_2']
];

/** The converter's document for `specs`, each id the hash of its path as the converter makes it. */
async function documentOf(specs: Spec[]) {
	const nodes: object[] = [{ name: 'seed 1', children: [] as number[] }];
	const add = (spec: Spec, path: string, parent: { children?: number[] }) => {
		const [name, component, children = []] = spec;
		const own = component === null ? `${path}/${name}` : path ? `${path}+${name}` : name;
		const extras = component === null ? { id: partId(own), name, body: true, solid: 0 } : { id: partId(own), name, component, linked: false, fastener: /SOT/.test(name) };
		const node = { name, extras, children: [] as number[] };
		(parent.children ??= []).push(nodes.push(node) - 1);
		for (const child of children) add(child, own, node);
	};
	for (const spec of specs) add(spec, '', nodes[0]);
	return new MemoryIO().readJSON({ json: { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes }, resources: {} });
}

const parts = async (specs: Spec[]) => {
	const doc = await documentOf(specs);
	nameBoard(doc);
	return partsOf(gltfJson(await new MemoryIO().writeBinary(doc)));
};

describe('board names', () => {
	it('calls the board body PCB, each piece numbered, and leaves the rest as the converter named it', async () => {
		const named = await parts(BOARD);
		expect(named.filter((p) => !p.body).map((p) => p.name)).toEqual(['C59', 'C_0402_1005Metric', 'PCB', 'Q3', 'SOT-23', 'Q3:2', 'SOT-23-5', 'PCB:2']);
		expect(named.filter((p) => p.body).map((p) => p.name)).toEqual(['C_0402_1005Metric', 'seed_PCB', 'SOT-23-5']);
	});

	it('hashes the board prefix and the new path into every id', async () => {
		const named = await parts(BOARD);
		const ids = ['C59', 'C59+C_0402_1005Metric', 'C59+C_0402_1005Metric/C_0402_1005Metric', 'PCB', 'PCB/seed_PCB', 'Q3', 'Q3+SOT-23', 'Q3:2', 'Q3:2+SOT-23-5', 'Q3:2+SOT-23-5/SOT-23-5', 'PCB:2'];
		expect(named.map((p) => p.id)).toEqual(ids.map((path) => partId(BOARD_ID_PREFIX + path)));
	});

	it('counts no part as a fastener', async () => {
		const doc = await documentOf(BOARD);
		nameBoard(doc);
		expect(doc.getRoot().listNodes().filter((n) => (n.getExtras() as { fastener?: boolean }).fastener)).toEqual([]);
	});

	it('lists the references the board has parts for', async () => {
		expect([...exportedRefs(await parts(BOARD))].sort()).toEqual(['C59', 'Q3']);
	});

	it('refuses ids that are not the hash of the converter’s paths', async () => {
		const doc = await documentOf(BOARD);
		doc.getRoot().listNodes()[1].setExtras({ ...doc.getRoot().listNodes()[1].getExtras(), id: 'zzzzzz' });
		expect(() => nameBoard(doc)).toThrow(/not the hash of its path/);
	});
});
