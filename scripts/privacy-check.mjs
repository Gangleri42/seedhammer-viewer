#!/usr/bin/env node
// Refuses private data before it leaves this machine, and again in CI and on the forge. See privacy-rules.mjs.
//
//   --staged              files staged for commit (pre-commit hook)
//   --message <file>      a commit message (commit-msg hook)
//   --push                commits being pushed, read from stdin as git gives them to pre-push: messages, UTC dates
//                         and the pushed tree
//   --tree <rev>          every file in a tree (CI, forge)
//   --history <rev>       every commit message and date reachable from rev (CI, forge)
//
// Reports name the rule and the place, never the matched text. Exit status 1 when anything is found.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findPrivate, privateTerms } from './privacy-rules.mjs';

const BINARY = /\.(glb|zip|png|jpe?g|webp|ico|bin|woff2?|gz)$/i;
const ZERO = /^0+$/;

const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { maxBuffer: 1 << 30 });
const terms = privateTerms();
/** @type {string[]} */
const problems = [];
/** @param {string} where @param {{ rule: string, line: number }[]} findings */
const report = (where, findings) => {
	for (const { rule, line } of findings) problems.push(`${where}${line ? `:${line}` : ''}: ${rule}`);
};

/** @param {string} label @param {Buffer} bytes */
function checkFile(label, bytes) {
	if (BINARY.test(label)) return;
	report(label, findPrivate(bytes.toString('latin1'), terms));
}

/** @param {string} rev */
function checkTree(rev) {
	for (const path of git('ls-tree', '-r', '-z', '--name-only', rev).toString('utf8').split('\0').filter(Boolean)) {
		checkFile(`${rev}:${path}`, git('show', `${rev}:${path}`));
	}
}

/** @param {string} sha */
function checkCommit(sha) {
	const short = sha.slice(0, 7);
	report(`commit ${short} message`, findPrivate(git('log', '-1', '--format=%B', sha).toString('utf8'), terms));
	const [author, committer] = git('log', '-1', '--format=%ad%n%cd', '--date=raw', sha).toString('utf8').trim().split('\n');
	for (const [who, raw] of [['author', author], ['committer', committer]]) {
		if (!raw.endsWith(' +0000')) problems.push(`commit ${short}: ${who} date is not UTC (${raw.split(' ')[1]}); commit with TZ=UTC`);
	}
	report(`commit ${short} author`, findPrivate(git('log', '-1', '--format=%an <%ae>%n%cn <%ce>', sha).toString('utf8'), terms));
}

const argv = process.argv.slice(2);
const value = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1];

if (argv.includes('--staged')) {
	const staged = git('diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMR').toString('utf8').split('\0').filter(Boolean);
	for (const path of staged) checkFile(path, git('show', `:${path}`));
}
if (argv.includes('--message')) {
	// git strips comment lines after this hook runs; they never reach the commit.
	const text = readFileSync(value('--message'), 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n');
	report('commit message', findPrivate(text, terms));
}
if (argv.includes('--push')) {
	for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
		const [, local, , remote] = line.split(' ');
		if (ZERO.test(local)) continue; // a deletion pushes nothing
		const range = ZERO.test(remote) ? [local, '--not', '--remotes'] : [`${remote}..${local}`];
		for (const sha of git('rev-list', ...range).toString('utf8').split('\n').filter(Boolean)) checkCommit(sha);
		checkTree(local);
	}
}
if (argv.includes('--tree')) checkTree(value('--tree'));
if (argv.includes('--history')) {
	for (const sha of git('rev-list', value('--history')).toString('utf8').split('\n').filter(Boolean)) checkCommit(sha);
}

if (problems.length) {
	console.error(`privacy check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
	process.exit(1);
}
