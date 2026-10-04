// Builds every version of every model in the hardware repository into static/models, plus static/models/index.json.
//
// A version is <folder>/<Name>-v<n>.step as the commit that added it has it (see versions.ts); each is converted once
// and cached under .cache/models, keyed by the STEP file's git blob and a hash of this pipeline, so a new push only
// converts what is new. Models listed in boards.json also get their upstream board track (boards.ts), and each
// version learns where that board goes (slot.ts).
//
//   HARDWARE_DIR    full clone of the hardware repository (default ../sh-hardware)
//   CONVERT         command that runs Python with OCP (default "python3"),
//                   e.g. "uv run --with cadquery-ocp==8.0.1.0.0 python" for local builds
//   UPSTREAM_DIR    full clone of the board repository (default ../seedhammer-hardware)
//   KICAD_CLI       kicad-cli command prefix (default: the Mac app), e.g. a docker run of kicad/kicad:10.0.6-full
//   KICAD_3DMODELS  KiCad's 3D library as kicad-cli sees it (default: the Mac app's, else /usr/share/kicad/3dmodels)
//   KICAD_VERSION   the version KICAD_CLI runs, when known without running it (CI pins it with the image)
//   BOARDS          "required": fail instead of building without boards when the board repository or kicad-cli is missing
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import type { ModelIndex, ModelVersion } from '../src/lib/models/types.ts';
import { buildBoard, usedBuilds, type BoardConfig, type Kicad } from './boards.ts';
import boardConfigs from './boards.json' with { type: 'json' };
import { buildModel, type ModelConfig } from './build-model.ts';
import { partId } from './ids.ts';
import { used as usedExports } from './kicad/export.ts';
import { kicadCommand, kicadVersion, libraryDir } from './kicad/step.ts';
import { fileEntry, serialize } from './manifest.ts';
import models from './models.json' with { type: 'json' };
import { privateTerms } from '../scripts/privacy-rules.mjs';
import { assertPublic } from './privacy.ts';
import { findSlot, pcbFacts, register, type PcbFacts } from './slot.ts';
import { pickVersions } from './versions.ts';

const HARDWARE = process.env.HARDWARE_DIR ?? '../sh-hardware';
const UPSTREAM = process.env.UPSTREAM_DIR ?? '../seedhammer-hardware';
const CONVERT = (process.env.CONVERT ?? 'python3').split(' ');
const OUT = 'static/models';
const CACHE = '.cache/models';
const boards = boardConfigs as unknown as Record<string, BoardConfig>;

