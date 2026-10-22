// The board track: the upstream revisions of a model's PCB (github.com/seedhammer/hardware, KiCad), each exported
// with kicad-cli the way the boards go into Fusion (kicad/export.ts), converted with stepstr like the enclosures and
// published as a GLB, measurement data and zipped STEP of its own: a companion in the catalogue, which the viewer puts
// into the enclosure's board slot (slot.ts).
//
// A revision is a commit whose 3D inputs changed: the board file without tracks and zones (kicad/board.ts shapeText)
// plus the repository models it uses. Its id hashes those inputs, so it survives a rebase and a KiCad upgrade;
// consecutive commits whose exports come out identical are one revision. A commit that fails is skipped and
// reported. Boards never stop the enclosures from building.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { converted, sha256, type Conversion } from './conversions.ts';
import { gltfJson, partsOf } from './glb.ts';
import { libraryRefs, shapeText, type Fixups } from './kicad/board.ts';
import { exportRevision, type Exported, type Kicad } from './kicad/export.ts';
import { exportedRefs, nameBoard } from './kicad/tree.ts';
import { assertPublic, publicSubject } from './privacy.ts';
import { boardBodies, pcbFacts, type PartSlot, type PcbFacts } from './slot.ts';
import { MemoryIO, zipSync, type Blob, type CompanionRevision, type CompanionTrack, type Finish, type MeasureData } from './stepstr.ts';

export type { Kicad };

export type BoardConfig = {
	repo: string;
	ref: string;
	file: string;
	/** Commits before this day (YYYY-MM-DD) are not revisions. */
	since?: string;
	/** How many revisions the catalogue lists, newest first. */
	keep?: number;
	materials?: Finish[];
	fixups?: Fixups;
	/** For a model whose PCB is a part modelled in CAD: that part, which the board is centred on (slot.ts). */
	slot?: PartSlot;
};

export type BoardContext = {
	/** Full clone of the board repository. */
	upstream: string;
	cache: string;
	kicad: Kicad;
	conversion: string;
	/** Puts a file where the publisher takes it from, and names it as the catalogue does. */
	place: (path: string, pin: Blob) => Blob;
};

/** The renaming is part of what a board's files are: a change to it converts every board again. */
const NAMING = readFileSync(new URL('./kicad/tree.ts', import.meta.url), 'utf8');
/** A fixed file time keeps a zip byte-identical across builds. */
const EPOCH = '1980-01-01';

export type Candidate = { sha: string; date: string; subject: string; id: string; text: string };

/** What the catalogue says of a revision, and the board body's facts for registration. */
type Built = { revision: CompanionRevision; facts: PcbFacts };

/** The catalogue's limits for a note: one line of at most 300 characters, at most 8 of them. */
const NOTE_LENGTH = 300;
const NOTES = 8;
const clip = (note: string) => (note.length > NOTE_LENGTH ? `${note.slice(0, NOTE_LENGTH - 1)}…` : note);

/**
 * What the viewer says of a revision: what the export changed on the way (kicad/board.ts writes each change as
 * "<what>: <parts>"), and the parts it could not show. A scale the fixups set for a part the board no longer has is
 * about this site's settings, not about the board, so it stays in the build log.
 */
export function revisionNotes(fixups: string[], missing: string[]): string[] {
	const notes: string[] = [];
	for (const fixup of fixups) {
		const at = fixup.indexOf(': ');
		const [what, parts] = [fixup.slice(0, at), fixup.slice(at + 2)];
		if (what === 'models from the repository\'s lib') notes.push(`${parts}: 3D models from the repository's lib folder.`);
		else if (what === 'left out, parked outside the board') notes.push(`Left out, parked off the board: ${parts}.`);
		else if (what === 'model scale') notes.push(`Models scaled to the part's real size: ${parts}.`);
		else if (what === 'closest stock models') {
			for (const swap of parts.split('; ')) {
				const [, from, to, refs] = /^(.+) → (.+) \((.+)\)$/.exec(swap) ?? [];
				if (from) notes.push(`${refs}: KiCad's library has no ${from}, so the closest one, ${to}, stands in.`);
			}
		} else if (what !== 'scale not needed or no such part') notes.push(`${fixup.charAt(0).toUpperCase()}${fixup.slice(1)}.`);
	}
	if (missing.length) notes.push(`No 3D model in any library: ${missing.join(', ')}.`);
	return notes.slice(0, NOTES).map(clip);
}

/** Why a board could not be built, as the catalogue may say it: errors can quote paths. */
function publicReason(reason: string) {
	try {
		assertPublic('board failure', reason);
		return reason;
	} catch {
		return 'the export failed; the build log names the step';
	}
}

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

