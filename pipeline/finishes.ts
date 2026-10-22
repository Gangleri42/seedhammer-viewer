// The finishes a version's parts take where their CAD colours alone do not show them (models.json, boards.json). STEP
// carries colours, not materials: each rule makes the listed bodies (by body name, or component name for all its
// bodies) metal or glass, as the CAD model shows them; `appearance` names the CAD appearance the rule came from.
// `opacity` sets a glass rule's opacity, which otherwise follows how dark its tint is. stepstr applies the resolved
// rules when it shows the model (viewer/finishes.ts): metal on the faces in the body's own colour, glass over the whole
// body, and for a part the later rule wins.
//
// `versions` limits a rule to stretches of the model's history, for a part whose material changed: each range runs
// from the version `from` names to the one `until` names, both included, by commit id. A range without `from` starts
// at the first version, one without `until` takes in every later one; a rule without `versions` holds for all.
// `commits` in models.json keeps the git blob of each named commit's STEP file: a rebuild of the hardware repository's
// history gives every commit a new id but leaves the files as they were (followHistory).
import type { Finish } from './stepstr.ts';

export type VersionRange = { from?: string; until?: string };
export type FinishRule = Finish & { versions?: VersionRange[] };
/**
 * What finds a commit again after a rebuild of the history: the git blob of its STEP file, and its committer time (UTC,
 * to the second) where another version has the same file.
 */
export type CommitMark = { blob: string; committed?: string };
/** A model as models.json describes it. */
export type ModelConfig = { title: string; folder: string; materials?: FinishRule[]; commits?: Record<string, CommitMark> };

/**
 * The rules with every range named by a version of `history` (oldest first). A commit the history lacks, as after a
 * rebuild of the hardware repository's history, is the version with its STEP file (`commits`), with a warning naming
 * both ids; one that no version, or more than one, matches stops the build.
 */
export function followHistory(
	rules: FinishRule[] | undefined,
	commits: Record<string, CommitMark> = {},
	history: { id: string; blob: string; committed: string }[],
	warn: (message: string) => void = console.warn
): FinishRule[] {
	const ids = new Set(history.map((version) => version.id));
	const found = new Map<string, string>();
	const follow = (commit: string | undefined) => {
		if (commit === undefined || ids.has(commit)) return commit;
		let now = found.get(commit);
		if (!now) {
			const mark = commits[commit];
			const same = mark ? history.filter((version) => version.blob === mark.blob) : [];
			const match = same.length > 1 && mark?.committed ? same.filter((version) => version.committed === mark.committed) : same;
			if (match.length !== 1) {
				const why = !mark ? '' : match.length ? ', and several versions have its STEP file' : ', and no version has its STEP file';
				throw new Error(`a finish rule names ${commit}, which is no version of the model${why}`);
			}
			now = match[0].id;
			warn(`a finish rule names ${commit}, which is no version of the model; ${now} has its STEP file and takes its place`);
			found.set(commit, now);
		}
		return now;
	};
	return (rules ?? []).map((rule) =>
		rule.versions ? { ...rule, versions: rule.versions.map(({ from, until }) => ({ ...(from ? { from: follow(from) } : {}), ...(until ? { until: follow(until) } : {}) })) } : rule
	);
}

/**
 * The rules in force at version `id`, in the catalogue's shape and order. `history` is the model's version ids, oldest
 * first. A range that names no version stops the build: after a rewrite of the history its rules need new ids.
 */
export function resolveFinishes(rules: FinishRule[] | undefined, id: string, history: string[]): Finish[] {
	const position = (commit: string) => {
		const at = history.indexOf(commit);
		if (at < 0) throw new Error(`a finish rule names ${commit}, which is no version of the model`);
		return at;
	};
	const at = position(id);
	const holds = (range: VersionRange) => (range.from === undefined || position(range.from) <= at) && (range.until === undefined || at <= position(range.until));
	return (rules ?? [])
		.filter((rule) => !rule.versions || rule.versions.some(holds))
		.map(({ versions: _versions, ...finish }) => finish);
}

/** The finish of each listed part at version `id`, as the viewer resolves the rules: a later one wins. */
export function finishesFor(rules: FinishRule[] | undefined, id: string, history: string[]) {
	const finishes = new Map<string, Finish>();
	for (const rule of resolveFinishes(rules, id, history)) for (const part of rule.parts) finishes.set(part, rule);
	return finishes;
}
