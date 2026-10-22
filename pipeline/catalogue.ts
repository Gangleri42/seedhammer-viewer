// Builds the site's catalogue (stepstr's src/lib/catalogue): every version of every model in the hardware repository,
// converted with stepstr's converter, into catalogue.json, and the files it names into catalogue-files/<sha256>, where
// stepstr's publisher takes them from.
//
// A version is a commit that changed the model's STEP file (versions.ts), named by the commit's short hash. Its STEP
// file stays on GitHub at that commit; the catalogue names it there by URL, size and sha256. Each STEP file is
// converted once (conversions.ts).
//
//   HARDWARE_DIR    full clone of the hardware repository (default ../sh-hardware)
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { converted, conversionId, pruneConversions, type Conversion } from './conversions.ts';
import models from './models.json' with { type: 'json' };
import { assertPublic, publicSubject } from './privacy.ts';
import { parseCatalogue, readConfig, type Blob, type Catalogue, type CatalogueVersion } from './stepstr.ts';
import { listVersions } from './versions.ts';

const HARDWARE = process.env.HARDWARE_DIR ?? '../sh-hardware';
/** The hardware repository on GitHub, which serves each STEP file at its commit. */
const HARDWARE_REPO = 'Gangleri42/sh-hardware';
const FILES = 'catalogue-files';
/** The public server that answered fastest in the 2026-10-18 survey: the viewer asks the servers in this order. */
const FASTEST = 'https://blossom.primal.net';
const HOME = 'hammer';

type ModelConfig = { title: string; folder: string };

const site = readConfig('.nsite/config.json');
const servers = site.servers.includes(FASTEST) ? [FASTEST, ...site.servers.filter((s) => s !== FASTEST)] : site.servers;

if (!existsSync(`${HARDWARE}/.git`)) throw new Error(`no hardware repository at ${HARDWARE} (set HARDWARE_DIR)`);
const hardware = (...args: string[]) => execFileSync('git', ['-C', HARDWARE, ...args], { maxBuffer: 1 << 30 });
if (hardware('rev-parse', '--is-shallow-repository').toString().trim() === 'true') throw new Error(`${HARDWARE} is a shallow clone; the versions need its whole history`);

const conversion = conversionId();
pruneConversions(conversion);
rmSync(FILES, { recursive: true, force: true });
mkdirSync(FILES, { recursive: true });

/** A converted file into catalogue-files, by its sha256; a clone where the file system can make one. */
function place(path: string, pin: Blob): Blob {
	copyFileSync(path, `${FILES}/${pin.sha256}`, constants.COPYFILE_FICLONE);
	return { sha256: pin.sha256, size: pin.size };
}
const filesOf = (made: Conversion) => ({ glb: place(made.glb, made.summary.glb), measure: place(made.measure, made.summary.measure) });

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
const started = Date.now();
const catalogue: Catalogue = { version: 1, conversion, servers, home: HOME, models: {} };
for (const [key, config] of Object.entries(models) as [string, ModelConfig][]) {
	const versions: CatalogueVersion[] = [];
	for (const source of listVersions(HARDWARE, config.folder)) {
		const made = await converted(hardware('cat-file', 'blob', source.blob), posix.basename(source.path), conversion);
		const url = `https://raw.githubusercontent.com/${HARDWARE_REPO}/${source.commit}/${source.path.split('/').map(encodeURIComponent).join('/')}`;
		versions.push({
			id: source.id,
			commit: source.commit,
			date: source.date,
			subject: publicSubject(source.subject),
			step: { ...made.summary.step, url },
			files: filesOf(made)
		});
		console.log(`${key} ${source.id} (${source.path}): ${made.cached ? 'cached' : `converted in ${made.seconds.toFixed(1)} s`}, ` +
			`${made.summary.solids} solids, ${made.summary.triangles.toLocaleString('en')} triangles, GLB ${mb(made.summary.glb.size)}, measure ${mb(made.summary.measure.size)}`);
		for (const warning of made.summary.warnings) console.warn(`  ${warning}`);
	}
	if (!versions.length) throw new Error(`${key}: no ${config.folder}/${config.folder}.step or ${config.folder}/<Name>-v<n>.step in ${HARDWARE}`);
	catalogue.models[key] = { title: config.title, versions };
}

const text = `${JSON.stringify(parseCatalogue(catalogue), null, '\t')}\n`;
assertPublic('catalogue.json', text);
writeFileSync('catalogue.json', text);
const counts = Object.entries(catalogue.models).map(([key, model]) => `${key} ${model.versions.length}`);
console.log(`catalogue.json: ${counts.join(', ')} versions, conversion ${conversion.slice(0, 12)}, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
