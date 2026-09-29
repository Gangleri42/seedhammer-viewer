import { sameRef, type MeasureRef } from '$lib/state/hash';

/**
 * The selections after a click. Empty space changes nothing; a selected item is taken out again; a third pick replaces
 * the second, so one reference can be measured against several others in turn.
 */
export function nextSelection(current: MeasureRef[], picked: MeasureRef | null): MeasureRef[] {
	if (!picked) return current;
	const i = current.findIndex((ref) => sameRef(ref, picked));
	if (i >= 0) return current.filter((_, j) => j !== i);
	return current.length < 2 ? [...current, picked] : [current[0], picked];
}
