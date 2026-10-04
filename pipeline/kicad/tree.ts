// Names in a board export, as the viewer shows them. KiCad names each part's occurrence by its reference (C59, U13);
// the model inside it and the board body carry Open CASCADE's placeholder labels (=>[0:1:1:3]). Placeholders take
// their model's name, the board body (each piece, for an outline in pieces) becomes PCB, and siblings that share a
// name (two parts with one reference) get :2, :3, so every part has a path, and an id, of its own.
import type { Manifest } from '../build-model.ts';
import { PCB_NAME } from '../slot.ts';

const PLACEHOLDER = /^=>\[[\d:]+\]$/;

export function nameTree(manifest: Manifest): Manifest {
	const paths = new Map<string, string>();
	const taken = new Map<string, Map<string, number>>();
	const occurrences = manifest.occurrences.map((occ) => {
		const parent = occ.parent === null ? null : paths.get(occ.parent);
		if (parent === undefined) throw new Error(`${occ.path} comes before its parent`);
		const base = PCB_NAME.test(occ.component) ? 'PCB' : PLACEHOLDER.test(occ.name) ? occ.component : occ.name;
		const siblings = taken.get(parent ?? '') ?? new Map<string, number>();
		taken.set(parent ?? '', siblings);
		const n = (siblings.get(base) ?? 0) + 1;
		siblings.set(base, n);
		const name = n > 1 ? `${base}:${n}` : base;
		const path = parent === null ? name : `${parent}+${name}`;
		paths.set(occ.path, path);
		return { ...occ, name, path, parent };
	});
	const bodies = manifest.bodies.map((body) => ({ ...body, occ: body.occ === null ? null : paths.get(body.occ)! }));
	return { ...manifest, occurrences, bodies };
}

/** The references the export has a part for: the top-level occurrences, without a :n suffix. */
export function exportedRefs(manifest: Manifest) {
	return new Set(manifest.occurrences.filter((o) => o.parent === null && !/^PCB(:\d+)?$/.test(o.name)).map((o) => o.name.replace(/:\d+$/, '')));
}
