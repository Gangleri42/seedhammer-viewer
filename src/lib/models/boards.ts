// Which board a view shows, and how its link names it. A model with an upstream board track shows its latest board on
// an unpinned view (the newest of everything) and its CAD board on a pinned one, which is what every pinned link showed
// before boards came along. A link's b= overrides either.
import type { BoardRevision, BoardSlot, BoardTrack, ModelEntry, ModelFile, ModelVersion } from './types';

export type BoardChoice =
	/** `possible`: an upstream board could go here (the version has a slot and the model a track). */
	| { kind: 'cad'; possible: boolean }
	| { kind: 'upstream'; revision: BoardRevision; track: BoardTrack; slot: BoardSlot };

/**
 * The board to show. `missing` names a revision the link asks for and the index no longer lists (upstream rewrote its
 * history, or the index keeps fewer): the latest board stands in for it.
 */
export function chooseBoard(entry: ModelEntry, version: ModelVersion, board: string | null, pinned: boolean): { choice: BoardChoice; missing?: string } {
	const track = entry.board;
	const latest = track?.revisions.find((r) => r.id === track.latest);
	if (!track || !version.slot || !latest) return { choice: { kind: 'cad', possible: false } };
	const wanted = board ?? (pinned ? 'cad' : latest.id);
	if (wanted === 'cad') return { choice: { kind: 'cad', possible: true } };
	const revision = track.revisions.find((r) => r.id === wanted);
	const choice = { kind: 'upstream' as const, revision: revision ?? latest, track, slot: version.slot };
	return revision ? { choice } : { choice, missing: wanted };
}

/** What a link writes for `choice` on a pinned or an unpinned view: nothing where the default shows the same board. */
export function boardParam(choice: BoardChoice, pinned: boolean): string | null {
	if (choice.kind === 'cad') return choice.possible && !pinned ? 'cad' : null;
	return !pinned && choice.revision.id === choice.track.latest ? null : choice.revision.id;
}

/**
 * The files a choice loads: the model, and the board for its slot. With an upstream board the model comes without its
 * CAD board where the index has that file (the latest version); otherwise the viewer clears the slot itself.
 */
export function filesFor(version: ModelVersion, choice: BoardChoice): { glb: ModelFile; measure?: ModelFile; board: BoardRevision | null; bare: boolean } {
	if (choice.kind === 'cad') return { glb: version.glb, measure: version.measure, board: null, bare: false };
	if (version.bare) return { glb: version.bare.glb, measure: version.bare.measure, board: choice.revision, bare: true };
	return { glb: version.glb, measure: version.measure, board: choice.revision, bare: false };
}

/** "31eb662 · 4 Oct" for a picker, in UTC like the dates it comes from. */
export function revisionLabel(revision: BoardRevision) {
	const date = new Date(revision.date);
	const day = Number.isNaN(date.getTime()) ? '' : ` · ${date.getUTCDate()} ${date.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
	return `${revision.commit}${day}`;
}

/** The files a model opens with (its latest version, unpinned, with the default board), measurement files included. */
export function openingFiles(entry: ModelEntry): ModelFile[] {
	const latest = entry.versions.find((v) => v.version === entry.latest) ?? entry.versions[0];
	const files = filesFor(latest, chooseBoard(entry, latest, null, false).choice);
	return [files.glb, files.measure, files.board?.glb, files.board?.measure].filter((file): file is ModelFile => !!file);
}
