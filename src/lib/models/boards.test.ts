import { describe, expect, it } from 'vitest';
import { boardParam, chooseBoard, filesFor, openingFiles, revisionLabel } from './boards';
import type { BoardRevision, ModelEntry, ModelVersion } from './types';

const file = (path: string) => ({ path, bytes: 1, sha256: path });
const revision = (id: string, commit: string, date: string): BoardRevision => ({
	id, commit, date, subject: '', glb: file(`board-${id}.glb`), measure: file(`board-${id}.measure.json.gz`), step: file(`board-${id}.step.zip`),
	triangles: 0, bodies: 0, fixups: [], missing: []
});
const version = (id: string, date: string, slot = true, bare = false): ModelVersion => ({
	id, date, glb: file(`${id}.glb`), step: file(`seed-${id}.step.zip`), measure: file(`${id}.measure.json.gz`), triangles: 0, bodies: 0,
	...(slot ? { slot: { id: 'slot01' } } : {}), ...(bare ? { bare: { glb: file(`${id}.bare.glb`), measure: file(`${id}.bare.measure.json.gz`) } } : {})
});
const newest = revision('7ac023b', '31eb662', '2026-10-04T08:50:07Z');
const older = revision('1f00d2e', 'fb6054d', '2026-10-03T10:53:00Z');
const entry: ModelEntry = {
	title: 'Seed', latest: 'ec4f1a7', versions: [version('ec4f1a7', '2026-10-08', true, true), version('5b29ec7', '2026-10-04'), version('48c1424', '2026-10-03', false)],
	board: { source: { repo: 'seedhammer/hardware', ref: 'muscle', file: 'seed/pcb/seed.kicad_pcb' }, head: '31eb662', latest: newest.id, revisions: [newest, older] }
};
const [first, second, third] = entry.versions;

describe('which board a view shows', () => {
	it('is the latest board on an unpinned view and the CAD board on a pinned one', () => {
		expect(chooseBoard(entry, first, null, false).choice).toMatchObject({ kind: 'upstream', revision: { id: '7ac023b' } });
		expect(chooseBoard(entry, second, null, true).choice).toEqual({ kind: 'cad', possible: true });
	});

	it('is what the link names, on any version with a slot', () => {
		expect(chooseBoard(entry, second, '1f00d2e', true).choice).toMatchObject({ kind: 'upstream', revision: { id: '1f00d2e' } });
		expect(chooseBoard(entry, first, 'cad', false).choice).toEqual({ kind: 'cad', possible: true });
	});

	it('is the CAD board where no upstream board fits', () => {
		expect(chooseBoard(entry, third, '7ac023b', true).choice).toEqual({ kind: 'cad', possible: false });
		expect(chooseBoard({ ...entry, board: undefined }, first, null, false).choice).toEqual({ kind: 'cad', possible: false });
	});

	it('falls back to the latest board for a revision the index no longer lists, and says so', () => {
		const { choice, missing } = chooseBoard(entry, second, '0000000', true);
		expect(choice).toMatchObject({ kind: 'upstream', revision: { id: '7ac023b' } });
		expect(missing).toBe('0000000');
	});
});

describe('how a link names the board', () => {
	const latest = chooseBoard(entry, first, null, false).choice;
	const old = chooseBoard(entry, first, '1f00d2e', false).choice;
	const cad = chooseBoard(entry, first, 'cad', false).choice;

	it('leaves the default out', () => {
		expect(boardParam(latest, false)).toBeNull();
		expect(boardParam(cad, true)).toBeNull();
		expect(boardParam(chooseBoard(entry, third, null, true).choice, false)).toBeNull();
	});

	it('pins the board a pinned link was made with', () => {
		expect(boardParam(latest, true)).toBe('7ac023b');
		expect(boardParam(old, false)).toBe('1f00d2e');
		expect(boardParam(cad, false)).toBe('cad');
	});
});

describe('what a choice loads', () => {
	it('takes the model without its CAD board where the index has one', () => {
		const latest = chooseBoard(entry, first, null, false).choice;
		expect(filesFor(first, latest)).toMatchObject({ glb: { path: 'ec4f1a7.bare.glb' }, board: { id: '7ac023b' }, bare: true });
		expect(filesFor(second, chooseBoard(entry, second, '7ac023b', true).choice)).toMatchObject({ glb: { path: '5b29ec7.glb' }, bare: false });
		expect(filesFor(first, chooseBoard(entry, first, 'cad', false).choice)).toMatchObject({ glb: { path: 'ec4f1a7.glb' }, board: null });
	});

	it('opens a model without its CAD board, with the latest board', () => {
		expect(openingFiles(entry).map((f) => f.path)).toEqual(['ec4f1a7.bare.glb', 'ec4f1a7.bare.measure.json.gz', 'board-7ac023b.glb', 'board-7ac023b.measure.json.gz']);
		expect(openingFiles({ ...entry, board: undefined }).map((f) => f.path)).toEqual(['ec4f1a7.glb', 'ec4f1a7.measure.json.gz']);
	});

	it('labels a revision by commit and UTC day', () => {
		expect(revisionLabel(newest)).toBe('31eb662 · 4 Oct');
	});
});