/**
 * Every commit since `since` whose 3D inputs differ from the commit before, oldest first. Only `since` bounds the
 * work: each candidate is exported once and cached, and the catalogue keeps the newest `keep` of those that differ.
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

/** A converted board: the converter's GLB with the board's names and ids (kicad/tree.ts). */
async function convertBoard(step: Uint8Array, name: string, conversion: string): Promise<Conversion> {
	return converted(step, name, conversion, {
		variant: NAMING,
		change: async (made) => {
			const io = new MemoryIO();
			const doc = await io.readBinary(made.glb);
			nameBoard(doc);
			return { ...made, glb: await io.writeBinary(doc) };
		}
	});
}

/** The revision's files, from the cache or from the converter, and what they say about the board. */
async function convertRevision(candidate: Candidate, exported: Exported, config: BoardConfig, ctx: BoardContext): Promise<Built> {
	const zipName = `${posix.basename(config.file, '.kicad_pcb')}-${candidate.id}.step`;
	const step = gunzipSync(readFileSync(exported.step));
	const made = await convertBoard(step, zipName, ctx.conversion);
	// Named for the revision inside the zip; two revisions can share a STEP file, and so a conversion.
	const zip = join(made.dir, `step-${candidate.id}.zip`);
	if (!existsSync(zip)) writeFileSync(zip, zipSync({ [zipName]: step }, { level: 6, mtime: EPOCH }));

	const parts = partsOf(gltfJson(readFileSync(made.glb)));
	const pcbs = boardBodies(parts);
	if (!pcbs.length) throw new Error('the export has no board body');
	const measure: MeasureData = JSON.parse(gunzipSync(readFileSync(made.measure)).toString('utf8'));
	const refs = exportedRefs(parts);
	const notes = revisionNotes(exported.notes, exported.modelled.filter((ref) => !refs.has(ref)));

	const zipped = readFileSync(zip);
	return {
		revision: {
			id: candidate.id,
			commit: candidate.sha,
			date: candidate.date,
			subject: publicSubject(candidate.subject),
			step: ctx.place(zip, { sha256: sha256(zipped), size: zipped.length }),
			files: { glb: ctx.place(made.glb, made.summary.glb), measure: ctx.place(made.measure, made.summary.measure) },
			...(notes.length ? { notes } : {})
		},
		facts: pcbFacts(measure, pcbs, null)
	};
}

/** A model's board track, newest revision first, with the newest board's facts for registration. */
export async function buildBoard(key: string, config: BoardConfig, ctx: BoardContext): Promise<{ track: CompanionTrack; facts: PcbFacts | null }> {
	const git = (...args: string[]) => execFileSync('git', ['-C', ctx.upstream, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
	const head = resolve(git, config.ref);
	const all = candidates(git, head, config);

	// Every candidate is exported (each once, cached) to see which ones change the board in 3D; only the newest
	// `keep` of those are converted.
	const changed: { candidate: Candidate; exported: Exported }[] = [];
	// Why the newest commit has no revision, when it has none: said on the track, or the viewer would quietly show an
	// older board.
	let failed: string | null = null;
	const skip = (candidate: Candidate, err: unknown) => {
		const reason = (err as Error).message.split('\n')[0];
		console.warn(`${key} board ${candidate.sha.slice(0, 7)}: skipped, ${reason}`);
		if (candidate === all.at(-1)) failed = `The newest board, of commit ${candidate.sha.slice(0, 7)} on ${candidate.date.slice(0, 10)}, could not be built: ${publicReason(reason)}.`;
	};
	let lastStep = '';
	for (const candidate of all) {
		try {
			const exported = exportRevision({ upstream: ctx.upstream, file: config.file, commit: candidate.sha, id: candidate.id, text: candidate.text, fixups: config.fixups ?? {} }, ctx.kicad, ctx.cache);
			if (exported.stepHash === lastStep) continue; // nothing in 3D changed
			lastStep = exported.stepHash;
			changed.push({ candidate, exported });
		} catch (err) {
			skip(candidate, err);
		}
	}

	const built: Built[] = [];
	for (const { candidate, exported } of changed.reverse()) {
		if (built.length === (config.keep ?? 20)) break;
		try {
			built.push(await convertRevision(candidate, exported, config, ctx));
		} catch (err) {
			skip(candidate, err);
		}
	}
	const revisions = built.map((b) => b.revision);
	for (const note of revisions[0]?.notes ?? []) console.log(`${key} board ${revisions[0].id}: ${note}`);
	const track: CompanionTrack = {
		label: 'Board',
		source: `${config.repo} ${config.ref}`,
		latest: revisions[0]?.id ?? null,
		revisions,
		...(failed ? { notes: [clip(failed)] } : {})
	};
	return { track, facts: built[0]?.facts ?? null };
}
