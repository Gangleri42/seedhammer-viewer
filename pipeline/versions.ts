// Which commit each model version comes from. A version is the file <folder>/<Name>-v<n>.step, frozen at the commit
// that added it, so a pinned link (#/seed@7) shows the same model forever. A later change to the same file is left out
// and reported: a new export belongs under a new version number.
const FILE = /^(.+)-v(\d+)\.step$/i;

export type VersionSource = { version: number; commit: string; date: string; path: string };
export type IgnoredChange = { version: number; commit: string; path: string };

/** Reads `git log --reverse --format='@%H %cs' --name-only --diff-filter=AMR -- <folder>`, oldest commit first. */
export function pickVersions(log: string, folder: string): { sources: VersionSource[]; ignored: IgnoredChange[] } {
	const byVersion = new Map<number, VersionSource>();
	const ignored: IgnoredChange[] = [];
	let commit = '', date = '';
	for (const line of log.split('\n')) {
		if (line.startsWith('@')) {
			[commit, date] = line.slice(1).split(' ');
			continue;
		}
		const name = line.slice(folder.length + 1);
		const match = line.startsWith(`${folder}/`) && !name.includes('/') ? FILE.exec(name) : null;
		if (!match) continue;
		const version = Number(match[2]);
		if (byVersion.has(version)) ignored.push({ version, commit, path: line });
		else byVersion.set(version, { version, commit, date, path: line });
	}
	return { sources: [...byVersion.values()].sort((a, b) => b.version - a.version), ignored };
}
