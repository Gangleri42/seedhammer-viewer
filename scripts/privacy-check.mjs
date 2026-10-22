#!/usr/bin/env node
// Refuses private data before it leaves this machine, and again in CI and in every build. See privacy-rules.mjs.
//
//   --staged              files staged for commit (pre-commit hook)
//   --message <file>      a commit message (commit-msg hook)
//   --push                commits being pushed, read from stdin as git gives them to pre-push: messages, UTC dates
//                         and the pushed tree
//   --tree <rev>          every file in a tree (CI, builds)
//   --history <rev>       every commit message and date reachable from rev (CI, builds)
//
// Reports name the rule and the place, never the matched text. A new commit message, and every commit pushed, must
// also be a subject line alone; --history leaves that out, since commits published before the rule have bodies.
// Exit status 1 when anything is found.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findPrivate, privateTerms, subjectOnly } from './privacy-rules.mjs';

const BINARY = /\.(glb|zip|png|jpe?g|webp|ico|bin|woff2?|gz)$/i;
const ZERO = /^0+$/;
const SCISSORS = /^# -{24} >8 -{24}$/m;

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
	// An entry of type "commit" is a submodule: a pointer to another repository, not a file to read.
	for (const entry of git('ls-tree', '-r', '-z', rev).toString('utf8').split('\0').filter(Boolean)) {
		const [meta, path] = entry.split('\t');
		if (meta.split(' ')[1] !== 'blob') continue;
		checkFile(`${rev}:${path}`, git('show', `${rev}:${path}`));
	}
}

/** @param {string} sha @param {{ subject: boolean }} rules */
function checkCommit(sha, { subject }) {
	const short = sha.slice(0, 7);
	const message = git('log', '-1', '--format=%B', sha).toString('utf8');
	report(`commit ${short} message`, findPrivate(message, terms));
	if (subject && !subjectOnly(message)) problems.push(`commit ${short}: the message has more than a subject line`);
	const [author, committer] = git('log', '-1', '--format=%ad%n%cd', '--date=raw', sha).toString('utf8').trim().split('\n');
	for (const [who, raw] of [['author', author], ['committer', committer]]) {
		if (!raw.endsWith(' +0000')) problems.push(`commit ${short}: ${who} date is not UTC (${raw.split(' ')[1]}); commit with TZ=UTC`);
	}
	report(`commit ${short} author`, findPrivate(git('log', '-1', '--format=%an <%ae>%n%cn <%ce>', sha).toString('utf8'), terms));
}

const argv = process.argv.slice(2);
const value = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1];

if (argv.includes('--staged')) {
	// --raw gives each entry's new mode before its path; 160000 is a submodule pointer, not a file to read.
	const raw = git('diff', '--cached', '--raw', '-z', '--no-renames', '--diff-filter=ACMR').toString('utf8').split('\0').filter(Boolean);
	for (let i = 0; i + 1 < raw.length; i += 2) {
		if (raw[i].split(' ')[1] === '160000') continue;
		checkFile(raw[i + 1], git('show', `:${raw[i + 1]}`));
	}
}
if (argv.includes('--message')) {
	// git strips comment lines after this hook runs, and with `commit -v` the diff below the scissors line; they never
	// reach the commit.
	const text = readFileSync(value('--message'), 'utf8').split(SCISSORS)[0].split('\n').filter((line) => !line.startsWith('#')).join('\n');
	report('commit message', findPrivate(text, terms));
	if (!subjectOnly(text)) problems.push('commit message: more than a subject line; commit with the subject alone');
}
if (argv.includes('--push')) {
	for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
		const [, local, , remote] = line.split(' ');
		if (ZERO.test(local)) continue; // a deletion pushes nothing
		const range = ZERO.test(remote) ? [local, '--not', '--remotes'] : [`${remote}..${local}`];
		for (const sha of git('rev-list', ...range).toString('utf8').split('\n').filter(Boolean)) checkCommit(sha, { subject: true });
		checkTree(local);
	}
}
if (argv.includes('--tree')) checkTree(value('--tree'));
if (argv.includes('--history')) {
	for (const sha of git('rev-list', value('--history')).toString('utf8').split('\n').filter(Boolean)) checkCommit(sha, { subject: false });
}

if (problems.length) {
	console.error(`privacy check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
	process.exit(1);
}
