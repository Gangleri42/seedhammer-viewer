// Names in a board, as the viewer has always shown them. KiCad names each part's occurrence by its reference (C59,
// U13); the model inside it and the board body carry Open CASCADE's placeholder labels (=>[0:1:1:3]), which stepstr's
// converter names after their component, making siblings that share a name unique with :2, :3. Two things are the
// viewer's own: the board body's occurrence (each piece's, for an outline in pieces) is called PCB, and every part id
// hashes BOARD_ID_PREFIX in front of the part's path, so a board's ids never meet an enclosure's. Links made before
// stepstr name board parts by those ids. No part counts as a fastener: KiCad names such as Screw_Terminal would.
import type { Part } from '../glb.ts';
import { PCB_NAME } from '../slot.ts';
import { partId, type MemoryIO } from '../stepstr.ts';

/** Hashed in front of a board part's path: Fusion names hold no NUL, so a board id never equals an enclosure id. */
export const BOARD_ID_PREFIX = '\0board\0';

type Doc = Awaited<ReturnType<MemoryIO['readBinary']>>;
type Node = ReturnType<ReturnType<Doc['getRoot']>['listNodes']>[number];
type Extras = { id: string; name: string; component?: string; body?: boolean; fastener?: boolean };

/**
 * Renames the board's parts in the converter's document and gives them the board's ids. Each id the converter wrote
 * is checked against the path it is rebuilt from, so a converter that names paths another way stops the build instead
 * of renaming parts by guesswork.
 */
export function nameBoard(doc: Doc) {
	const visit = (node: Node, path: string, renamed: string) => {
		let pcbs = 0;
		for (const child of node.listChildren()) {
			const extras = child.getExtras() as Extras;
			const own = extras.body ? `${path}/${extras.name}` : path ? `${path}+${extras.name}` : extras.name;
			if (partId(own) !== extras.id) throw new Error(`${extras.name}: its id is not the hash of its path`);
			const name = !extras.body && PCB_NAME.test(extras.component ?? '') ? (++pcbs > 1 ? `PCB:${pcbs}` : 'PCB') : extras.name;
			const next = extras.body ? `${renamed}/${name}` : renamed ? `${renamed}+${name}` : name;
			child.setName(name).setExtras({ ...extras, id: partId(BOARD_ID_PREFIX + next), name, ...(extras.body ? {} : { fastener: false }) });
			visit(child, own, next);
		}
	};
	// The scene's node is the file's root, named after it; the parts are below.
	for (const root of doc.getRoot().listScenes().flatMap((scene) => scene.listChildren())) visit(root, '', '');
}

/** The references the board has a part for: the top-level occurrences, without a :n suffix. */
export function exportedRefs(parts: Part[]) {
	return new Set(parts.filter((p) => p.parent === null && !p.body && !/^PCB(:\d+)?$/.test(p.name)).map((p) => p.name.replace(/:\d+$/, '')));
}
