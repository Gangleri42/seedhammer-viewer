import { describe, expect, it } from 'vitest';
import { boardParam, chooseBoard, filesFor, openingFiles, revisionLabel } from './boards';
import type { BoardRevision, ModelEntry, ModelVersion } from './types';

const file = (path: string) => ({ path, bytes: 1, sha256: path });
const revision = (id: string, commit: string, date: string): BoardRevision => ({
	id, commit, date, subject: '', glb: file(`board-${id}.glb`), measure: file(`board-${id}.measure.json.gz`), step: file(`board-${id}.step.zip`),
	triangles: 0, bodies: 0, fixups: [], missing: []
});
const version = (n: number, slot = true, bare = false): ModelVersion => ({
	version: n, glb: file(`v${n}.glb`), step: file(`v${n}.zip`), measure: file(`v${n}.measure.json.gz`), triangles: 0, bodies: 0, built: '',
	...(slot ? { slot: { id: 'slot01' } } : {}), ...(bare ? { bare: { glb: file(`v${n}.bare.glb`), measure: file(`v${n}.bare.measure.json.gz`) } } : {})
});
const newest = revision('7ac023b', '31eb662', '2026-10-04T08:50:07Z');
const older = revision('1f00d2e', 'fb6054d', '2026-10-03T10:53:00Z');
const entry: ModelEntry = {
	title: 'Seed', latest: 26, versions: [version(26, true, true), version(22), version(7, false)],
	board: { source: { repo: 'seedhammer/hardware', ref: 'muscle', file: 'seed/pcb/seed.kicad_pcb' }, head: '31eb662', latest: newest.id, revisions: [newest, older] }
};
const [v26, v22, v7] = entry.versions;

describe('which board a view shows', () => {
	it('is the latest board on an unpinned view and the CAD board on a pinned one', () => {
		expect(chooseBoard(entry, v26, null, false).choice).toMatchObject({ kind: 'upstream', revision: { id: '7ac023b' } });
		expect(chooseBoard(entry, v22, null, true).choice).toEqual({ kind: 'cad', possible: true });
	});

	it('is what the link names, on any version with a slot', () => {
		expect(chooseBoard(entry, v22, '1f00d2e', true).choice).toMatchObject({ kind: 'upstream', revision: { id: '1f00d2e' } });
		expect(chooseBoard(entry, v26, 'cad', false).choice).toEqual({ kind: 'cad', possible: true });
	});

	it('is the CAD board where no upstream board fits', () => {
		expect(chooseBoard(entry, v7, '7ac023b', true).choice).toEqual({ kind: 'cad', possible: false });
		expect(chooseBoard({ ...entry, board: undefined }, v26, null, false).choice).toEqual({ kind: 'cad', possible: false });
	});

	it('falls back to the latest board for a revision the index no longer lists, and says so', () => {
		const { choice, missing } = chooseBoard(entry, v22, '0000000', true);
		expect(choice).toMatchObject({ kind: 'upstream', revision: { id: '7ac023b' } });
		expect(missing).toBe('0000000');
	});
});

describe('how a link names the board', () => {
	const latest = chooseBoard(entry, v26, null, false).choice;
	const old = chooseBoard(entry, v26, '1f00d2e', false).choice;
	const cad = chooseBoard(entry, v26, 'cad', false).choice;

	it('leaves the default out', () => {
		expect(boardParam(latest, false)).toBeNull();
		expect(boardParam(cad, true)).toBeNull();
		expect(boardParam(chooseBoard(entry, v7, null, true).choice, false)).toBeNull();
	});

	it('pins the board a pinned link was made with', () => {
		expect(boardParam(latest, true)).toBe('7ac023b');
		expect(boardParam(old, false)).toBe('1f00d2e');
		expect(boardParam(cad, false)).toBe('cad');
	});
});

describe('what a choice loads', () => {
	it('takes the model without its CAD board where the index has one', () => {
		const latest = chooseBoard(entry, v26, null, false).choice;
		expect(filesFor(v26, latest)).toMatchObject({ glb: { path: 'v26.bare.glb' }, board: { id: '7ac023b' }, bare: true });
		expect(filesFor(v22, chooseBoard(entry, v22, '7ac023b', true).choice)).toMatchObject({ glb: { path: 'v22.glb' }, bare: false });
		expect(filesFor(v26, chooseBoard(entry, v26, 'cad', false).choice)).toMatchObject({ glb: { path: 'v26.glb' }, board: null });
	});

	it('opens a model without its CAD board, with the latest board', () => {
		expect(openingFiles(entry).map((f) => f.path)).toEqual(['v26.bare.glb', 'v26.bare.measure.json.gz', 'board-7ac023b.glb', 'board-7ac023b.measure.json.gz']);
		expect(openingFiles({ ...entry, board: undefined }).map((f) => f.path)).toEqual(['v26.glb', 'v26.measure.json.gz']);
	});

	it('labels a revision by commit and UTC day', () => {
		expect(revisionLabel(newest)).toBe('31eb662 · 4 Oct');
	});
});
