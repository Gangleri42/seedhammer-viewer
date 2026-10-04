// One board revision exported to STEP, cached in .cache/boards by everything that shapes the file: this code, the
// KiCad version, the fixups and the revision's 3D inputs. The pipeline hash is not among them, so a converter change
// reuses the STEP files without running KiCad again.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256 } from '../manifest.ts';
import { assertPublic } from '../privacy.ts';
import { modelledRefs, prepare, useNearest, type Fixups } from './board.ts';
import { exportStep, normaliseHeader } from './step.ts';

export type Kicad = { command: string[]; version: string; library: string };
export type Exported = {
	/** The STEP file, gzipped (seed.step.gz): KiCad names the root after the file, so it holds "seed 1". */
	step: string;
	/** sha256 of the file: revisions whose files are equal are one. */
	stepHash: string;
	/** What the export changed on the way. */
	notes: string[];
	/** References that should have a 3D part. */
	modelled: string[];
};

// scripts/kicad-docker.sh pins CI's KiCad image: a new digest is a new exporter and a new stock library.
const CODE = ['pipeline/kicad/board.ts', 'pipeline/kicad/step.ts', 'pipeline/kicad/export.ts', 'scripts/kicad-docker.sh'];
let codeHash = '';
/** The cache entries this run used: whatever else lies in .cache/boards belongs to older code or older fixups. */
export const used = new Set<string>();

/** A failure the same inputs always meet (a malformed outline, private text), as opposed to a crash worth retrying. */
const lasting = (message: string) => Object.assign(new Error(message), { lasting: true });

/**
 * The revision `commit` of `file` in the board repository `upstream`, whose 3D inputs hash to `id`. A lasting failure
 * is cached as its reason: the key changes with anything that could fix it.
 */
export function exportRevision(revision: { upstream: string; file: string; commit: string; id: string; text: string; fixups: Fixups }, kicad: Kicad, cache: string): Exported {
	const { file, fixups } = revision;
	codeHash ||= sha256(CODE.map((f) => readFileSync(f, 'utf8')).join('\0'));
	const key = sha256([codeHash, kicad.version, JSON.stringify(fixups), revision.id].join('\n'));
	const dir = `${cache}/boards/${key.slice(0, 24)}`;
	used.add(dir);
	const step = `${dir}/${posix.basename(file, '.kicad_pcb')}.step`;
	if (existsSync(`${dir}/export.json`)) {
		const record = JSON.parse(readFileSync(`${dir}/export.json`, 'utf8'));
		if (record.failed) throw new Error(record.failed);
		if (existsSync(`${step}.gz`)) return { ...record, step: `${step}.gz` };
	}

	rmSync(dir, { recursive: true, force: true });
	mkdirSync(`${dir}/tree`, { recursive: true });
	try {
		const record = exportInto(dir, step, revision, kicad);
		writeFileSync(`${dir}/export.json`, JSON.stringify(record));
		return { ...record, step: `${step}.gz` };
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		if ((err as { lasting?: boolean }).lasting) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(`${dir}/export.json`, JSON.stringify({ failed: (err as Error).message }));
		}
		throw err;
	} finally {
		rmSync(`${dir}/tree`, { recursive: true, force: true });
		rmSync(step, { force: true });
	}
}

function exportInto(dir: string, step: string, revision: Parameters<typeof exportRevision>[0], kicad: Kicad): Omit<Exported, 'step'> {
	const { file, fixups } = revision;
	const boardDir = posix.dirname(file);
	const archive = spawnSync('git', ['-C', revision.upstream, 'archive', revision.commit, boardDir, 'lib'], { maxBuffer: 1 << 30 });
	if (archive.status !== 0) throw new Error('git archive failed');
	const untar = spawnSync('tar', ['-x', '-C', `${dir}/tree`], { input: archive.stdout });
	if (untar.status !== 0) throw new Error('tar failed');

	const board = `${dir}/tree/${file}`;
	const prepared = prepare(revision.text, fixups, {
		libPrefix: `\${KIPRJMOD}/${posix.relative(boardDir, 'lib')}`,
		libHas: (name) => existsSync(`${dir}/tree/lib/${name}`)
	});
	let text = prepared.text;
	const notes = [...prepared.notes];
	writeFileSync(board, text);
	let result = exportStep(kicad.command, board, step, kicad.library);
	const near = useNearest(text, result.notFound, fixups.nearest);
	if (near) {
		text = near.text;
		writeFileSync(board, text);
		result = exportStep(kicad.command, board, step, kicad.library);
		notes.push(near.note);
	}
	if (result.malformed) throw lasting('KiCad finds the board outline malformed');

	const content = Buffer.from(normaliseHeader(readFileSync(step, 'latin1'), posix.basename(step)), 'latin1');
	try {
		assertPublic(`board ${revision.id}`, content.toString('latin1'));
	} catch (err) {
		throw lasting((err as Error).message);
	}
	// Text that compresses about five to one; the cache travels between CI runs.
	writeFileSync(`${step}.gz`, gzipSync(content, { level: 9 }));
	return { stepHash: sha256(content), notes, modelled: modelledRefs(text) };
}
