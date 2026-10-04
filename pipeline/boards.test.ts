import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { candidates } from './boards.ts';
import { BOARD } from './kicad/fixture.ts';

const FILE = 'seed/pcb/seed.kicad_pcb';
// The fixture's U13 model, as a repository model the export reads.
const board = (text: string) => text.replace('/opt/work/hardware/lib/RSE0010A.stp', '${KIPRJMOD}/../../lib/RSE0010A.stp');

let dir = '';
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', TZ: 'UTC' } });
const sha: Record<string, string> = {};

function commit(name: string, files: Record<string, string>, date: string) {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(`${dir}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
		writeFileSync(`${dir}/${path}`, text);
	}
	git('add', '-A');
	execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', name], {
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
	});
	sha[name] = git('rev-parse', 'HEAD').trim();
}

// The upstream history the tests read, oldest first.
beforeAll(() => {
	dir = mkdtempSync(`${tmpdir()}/boards-`);
	git('init', '-q', '-b', 'muscle');
	commit('first board', { [FILE]: board(BOARD), 'lib/RSE0010A.stp': 'model 1', 'lib/other.step': 'x' }, '2026-09-10T08:00:00Z');
	commit('route it', { [FILE]: board(BOARD).replace('(segment (start 1 1)', '(segment (start 5 5)') }, '2026-09-12T08:00:00Z');
	commit('move L6', { [FILE]: board(BOARD).replace('(at 40 30)', '(at 41 30)') }, '2026-09-13T08:00:00Z');
	commit('new U13 model', { 'lib/RSE0010A.stp': 'model 2' }, '2026-09-14T08:00:00Z');
	commit('unrelated model', { 'lib/other.step': 'y' }, '2026-09-15T09:30:00Z');
	commit('docs', { 'README.md': 'hi' }, '2026-09-16T08:00:00Z');
});

describe('board revisions', () => {
	it('are the commits whose 3D inputs changed, oldest first, in UTC', () => {
		const found = candidates(git, sha.docs, { file: FILE });
		expect(found.map((c) => c.subject)).toEqual(['first board', 'move L6', 'new U13 model']);
		expect(found.map((c) => c.sha)).toEqual([sha['first board'], sha['move L6'], sha['new U13 model']]);
		expect(found[0].date).toBe('2026-09-10T08:00:00Z');
		expect(new Set(found.map((c) => c.id)).size).toBe(3);
		for (const c of found) expect(c.id).toMatch(/^[0-9a-f]{7}$/);
	});

	it('keep their ids when history is rewritten', () => {
		const ids = candidates(git, sha.docs, { file: FILE }).map((c) => c.id);
		// The same trees under new commits, as after a rebase or a force-push.
		let parent = '';
		for (const name of ['first board', 'route it', 'move L6', 'new U13 model']) {
			const tree = git('rev-parse', `${sha[name]}^{tree}`).trim();
			parent = execFileSync('git', ['-C', dir, '-c', 'user.name=u', '-c', 'user.email=u@example.com', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `${name}, rebased`], {
				encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' }
			}).trim();
		}
		expect(candidates(git, parent, { file: FILE }).map((c) => c.id)).toEqual(ids);
	});

	it('start at `since`', () => {
		expect(candidates(git, sha.docs, { file: FILE, since: '2026-09-13' }).map((c) => c.subject)).toEqual(['move L6', 'new U13 model']);
	});
});
