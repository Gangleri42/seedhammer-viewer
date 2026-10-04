// The board track: the upstream revisions of a model's PCB (github.com/seedhammer/hardware, KiCad), each exported
// with kicad-cli the way the boards go into Fusion (kicad/export.ts), converted like the enclosures and published as
// a GLB, measure file and STEP of its own. The viewer puts the chosen revision into the enclosure's board slot
// (slot.ts).
//
// A revision is a commit whose 3D inputs changed: the board file without tracks and zones (kicad/board.ts shapeText)
// plus the repository models it uses. Its id hashes those inputs, so it survives a rebase and a KiCad upgrade;
// consecutive commits whose exports come out identical are one revision. A commit that fails is skipped and
// reported. Boards never stop the enclosures from building.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BoardRevision, BoardTrack } from '../src/lib/models/types.ts';
import { buildModel, type ModelConfig } from './build-model.ts';
import { libraryRefs, shapeText, type Fixups } from './kicad/board.ts';
import { exportRevision, type Exported, type Kicad } from './kicad/export.ts';
import { exportedRefs, nameTree } from './kicad/tree.ts';
import { fileEntry, sha256 } from './manifest.ts';
import { assertPublic } from './privacy.ts';
import { boardBodies, pcbFacts, type PcbFacts } from './slot.ts';

export type { Kicad };

export type BoardConfig = {
	repo: string;
	ref: string;
	file: string;
	/** Commits before this day (YYYY-MM-DD) are not revisions. */
	since?: string;
	/** How many revisions the index lists, newest first. */
	keep?: number;
	/** The model's simplify error unless set. */
	simplifyError?: number;
	materials?: ModelConfig['materials'];
	fixups?: Fixups;
};

export type BoardContext = {
	/** Full clone of the board repository. */
	upstream: string;
	cache: string;
	/** Where published files go (static/models). */
	out: string;
	pipelineHash: string;
	convert: string[];
	kicad: Kicad;
};

/** Hashed in front of a board part's path: Fusion names hold no NUL, so a board id never equals an enclosure id. */
export const BOARD_ID_PREFIX = '\0board\0';

const BUILD_CODE = ['pipeline/boards.ts', 'pipeline/kicad/tree.ts', 'pipeline/slot.ts'];
let buildCode = '';
const EPOCH = new Date('2020-01-01T00:00:00Z');
/** The board builds this run used, below .cache/models/<pipeline hash>: build-all prunes the rest. */
export const usedBuilds = new Set<string>();

export type Candidate = { sha: string; date: string; subject: string; id: string; text: string };

/** A failure as the public index may say it: errors can quote paths, so anything the privacy rules catch is replaced. */
function publicReason(reason: string) {
	try {
		assertPublic('board failure', reason);
		return reason;
	} catch {
		return 'the export failed; the build log names the step';
	}
}
type Built = { bodies: number; triangles: number; facts: PcbFacts; missing: string[] };

