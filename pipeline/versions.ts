// Which commits a model's versions come from. A version is named by its commit: its id is the commit's short hash, so
// a pinned link (#/seed@02a4106) shows the same model for as long as the viewer lists it.
//
// Two kinds of file make a version:
// - <folder>/<folder>.step: every commit that adds, changes or renames into it is a new version.
// - <folder>/<Name>-v<n>.step, the older naming: frozen at the commit that added it. A later change to the same file
//   is left out and reported.
//
// Each version also carries the CAD version number it was exported at, for the build only (models.json's `from` and
// `until`): from the old file name, or from the commit subject "Export the <Model> at version <n>". A versionless file
// whose subject says nothing counts as newer than every numbered version. The number never reaches the index.
const LEGACY = /^(.+)-v(\d+)\.step$/i;
const EXPORT = /^Export the (\S+) at version (\d+)$/;

export type VersionSource = {
	/** The commit's short hash: the version's public name. */
	id: string;
	commit: string;
	/** The commit date, UTC, YYYY-MM-DD. */
	date: string;
	path: string;
	/** The CAD version number, for the build's material rules only. */
	number: number;
};
export type IgnoredChange = { commit: string; path: string; reason: 'changed' | 'same commit' };

/** The log format pickVersions reads: full hash, committer time (Unix seconds) and subject. */
export const LOG_FORMAT = '@%H %ct %s';

const utcDay = (seconds: string) => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);

/**
 * Reads `git log --reverse --format='@%H %ct %s' --name-only --diff-filter=AMR -- <folder>`, oldest commit first, and
 * returns the versions newest first. A commit makes at most one version: of two STEP files in one commit the one with
 * the higher number counts and the other is reported.
 */
export function pickVersions(log: string, folder: string): { sources: VersionSource[]; ignored: IgnoredChange[] } {
	const sources: VersionSource[] = [];
	const ignored: IgnoredChange[] = [];
	const frozen = new Set<number>();
	let commit = '', date = '', subject = '';
	for (const line of log.split('\n')) {
		if (line.startsWith('@')) {
			const [hash, time, ...words] = line.slice(1).split(' ');
			commit = hash;
			date = utcDay(time);
			subject = words.join(' ');
			continue;
		}
		if (!line.startsWith(`${folder}/`)) continue;
		const name = line.slice(folder.length + 1);
		if (name.includes('/')) continue;
		let number: number;
		if (name === `${folder}.step`) {
			const exported = EXPORT.exec(subject);
			number = exported && exported[1].toLowerCase() === folder.toLowerCase() ? Number(exported[2]) : Infinity;
		} else {
			const match = LEGACY.exec(name);
			if (!match) continue;
			number = Number(match[2]);
			if (frozen.has(number)) {
				ignored.push({ commit, path: line, reason: 'changed' });
				continue;
			}
			frozen.add(number);
		}
		const source: VersionSource = { id: commit.slice(0, 7), commit, date, path: line, number };
		const previous = sources.at(-1);
		if (previous?.commit !== commit) sources.push(source);
		else if (number > previous.number) {
			ignored.push({ commit, path: previous.path, reason: 'same commit' });
			sources[sources.length - 1] = source;
		} else ignored.push({ commit, path: line, reason: 'same commit' });
	}
	return { sources: sources.reverse(), ignored };
}
