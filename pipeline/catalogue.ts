// Builds the site's catalogue (stepstr's src/lib/catalogue): every version of every model in the hardware repository,
// converted with stepstr's converter, into catalogue.json, and the files it names into catalogue-files/<sha256>, where
// stepstr's publisher takes them from.
//
// A version is a commit that changed the model's STEP file (versions.ts), named by the commit's short hash. Its STEP
// file stays on GitHub at that commit; the catalogue names it there by URL, size and sha256. Each STEP file is
// converted once (conversions.ts), and its finishes are the rules of models.json in force for it (finishes.ts).
// Models listed in boards.json also get their upstream board track as a companion (boards.ts), and each version
// learns where that board goes (slot.ts).
//
//   HARDWARE_DIR    full clone of the hardware repository (default ../sh-hardware)
//   UPSTREAM_DIR    full clone of the board repository (default ../seedhammer-hardware)
//   KICAD_CLI       kicad-cli command prefix (default: the Mac app), e.g. scripts/kicad-docker.sh
//   KICAD_3DMODELS  KiCad's 3D library as kicad-cli sees it (default: the Mac app's, else /usr/share/kicad/3dmodels)
//   KICAD_VERSION   the version KICAD_CLI runs, when known without running it (an image pins it)
//   BOARDS          "required": fail instead of building without boards when the board repository or kicad-cli is missing
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildBoard, type BoardConfig, type Kicad } from './boards.ts';
import boardConfigs from './boards.json' with { type: 'json' };
import { converted, conversionId, pruneConversions, type Conversion } from './conversions.ts';
import { followHistory, resolveFinishes, type ModelConfig } from './finishes.ts';
import { gltfJson, partsOf } from './glb.ts';
import { used as usedExports } from './kicad/export.ts';
import { kicadCommand, kicadVersion, libraryDir } from './kicad/step.ts';
import models from './models.json' with { type: 'json' };
import { assertPublic, publicSubject } from './privacy.ts';
import { centre, findPart, findSlot, pcbFacts, register, type PartSlot, type PcbFacts } from './slot.ts';
import { parseCatalogue, readConfig, type Blob, type Catalogue, type CatalogueVersion, type CompanionTrack, type MeasureData } from './stepstr.ts';
import { listVersions } from './versions.ts';

const HARDWARE = process.env.HARDWARE_DIR ?? '../sh-hardware';
const UPSTREAM = process.env.UPSTREAM_DIR ?? '../seedhammer-hardware';
/** The hardware repository on GitHub, which serves each STEP file at its commit. */
const HARDWARE_REPO = 'Gangleri42/sh-hardware';
const FILES = 'catalogue-files';
/** The public server that answered fastest in the 2026-10-18 survey: the viewer asks the servers in this order. */
const FASTEST = 'https://blossom.primal.net';
const HOME = 'hammer';

/**
 * Where a version's board goes: the slot's part id, and the CAD board in the slot's frame. `centred` for a part modelled
 * in CAD that the board is centred on (slot.ts centre); otherwise the board registers on KiCad's frame (register).
 */
type Slot = { id: string; facts: PcbFacts; centred: boolean };

const boards = boardConfigs as unknown as Record<string, BoardConfig>;

const site = readConfig('.nsite/config.json');
const servers = site.servers.includes(FASTEST) ? [FASTEST, ...site.servers.filter((s) => s !== FASTEST)] : site.servers;

if (!existsSync(`${HARDWARE}/.git`)) throw new Error(`no hardware repository at ${HARDWARE} (set HARDWARE_DIR)`);
const hardware = (...args: string[]) => execFileSync('git', ['-C', HARDWARE, ...args], { maxBuffer: 1 << 30 });
if (hardware('rev-parse', '--is-shallow-repository').toString().trim() === 'true') throw new Error(`${HARDWARE} is a shallow clone; the versions need its whole history`);

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
	// An image that pins the version names it, so a run that finds every export cached never pulls the image.
	return { command, version: process.env.KICAD_VERSION ?? kicadVersion(command), library: libraryDir() };
}
const kicad = Object.keys(boards).some((key) => key in models) ? kicadSetup() : null;

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

/**
 * Where the version's CAD board sits: the sub-assembly around its KiCad board bodies, else the part boards.json names
 * for the model. Null when it has neither.
 */