function resolve(git: (...args: string[]) => string, ref: string) {
	for (const name of [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`]) {
		try {
			return git('rev-parse', '--verify', '--quiet', `${name}^{commit}`).trim();
		} catch {
			// not this one
		}
	}
	throw new Error(`no branch ${ref} in the board repository`);
}

/** The newest commit on `head` that touched the board or the repository's lib: what CI compares to see a change. */
export function lastChange(git: (...args: string[]) => string, head: string, file: string) {
	return git('log', '-1', '--format=%H', head, '--', posix.dirname(file), 'lib').trim() || head;
}

/**
 * Every commit since `since` whose 3D inputs differ from the commit before, oldest first. Only `since` bounds the
 * work: each candidate is exported once and cached, and the index keeps the newest `keep` of those that differ.
 */
export function candidates(git: (...args: string[]) => string, head: string, config: Pick<BoardConfig, 'file' | 'since'>): Candidate[] {
	const boardDir = posix.dirname(config.file);
	const log = git('log', '--reverse', '--format=%H%x09%ct%x09%s', ...(config.since ? [`--since=${config.since}T00:00:00Z`] : []), head, '--', boardDir, 'lib');
	const found: Candidate[] = [];
	let previous = '';
	for (const line of log.split('\n').filter(Boolean)) {
		const [sha, time, ...subject] = line.split('\t');
		let text: string;
		try {
			text = git('show', `${sha}:${config.file}`);
		} catch {
			continue; // the board does not exist at this commit (git's complaint stays out of the log)
		}
		const blobs = new Map(git('ls-tree', sha, 'lib/').split('\n').filter(Boolean).map((l) => {
			const [meta, path] = l.split('\t');
			return [path.slice(4), meta.split(' ')[2]] as const;
		}));
		let id: string;
		try {
			id = sha256(`${shapeText(text)}\n${libraryRefs(text).map((n) => `${n} ${blobs.get(n) ?? '-'}`).join('\n')}`).slice(0, 7);
		} catch {
			continue; // not a board file KiCad can read
		}
		if (id === previous) continue;
		previous = id;
		found.push({ sha, date: new Date(Number(time) * 1000).toISOString().replace('.000', ''), subject: subject.join('\t'), id, text });
	}
	return found;
}

/** The revision's GLB, measure file and zipped STEP, from the cache or from the converter. */
async function convertRevision(title: string, settings: Pick<ModelConfig, 'simplifyError' | 'materials'>, exported: Exported, zipName: string, ctx: BoardContext) {
	buildCode ||= sha256(BUILD_CODE.map((f) => readFileSync(f, 'utf8')).join('\0'));
	const dir = `${ctx.cache}/models/${ctx.pipelineHash}/board-${sha256([buildCode, JSON.stringify(settings), zipName, exported.stepHash].join('\n')).slice(0, 24)}`;
	usedBuilds.add(dir);
	if (existsSync(`${dir}/done.json`)) return { dir, ...(JSON.parse(readFileSync(`${dir}/done.json`, 'utf8')) as Built) };

	rmSync(dir, { recursive: true, force: true });
	mkdirSync(`${dir}/export`, { recursive: true });
	const step = `${dir}/${posix.basename(exported.step, '.gz')}`;
	writeFileSync(step, gunzipSync(readFileSync(exported.step)));
	// Vendor models carry near-straight edges as circles a kilometre wide; from 20 m an arc's length no longer fits the
	// measurement file (step_to_manifest.py MIN_SWEEP).
	execFileSync(ctx.convert[0], [...ctx.convert.slice(1), 'export/step/step_to_manifest.py', step, `${dir}/export`, '--version', '0', '--max-radius', '20000'], { stdio: 'inherit' });
	const manifest = nameTree(JSON.parse(readFileSync(`${dir}/export/manifest.json`, 'utf8')));
	writeFileSync(`${dir}/export/manifest.json`, JSON.stringify(manifest));
	const pcbs = boardBodies(manifest);
	if (!pcbs.length) throw new Error('the export has no board body');
	const facts = pcbFacts(`${dir}/export`, manifest, pcbs, null);
	const result = await buildModel(`${dir}/export`, { title, ...settings }, { idPrefix: BOARD_ID_PREFIX, fasteners: false });
	writeFileSync(`${dir}/model.glb`, result.glb);
	writeFileSync(`${dir}/measure.json.gz`, result.measure);

	// Named for the revision inside the zip; a fixed file time keeps the zip byte-identical across builds.
	renameSync(step, `${dir}/${zipName}`);
	utimesSync(`${dir}/${zipName}`, EPOCH, EPOCH);
	execFileSync('zip', ['-j', '-q', '-X', `${dir}/step.zip`, `${dir}/${zipName}`]);
	rmSync(`${dir}/${zipName}`);
	rmSync(`${dir}/export`, { recursive: true });

	const parts = exportedRefs(manifest);
	const built: Built = { bodies: result.bodies, triangles: result.trianglesOut, facts, missing: exported.modelled.filter((ref) => !parts.has(ref)) };
	writeFileSync(`${dir}/done.json`, JSON.stringify(built));
	return { dir, ...built };
}

/** Builds a model's board track into ctx.out/<key>/ and returns it, with the latest board's facts for registration. */
export async function buildBoard(key: string, title: string, model: Pick<ModelConfig, 'simplifyError'>, config: BoardConfig, ctx: BoardContext) {
	const git = (...args: string[]) => execFileSync('git', ['-C', ctx.upstream, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
	const head = resolve(git, config.ref);
	const settings = { simplifyError: config.simplifyError ?? model.simplifyError, materials: config.materials };
	const stem = posix.basename(config.file, '.kicad_pcb');
	const all = candidates(git, head, config);

	type Kept = Omit<BoardRevision, 'glb' | 'measure' | 'step'> & { dir: string; facts: PcbFacts };
	const built: Kept[] = [];
	let failed: BoardTrack['failed'];
	let lastStep = '';
	for (const c of all) {
		const commit = c.sha.slice(0, 7);
		try {
			const exported = exportRevision({ upstream: ctx.upstream, file: config.file, commit: c.sha, id: c.id, text: c.text, fixups: config.fixups ?? {} }, ctx.kicad, ctx.cache);
			if (exported.stepHash === lastStep) continue; // nothing in 3D changed
			lastStep = exported.stepHash;
			const revision = await convertRevision(`${title} board`, settings, exported, `${stem}-${c.id}.step`, ctx);
			let subject = c.subject;
			try {
				assertPublic('commit subject', subject);
			} catch {
				subject = '';
			}
			built.push({
				id: c.id, commit, date: c.date, subject, triangles: revision.triangles, bodies: revision.bodies,
				fixups: exported.notes, missing: revision.missing, dir: revision.dir, facts: revision.facts
			});
		} catch (err) {
			const reason = (err as Error).message.split('\n')[0];
			console.warn(`${key} board ${commit}: skipped, ${reason}`);
			if (c === all.at(-1)) failed = { commit, reason: publicReason(reason) };
		}
	}

	const keep = built.reverse().slice(0, config.keep ?? 20);
	mkdirSync(`${ctx.out}/${key}`, { recursive: true });
	const publish = (from: string, name: string) => {
		copyFileSync(from, `${ctx.out}/${key}/${name}`);
		return fileEntry(`${key}/${name}`, ctx.out);
	};
	const revisions: BoardRevision[] = keep.map(({ dir, facts: _, ...revision }) => ({
		...revision,
		glb: publish(`${dir}/model.glb`, `board-${revision.id}.glb`),
		measure: publish(`${dir}/measure.json.gz`, `board-${revision.id}.measure.json.gz`),
		step: publish(`${dir}/step.zip`, `board-${revision.id}.step.zip`)
	}));
	const track: BoardTrack = {
		source: { repo: config.repo, ref: config.ref, file: config.file },
		head: lastChange(git, head, config.file).slice(0, 7),
		latest: revisions[0]?.id ?? null,
		...(failed ? { failed } : {}),
		revisions
	};
	return { track, facts: keep[0]?.facts ?? null };
}
