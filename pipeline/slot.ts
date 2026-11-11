// Where a board goes in an enclosure: the part it takes the place of. Each Fusion export holds its PCB as one
// sub-assembly, the slot, around the KiCad board body. Only the model's own board counts: the Hammer holds the Seed,
// board and all, and the Seed's board is not the Hammer's slot. A model whose PCB is modelled in CAD itself has no
// KiCad board body; boards.json can name that part instead (`slot`). How a board sits in the slot is the viewer's to
// work out when it opens one, from both models (stepstr's viewer/companion.ts), so any board goes into any version.
import type { Part } from './glb.ts';

/** KiCad names the board body <board>_PCB, or <board>_PCB_1, _2... when the outline has separate pieces. */
export const PCB_NAME = /_PCB(?:_\d+)?$/;

/** A part modelled in CAD that a board takes the place of, by its component name (boards.json). */
export type PartSlot = { part: string };

export const boardBodies = (parts: Part[]) => parts.filter((part) => part.body && PCB_NAME.test(part.name));

/**
 * The sub-assembly around the bodies of `board` (the board file's name: muscle for muscle.kicad_pcb, whose body is
 * muscle_PCB, or muscle_export_PCB from an export copy), when they all sit in one.
 */
export function findSlot(parts: Part[], board: string): Part | null {
	const pcbs = boardBodies(parts).filter((b) => b.name.startsWith(`${board}_`));
	if (!pcbs.length || pcbs.some((b) => b.parent === null)) return null;
	// KiCad's board body is an occurrence of its own inside the board component.
	const slots = new Set(pcbs.map((b) => {
		const holder = b.parent!;
		return PCB_NAME.test(holder.component ?? '') && holder.parent ? holder.parent : holder;
	}));
	return slots.size === 1 ? [...slots][0] : null;
}

/** The one occurrence of `component` with bodies below it, or null when the model has none or several. */
export function findPart(parts: Part[], component: string): Part | null {
	const found = parts.filter((p) => !p.body && p.component === component);
	if (found.length !== 1) return null;
	const below = (p: Part) => {
		for (let at = p.parent; at; at = at.parent) if (at === found[0]) return true;
		return false;
	};
	return parts.some((p) => p.body && below(p)) ? found[0] : null;
}