function slotOf(key: string, id: string, made: Conversion, part?: PartSlot): Slot | null {
	const parts = partsOf(gltfJson(readFileSync(made.glb)));
	const kicadBoard = findSlot(parts);
	const found = kicadBoard ? { slot: kicadBoard.slot, bodies: kicadBoard.pcbs } : part ? findPart(parts, part.part) : null;
	if (!found) return null;
	const measure: MeasureData = JSON.parse(gunzipSync(readFileSync(made.measure)).toString('utf8'));
	try {
		return { id: found.slot.id, facts: pcbFacts(measure, found.bodies, found.slot.world), centred: !kicadBoard };
	} catch (err) {
		console.warn(`${key} ${id}: no board slot, ${(err as Error).message}`);
		return null;
	}
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
const started = Date.now();
const catalogue: Catalogue = { version: 1, conversion, servers, home: HOME, models: {} };
let boardsWalked = !!kicad;
for (const [key, config] of Object.entries(models) as [string, ModelConfig][]) {
	const versions: CatalogueVersion[] = [];
	const slots: (Slot | null)[] = [];
	const sources = listVersions(HARDWARE, config.folder);
	const history = [...sources].reverse();
	const rules = followHistory(config.materials, config.commits, history);
	const ids = history.map((version) => version.id);
	for (const source of sources) {
		const made = await converted(hardware('cat-file', 'blob', source.blob), posix.basename(source.path), conversion);
		const finishes = resolveFinishes(rules, source.id, ids);
		const url = `https://raw.githubusercontent.com/${HARDWARE_REPO}/${source.commit}/${source.path.split('/').map(encodeURIComponent).join('/')}`;
		versions.push({
			id: source.id,
			commit: source.commit,
			date: source.date,
			subject: publicSubject(source.subject),
			step: { ...made.summary.step, url },
			files: filesOf(made),
			...(finishes.length ? { finishes } : {})
		});
		console.log(`${key} ${source.id} (${source.path}): ${made.cached ? 'cached' : `converted in ${made.seconds.toFixed(1)} s`}, ` +
			`${made.summary.solids} solids, ${made.summary.triangles.toLocaleString('en')} triangles, GLB ${mb(made.summary.glb.size)}, measure ${mb(made.summary.measure.size)}`);
		for (const warning of made.summary.warnings) console.warn(`  ${warning}`);
		if (key in boards) slots.push(slotOf(key, source.id, made, boards[key].slot));
	}
	if (!versions.length) throw new Error(`${key}: no ${config.folder}/${config.folder}.step or ${config.folder}/<Name>-v<n>.step in ${HARDWARE}`);

	// A board that cannot be built (its branch gone, say) leaves the model as exported; it never stops the site.
	let companions: CompanionTrack | undefined;
	if (kicad && boards[key]) {
		try {
			const board = await buildBoard(key, boards[key], { upstream: UPSTREAM, cache: '.cache', kicad, conversion, place });
			companions = board.track;
			versions.forEach((version, i) => {
				const slot = slots[i];
				const fit = slot && board.facts ? (slot.centred ? centre : register)(slot.facts, board.facts) : null;
				version.slot = fit ? { id: slot!.id, ...fit } : null;
			});
			// Said on the track, or the viewer would quietly show the newest version's own board.
			if (slots[0] && board.facts && !versions[0].slot) {
				const note = `The board does not line up with the one in ${config.title} ${versions[0].id}, which shows its board as in CAD.`;
				companions = { ...companions, notes: [...(companions.notes ?? []), note] };
			}
			const fitted = versions.filter((v) => v.slot).map((v) => v.id);
			const where = !slots.some(Boolean) ? 'no version has a board slot' : fitted.length ? `it fits ${fitted.join(', ')}` : 'it lines up with no version';
			console.log(`${key} board: ${companions.revisions.length} revision(s) of ${companions.source}, latest ${companions.latest ?? 'none'}; ${where}`);
		} catch (err) {
			console.warn(`${key} board: not built, ${(err as Error).message.split('\n')[0]}`);
			boardsWalked = false;
		}
	}
	catalogue.models[key] = { title: config.title, versions, ...(companions ? { companions } : {}) };
}
// Once every board was walked, exports this run did not use belong to older code, fixups or KiCad versions.
if (boardsWalked && existsSync('.cache/boards')) {
	for (const entry of readdirSync('.cache/boards')) if (!usedExports.has(`.cache/boards/${entry}`)) rmSync(`.cache/boards/${entry}`, { recursive: true });
}

const text = `${JSON.stringify(parseCatalogue(catalogue), null, '\t')}\n`;
assertPublic('catalogue.json', text);
writeFileSync('catalogue.json', text);
const counts = Object.entries(catalogue.models).map(([key, model]) => `${key} ${model.versions.length}`);
console.log(`catalogue.json: ${counts.join(', ')} versions, conversion ${conversion.slice(0, 12)}, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
