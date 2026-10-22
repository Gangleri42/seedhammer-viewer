// Which commits a model's versions come from: every one that changed its STEP file. A version is named by its commit:
// its id is the commit's short hash, so a pinned link (#/seed@02a4106) shows the same model for good.
//
// Two kinds of file make a version:
// - <folder>/<folder>.step: every commit that adds, changes or renames into it is a new version.
// - <folder>/<Name>-v<n>.step, the older naming: frozen at the commit that added it. A later change to the same file
//   is left out and reported.
import { execFileSync } from 'node:child_process';

const OLD_NAME = /^.+-v\d+\.step$/i;

export type VersionSource = {
	/** The commit's short hash: the version's public name. */
	id: string;
	commit: string;
	/** The commit date, UTC, YYYY-MM-DD. */
	date: string;
	/** The commit's committer time, UTC, to the second: with the subject, what survives a rewrite of the history. */
	committed: string;
	subject: string;
	path: string;
};
export type IgnoredChange = { commit: string; path: string; reason: 'changed' | 'same commit' };

/** The log format pickVersions reads: full hash, committer time (Unix seconds) and subject. */
export const LOG_FORMAT = '@%H %ct %s';

const utc = (seconds: string) => new Date(Number(seconds) * 1000).toISOString().replace('.000', '');

/** Of two STEP files in one commit, the one that makes the version: <folder>.step, else the later name. */
const preferred = (a: string, b: string, current: string) =>
	a === current ? a : b === current ? b : a.localeCompare(b, 'en', { numeric: true }) > 0 ? a : b;

/**
 * Reads `git log --reverse --format='@%H %ct %s' --name-only --diff-filter=AMR -- <folder>`, oldest commit first, and
 * returns the versions newest first. A commit makes at most one version (preferred); another STEP file of the same
 * commit is reported.
 */
export function pickVersions(log: string, folder: string): { sources: VersionSource[]; ignored: IgnoredChange[] } {
	const sources: VersionSource[] = [];
	const ignored: IgnoredChange[] = [];
	const frozen = new Set<string>();
	const current = `${folder}/${folder}.step`;
	let commit = '', committed = '', subject = '';
	for (const line of log.split('\n')) {
		if (line.startsWith('@')) {
			const [hash, time, ...words] = line.slice(1).split(' ');
			commit = hash;
			committed = utc(time);
			subject = words.join(' ');
			continue;
		}
		if (!line.startsWith(`${folder}/`)) continue;
		const name = line.slice(folder.length + 1);
		if (name.includes('/')) continue;
		if (line !== current) {
			if (!OLD_NAME.test(name)) continue;
			if (frozen.has(line)) {
				ignored.push({ commit, path: line, reason: 'changed' });
				continue;
			}
			frozen.add(line);
		}
		const source: VersionSource = { id: commit.slice(0, 7), commit, date: committed.slice(0, 10), committed, subject, path: line };
		const previous = sources.at(-1);
		if (previous?.commit !== commit) sources.push(source);
		else if (preferred(previous.path, line, current) === line) {
			ignored.push({ commit, path: previous.path, reason: 'same commit' });
			sources[sources.length - 1] = source;
		} else ignored.push({ commit, path: line, reason: 'same commit' });
	}
	return { sources: sources.reverse(), ignored };
}

/** A version with the git blob of its STEP file. */
export type Version = VersionSource & { blob: string };

/** Every version of the model in `folder` of the hardware clone `repo`, newest first; changes left out are reported. */
export function listVersions(repo: string, folder: string): Version[] {
	const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
	const { sources, ignored } = pickVersions(git('log', '--reverse', `--format=${LOG_FORMAT}`, '--name-only', '--diff-filter=AMR', '--', folder), folder);
	for (const change of ignored) {
		console.warn(change.reason === 'changed'
			? `${change.path} changed in ${change.commit.slice(0, 7)}; it stays as first published. Export changes to ${folder}/${folder}.step.`
			: `${change.path} in ${change.commit.slice(0, 7)}: another STEP file of that commit is the version`);
	}
	return sources.map((source) => ({ ...source, blob: git('rev-parse', `${source.commit}:${source.path}`) }));
}
