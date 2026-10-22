// The checks as the hooks and CI run them, in a scratch repository: what they read, and what they leave alone.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./privacy-check.mjs', import.meta.url));
// A term of its own, so the real private terms file is never read.
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', PRIVATE_TERMS: 'a-term-nothing-here-uses' };
const DATE = '2026-10-01T12:00:00 +0000';

let dir = '';
const git = (...args: string[]) =>
	execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
		encoding: 'utf8',
		env: { ...env, GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE }
	}).trim();
const check = (args: string[], input?: string) => {
	const run = spawnSync('node', [SCRIPT, ...args], { cwd: dir, env, input, encoding: 'utf8' });
	return { ok: run.status === 0, report: run.stderr };
};
const pushed = (sha: string) => `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;

let pointer = '';
let withBody = '';
beforeAll(() => {
	dir = mkdtempSync(`${tmpdir()}/privacy-`);
	git('init', '-q', '-b', 'main');
	writeFileSync(`${dir}/README.md`, 'hello\n');
	git('add', 'README.md');
	// A submodule pointer: git show cannot read it as a file.
	git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},stepstr`);
	git('commit', '-q', '-m', 'Pin a submodule');
	pointer = git('rev-parse', 'HEAD');
	writeFileSync(`${dir}/notes.txt`, 'notes\n');
	git('add', 'notes.txt');
	git('commit', '-q', '-m', 'Add notes', '-m', 'Signed-off-by: t <t@example.com>');
	withBody = git('rev-parse', 'HEAD');
});

describe('privacy check', () => {
	it('reads a tree and the staged files past a submodule pointer', () => {
		expect(check(['--tree', pointer])).toEqual({ ok: true, report: '' });
		git('update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},stepstr`);
		expect(check(['--staged'])).toEqual({ ok: true, report: '' });
	});

	it('still finds private data in a tree', () => {
		writeFileSync(`${dir}/leak.txt`, `/Us${'ers'}/jane/model.step\n`);
		git('add', 'leak.txt');
		const found = check(['--staged']);
		expect(found.ok).toBe(false);
		expect(found.report).toContain('leak.txt:1: local path');
		git('rm', '-q', '--cached', 'leak.txt');
	});

	it('wants a subject line alone in a new message, below the scissors line ignored', () => {
		const message = `${dir}/MSG`;
		writeFileSync(message, 'Fix a thing\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+more lines\n');
		expect(check(['--message', message]).ok).toBe(true);
		writeFileSync(message, 'Fix a thing\n\nBecause it was broken.\n');
		expect(check(['--message', message]).report).toContain('more than a subject line');
	});

	it('wants it in every commit pushed, but not in the published history', () => {
		expect(check(['--push'], pushed(withBody)).report).toContain(`commit ${withBody.slice(0, 7)}: the message has more than a subject line`);
		expect(check(['--push'], pushed(pointer)).ok).toBe(true);
		expect(check(['--history', withBody])).toEqual({ ok: true, report: '' });
	});
});
