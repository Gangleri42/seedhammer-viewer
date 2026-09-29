// Builds every version of every model in the hardware repository into static/models, plus static/models/index.json.
//
// A version is <folder>/<Name>-v<n>.step as the commit that added it has it (see versions.ts); each is converted once
// and cached under .cache/models, keyed by the STEP file's git blob and a hash of this pipeline, so a new push only
// converts what is new.
//
//   HARDWARE_DIR  full clone of the hardware repository (default ../sh-hardware)
//   CONVERT       command that runs Python with OCP (default "python3"),
//                 e.g. "uv run --with cadquery-ocp==8.0.1.0.0 python" for local builds
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import type { ModelIndex, ModelVersion } from '../src/lib/models/types.ts';
import { buildModel, type ModelConfig } from './build-model.ts';
import { fileEntry, serialize } from './manifest.ts';
import models from './models.json' with { type: 'json' };
import { privateTerms } from '../scripts/privacy-rules.mjs';
import { assertPublic } from './privacy.ts';
import { pickVersions } from './versions.ts';

const HARDWARE = process.env.HARDWARE_DIR ?? '../sh-hardware';
const CONVERT = (process.env.CONVERT ?? 'python3').split(' ');
const OUT = 'static/models';
const CACHE = '.cache/models';

const git = (...args: string[]) => execFileSync('git', ['-C', HARDWARE, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

// Any change to the conversion invalidates every cached build, and so does any change to the privacy rules or the
// private terms: a cached version was only checked against the rules of its day. The libraries that simplify, encode
// and compress count too, since a new release can change the output.
const SOURCES = [
	'pipeline/build-model.ts', 'pipeline/geometry.ts', 'pipeline/ids.ts', 'pipeline/measure.ts', 'pipeline/models.json',
	'src/lib/measure/format.ts', 'export/step/step_to_manifest.py', 'scripts/privacy-rules.mjs'
];
const LIBRARIES = ['meshoptimizer', '@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'fflate', 'three', 'three-mesh-bvh'];
const pipelineHash = createHash('sha256')
	.update(SOURCES.map((f) => readFileSync(f, 'utf8')).join('\0'))
	.update(LIBRARIES.map((name) => `${name}@${JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version}`).join('\n'))
	.update(privateTerms().join('\n'))
	.digest('hex')
	.slice(0, 12);

type Source = { version: number; commit: string; date: string; path: string; blob: string };

/** Each version of the model's STEP file as first published; later changes to a version are reported and left out. */
function sources(folder: string): Source[] {
	const { sources: found, ignored } = pickVersions(git('log', '--reverse', '--format=@%H %cs', '--name-only', '--diff-filter=AMR', '--', folder), folder);
	for (const change of ignored) {
		console.warn(`${change.path} changed in ${change.commit.slice(0, 7)}; v${change.version} stays as first published so pinned links keep showing it. Export changes under a new version number.`);
	}
	return found.map((source) => ({ ...source, blob: git('rev-parse', `${source.commit}:${source.path}`) }));
}

/** Converts one STEP version, or returns it from the cache. */
async function build(key: string, config: ModelConfig, source: Source) {
	const dir = `${CACHE}/${pipelineHash}/${source.blob}`;
	const name = source.path.split('/').pop()!;
	if (existsSync(`${dir}/done.json`)) return { dir, name, cached: true, ...JSON.parse(readFileSync(`${dir}/done.json`, 'utf8')) };

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

	// A fixed file time keeps the zip byte-identical across builds.
	const epoch = new Date('2020-01-01T00:00:00Z');
	utimesSync(`${dir}/${name}`, epoch, epoch);
	execFileSync('zip', ['-j', '-q', '-X', `${dir}/step.zip`, `${dir}/${name}`]);
	rmSync(`${dir}/${name}`);
	rmSync(`${dir}/export`, { recursive: true });

	const done = { bodies: result.bodies, triangles: result.trianglesOut };
	writeFileSync(`${dir}/done.json`, JSON.stringify(done));
	return { dir, name, cached: false, ...done };
}

if (!existsSync(`${HARDWARE}/.git`)) throw new Error(`no hardware repository at ${HARDWARE} (set HARDWARE_DIR)`);
if (git('rev-parse', '--is-shallow-repository') === 'true') throw new Error(`${HARDWARE} is a shallow clone; older versions need the full history`);

// Builds made by an older pipeline can never be used again.
for (const stale of existsSync(CACHE) ? readdirSync(CACHE).filter((d) => d !== pipelineHash) : []) rmSync(`${CACHE}/${stale}`, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
// index.json is schema v2: every file with its size and sha256, so the viewer can name it by content on Blossom.
const index: ModelIndex = { version: 2, models: {} };
for (const [key, config] of Object.entries(models) as [string, ModelConfig][]) {
	const versions = sources(config.folder);
	if (!versions.length) {
		console.warn(`${key}: no ${config.folder}/<Name>-v<n>.step in ${HARDWARE}`);
		continue;
	}
	mkdirSync(`${OUT}/${key}`, { recursive: true });
	const entries: ModelVersion[] = [];
	for (const source of versions) {
		const started = Date.now();
		const built = await build(key, config, source);
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
	index.models[key] = { title: config.title, latest: versions[0].version, versions: entries };
}
writeFileSync(`${OUT}/index.json`, serialize(index));