const git = (...args: string[]) => execFileSync('git', ['-C', HARDWARE, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

// Any change to the conversion invalidates every cached build, and so does any change to the privacy rules or the
// private terms: a cached version was only checked against the rules of its day. The libraries that simplify, encode
// and compress count too, since a new release can change the output.
const SOURCES = [
	'pipeline/build-model.ts', 'pipeline/geometry.ts', 'pipeline/ids.ts', 'pipeline/measure.ts', 'pipeline/models.json',
	'pipeline/slot.ts', 'src/lib/measure/format.ts', 'export/step/step_to_manifest.py', 'scripts/privacy-rules.mjs'
];
const LIBRARIES = ['meshoptimizer', '@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'fflate', 'three', 'three-mesh-bvh'];
const pipelineHash = createHash('sha256')
	.update(SOURCES.map((f) => readFileSync(f, 'utf8')).join('\0'))
	.update(LIBRARIES.map((name) => `${name}@${JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version}`).join('\n'))
	.update(privateTerms().join('\n'))
	.digest('hex')
	.slice(0, 12);

type Source = { version: number; commit: string; date: string; path: string; blob: string };
/** The CAD board's sub-assembly: its part id and its board body in its own frame. */
type Slot = { id: string; facts: PcbFacts };

/** Each version of the model's STEP file as first published; later changes to a version are reported and left out. */
function sources(folder: string): Source[] {
	const { sources: found, ignored } = pickVersions(git('log', '--reverse', '--format=@%H %cs', '--name-only', '--diff-filter=AMR', '--', folder), folder);
	for (const change of ignored) {
		console.warn(`${change.path} changed in ${change.commit.slice(0, 7)}; v${change.version} stays as first published so pinned links keep showing it. Export changes under a new version number.`);
	}
	return found.map((source) => ({ ...source, blob: git('rev-parse', `${source.commit}:${source.path}`) }));
}

/** Converts one STEP version, or returns it from the cache, with its board slot and the model without that board. */
async function build(key: string, config: ModelConfig, source: Source): Promise<{ dir: string; name: string; cached: boolean; bodies: number; triangles: number; slot: Slot | null }> {
	const dir = `${CACHE}/${pipelineHash}/${source.blob}`;
	const name = source.path.split('/').pop()!;
	if (existsSync(`${dir}/done.json`)) return { dir, name, cached: true, slot: null, ...JSON.parse(readFileSync(`${dir}/done.json`, 'utf8')) };

	rmSync(dir, { recursive: true, force: true });
	mkdirSync(`${dir}/export`, { recursive: true });
	const step = execFileSync('git', ['-C', HARDWARE, 'show', `${source.commit}:${source.path}`], { maxBuffer: 1 << 30 });
	// The whole file: names and descriptions typed in Fusion sit in the data section, not the header.
	assertPublic(`${source.path}@${source.commit.slice(0, 7)}`, step.toString('latin1'));
	writeFileSync(`${dir}/${name}`, step);

	execFileSync(CONVERT[0], [...CONVERT.slice(1), 'export/step/step_to_manifest.py', `${dir}/${name}`, `${dir}/export`, '--version', String(source.version)], { stdio: 'inherit' });
	const result = await buildModel(`${dir}/export`, config);
	writeFileSync(`${dir}/model.glb`, result.glb);
	writeFileSync(`${dir}/measure.json.gz`, result.measure);
	const m = result.measureStats;
	console.log(`  measure: ${m.solids} solids, ${m.analytic} exact faces${m.demoted ? ` (${m.demoted} left free-form)` : ''}, ` +
		`tolerance ${m.tol[0]}-${m.tol[1]} mm, ${(result.measure.byteLength / 1e3).toFixed(0)} kB gzipped${m.mirrored ? `, ${m.mirrored} mirrored placements` : ''}`);

	// Where an upstream board goes, and the model without the CAD board's parts to carry it. Only the newest version's
	// is published, but every version gets one: it costs one more GLB pass, and the cache stays right whichever
	// version is the newest.
	let slot: Slot | null = null;
	const manifest = JSON.parse(readFileSync(`${dir}/export/manifest.json`, 'utf8'));
	const found = findSlot(manifest);
	if (found) {
		slot = { id: partId(found.slot.path), facts: pcbFacts(`${dir}/export`, manifest, found.pcbs, found.slot.matrix) };
		const bare = await buildModel(`${dir}/export`, config, { omit: found.slot.path });
		writeFileSync(`${dir}/bare.glb`, bare.glb);
		writeFileSync(`${dir}/bare.measure.json.gz`, bare.measure);
	} else if (key in boards) console.warn(`${source.path}: no KiCad board body (*_PCB) in one sub-assembly, so no upstream board`);

	// A fixed file time keeps the zip byte-identical across builds.
	const epoch = new Date('2020-01-01T00:00:00Z');
	utimesSync(`${dir}/${name}`, epoch, epoch);
	execFileSync('zip', ['-j', '-q', '-X', `${dir}/step.zip`, `${dir}/${name}`]);
	rmSync(`${dir}/${name}`);
	rmSync(`${dir}/export`, { recursive: true });

	const done = { bodies: result.bodies, triangles: result.trianglesOut, slot };
	writeFileSync(`${dir}/done.json`, JSON.stringify(done));
	return { dir, name, cached: false, ...done };
}

/** kicad-cli and the board repository, or null (with a warning) when either is missing and boards are optional. */
function kicadSetup(): Kicad | null {
	const fail = (message: string) => {
		if (process.env.BOARDS === 'required') throw new Error(message);
		console.warn(`${message}: the models get no upstream boards`);
		return null;
	};
	if (!existsSync(`${UPSTREAM}/.git`)) return fail(`no board repository at ${UPSTREAM} (set UPSTREAM_DIR)`);
	if (execFileSync('git', ['-C', UPSTREAM, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') return fail(`${UPSTREAM} is a shallow clone`);
	const command = kicadCommand();
	if (!command) return fail('no kicad-cli (set KICAD_CLI)');
	// CI names the version it pins with the image, so a run that finds every export cached never pulls the image.
	return { command, version: process.env.KICAD_VERSION ?? kicadVersion(command), library: libraryDir() };
}

if (!existsSync(`${HARDWARE}/.git`)) throw new Error(`no hardware repository at ${HARDWARE} (set HARDWARE_DIR)`);
if (git('rev-parse', '--is-shallow-repository') === 'true') throw new Error(`${HARDWARE} is a shallow clone; older versions need the full history`);
const kicad = Object.keys(boards).some((key) => key in models) ? kicadSetup() : null;

// Builds made by an older pipeline can never be used again.
for (const stale of existsSync(CACHE) ? readdirSync(CACHE).filter((d) => d !== pipelineHash) : []) rmSync(`${CACHE}/${stale}`, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
// index.json is schema v3: every file with its size and sha256, so the viewer can name it by content on Blossom.
const index: ModelIndex = { version: 3, models: {} };
for (const [key, config] of Object.entries(models) as [string, ModelConfig][]) {
	const versions = sources(config.folder);
	if (!versions.length) {
		console.warn(`${key}: no ${config.folder}/<Name>-v<n>.step in ${HARDWARE}`);
		continue;
	}
	mkdirSync(`${OUT}/${key}`, { recursive: true });
	const entries: ModelVersion[] = [];
	const slots: (Slot | null)[] = [];
	const boardConfig = kicad ? boards[key] : undefined;
	for (const source of versions) {
		const started = Date.now();
		const built = await build(key, config, source);
		slots.push(built.slot);
		const glb = `${key}/v${source.version}.glb`;
		const step = `${key}/${built.name}.zip`;
		const measure = `${key}/v${source.version}.measure.json.gz`;
		copyFileSync(`${built.dir}/model.glb`, `${OUT}/${glb}`);
		copyFileSync(`${built.dir}/step.zip`, `${OUT}/${step}`);
		copyFileSync(`${built.dir}/measure.json.gz`, `${OUT}/${measure}`);
		entries.push({
			version: source.version,
			glb: fileEntry(glb),
			step: fileEntry(step),
			measure: fileEntry(measure),
			triangles: built.triangles,
			bodies: built.bodies,
			built: source.date,
			commit: source.commit.slice(0, 7)
		});
		console.log(`${key} v${source.version} (${source.commit.slice(0, 7)}): ${built.cached ? 'cached' : `built in ${((Date.now() - started) / 1000).toFixed(1)} s`}, ` +
			`${built.triangles.toLocaleString()} triangles, ${(statSync(`${OUT}/${glb}`).size / 1e6).toFixed(2)} MB`);
	}

	// A board that cannot be built (its branch gone, say) leaves the model as exported; it never stops the site.
	let board: Awaited<ReturnType<typeof buildBoard>> | null = null;
	if (kicad && boardConfig) {
		try {
			board = await buildBoard(key, config.title, config, boardConfig, { upstream: UPSTREAM, cache: '.cache', out: OUT, pipelineHash, convert: CONVERT, kicad });
		} catch (err) {
			console.warn(`${key} board: not built, ${(err as Error).message.split('\n')[0]}`);
		}
	}
	if (board) {
		const { track } = board;
		console.log(`${key} board: ${track.revisions.length} revision(s), latest ${track.latest ?? 'none'} of ${track.source.ref} ${track.head}` +
			(track.failed ? `; ${track.failed.commit} failed: ${track.failed.reason}` : ''));
		entries.forEach((entry, i) => {
			const slot = slots[i];
			if (!slot || !board.facts) return;
			const fit = register(slot.facts, board.facts);
			if (fit) entry.slot = { id: slot.id, ...fit };
			else console.warn(`${key} v${entry.version}: its CAD board sits in another frame, so it shows only that board`);
		});
		const latest = entries[0];
		if (!latest.slot && slots[0] && board.facts && !track.failed) {
			// Said in the index too, or the viewer would quietly show the CAD board only.
			track.failed = { commit: track.revisions[0].commit, reason: `the board does not line up with the CAD board of v${latest.version}` };
		}
		if (latest.slot) {
			const dir = `${CACHE}/${pipelineHash}/${versions[0].blob}`;
			copyFileSync(`${dir}/bare.glb`, `${OUT}/${key}/v${latest.version}.bare.glb`);
			copyFileSync(`${dir}/bare.measure.json.gz`, `${OUT}/${key}/v${latest.version}.bare.measure.json.gz`);
			latest.bare = { glb: fileEntry(`${key}/v${latest.version}.bare.glb`), measure: fileEntry(`${key}/v${latest.version}.bare.measure.json.gz`) };
		}
	}
	index.models[key] = { title: config.title, latest: versions[0].version, versions: entries, ...(board ? { board: board.track } : {}) };
}
writeFileSync(`${OUT}/index.json`, serialize(index));
// Every board was walked: exports and board builds this run did not use can never be used again.
if (kicad) {
	if (existsSync('.cache/boards')) {
		for (const entry of readdirSync('.cache/boards')) if (!usedExports.has(`.cache/boards/${entry}`)) rmSync(`.cache/boards/${entry}`, { recursive: true });
	}
	for (const entry of readdirSync(`${CACHE}/${pipelineHash}`)) {
		if (entry.startsWith('board-') && !usedBuilds.has(`.cache/models/${pipelineHash}/${entry}`)) rmSync(`${CACHE}/${pipelineHash}/${entry}`, { recursive: true });
	}
}
