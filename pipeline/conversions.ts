// Conversions with stepstr's converter, each made once: cached under .cache/catalogue/<conversion id> by the STEP
// file's sha256 (and, for a file the site changes after conversion, by the code that changes it). Another conversion
// id makes every file again, and the old ones are removed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPublic } from './privacy.ts';
import { about, convert, publishable, WASM, type Converted, type Summary } from './stepstr.ts';

export const CACHE = '.cache/catalogue';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export type Conversion = { dir: string; glb: string; measure: string; summary: Summary; cached: boolean; seconds: number };

/** The conversion id of stepstr's converter as checked out; it needs the converter fetched. */
export function conversionId(): string {
	const { conversion } = about(WASM);
	if (!conversion) throw new Error(`no converter at ${WASM}: run npm run converter:fetch`);
	return conversion;
}

/** Removes the conversions of every other conversion id. */
export function pruneConversions(conversion: string) {
	for (const entry of existsSync(CACHE) ? readdirSync(CACHE) : []) if (entry !== conversion) rmSync(join(CACHE, entry), { recursive: true });
}

/**
 * The published files for these STEP bytes: the meshopt GLB and the gzipped measurement data, as stepstr's convert.ts
 * makes them. `change` edits the converter's GLB before it is compressed; `variant` names that edit in the cache key.
 * Nothing private may ship in the GLB's JSON (names, extras), checked on every run since the rules and the private
 * terms can change; the binary chunk is geometry.
 */
export async function converted(
	step: Uint8Array,
	name: string,
	conversion: string,
	options: { variant?: string; change?: (converted: Converted) => Promise<Converted> } = {}
): Promise<Conversion> {
	const key = sha256(step) + (options.variant ? `-${sha256(options.variant).slice(0, 12)}` : '');
	const dir = join(CACHE, conversion, key);
	const files = { glb: join(dir, 'model.glb'), measure: join(dir, 'measure.json.gz') };
	if (existsSync(join(dir, 'summary.json'))) {
		assertPublicGlb(name, readFileSync(files.glb));
		return { dir, ...files, summary: JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')), cached: true, seconds: 0 };
	}
	const started = Date.now();
	let made = await convert(step, name);
	if (options.change) made = await options.change(made);
	const { glb, measure, summary } = await publishable(step, made);
	if (summary.conversion !== conversion) throw new Error(`the converter changed during the run (${summary.conversion.slice(0, 12)})`);
	assertPublicGlb(name, glb);
	// Written whole, then moved in place, so an interrupted run leaves nothing half made.
	const scratch = `${dir}.${process.pid}`;
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
	writeFileSync(join(scratch, 'model.glb'), glb);
	writeFileSync(join(scratch, 'measure.json.gz'), measure);
	writeFileSync(join(scratch, 'summary.json'), `${JSON.stringify(summary, null, '\t')}\n`);
	rmSync(dir, { recursive: true, force: true });
	renameSync(scratch, dir);
	return { dir, ...files, summary, cached: false, seconds: (Date.now() - started) / 1000 };
}

function assertPublicGlb(name: string, glb: Uint8Array) {
	const json = new DataView(glb.buffer, glb.byteOffset + 12, 4).getUint32(0, true);
	assertPublic(`${name} GLB`, new TextDecoder().decode(glb.subarray(20, 20 + json)));
}
