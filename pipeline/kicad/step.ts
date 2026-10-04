// Running kicad-cli, and making its STEP files depend on the board alone.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MAC_APP = '/Applications/KiCad/KiCad.app/Contents';

/** The kicad-cli command: KICAD_CLI (a command prefix, such as a docker run), else the Mac app when installed. */
export function kicadCommand(env = process.env): string[] | null {
	if (env.KICAD_CLI) return env.KICAD_CLI.split(' ').filter(Boolean);
	return existsSync(`${MAC_APP}/MacOS/kicad-cli`) ? [`${MAC_APP}/MacOS/kicad-cli`] : null;
}

/** KiCad's 3D library as kicad-cli sees it: KICAD_3DMODELS, else the Mac app's, else the Linux package path. */
export function libraryDir(env = process.env) {
	if (env.KICAD_3DMODELS) return env.KICAD_3DMODELS;
	return existsSync(`${MAC_APP}/SharedSupport/3dmodels`) ? `${MAC_APP}/SharedSupport/3dmodels` : '/usr/share/kicad/3dmodels';
}

export function kicadVersion(command: string[]) {
	const run = spawnSync(command[0], [...command.slice(1), 'version'], { encoding: 'utf8' });
	if (run.status !== 0) throw new Error(`kicad-cli version failed: ${(run.stderr || run.stdout).trim()}`);
	return run.stdout.trim();
}

// Default origin (KiCad's page origin), as the boards go into Fusion. --subst-models takes a STEP for a VRML model.
export const EXPORT_ARGS = ['pcb', 'export', 'step', '-f', '--subst-models'];

export type StepExport = { log: string; notFound: Set<string>; malformed: boolean };

/**
 * Exports `board` to `out`. Every KiCad version's library variable points at the one library, since a footprint keeps
 * the variable of the KiCad that last saved it.
 */
export function exportStep(command: string[], board: string, out: string, library: string): StepExport {
	const vars = [6, 7, 8, 9, 10].flatMap((n) => ['-D', `KICAD${n}_3DMODEL_DIR=${library}`]);
	const run = spawnSync(command[0], [...command.slice(1), ...EXPORT_ARGS, ...vars, '-o', out, board], { encoding: 'utf8', maxBuffer: 1 << 26 });
	const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
	if (run.status !== 0 || !existsSync(out)) throw new Error(`kicad-cli could not export the board (exit ${run.status})`);
	const notFound = new Set([...log.matchAll(/File not found: (.+)$/gm)].map((m) => m[1].trim()));
	return { log, notFound, malformed: /outline is malformed|malformed outline/i.test(log) };
}

const FILE_NAME = /FILE_NAME\(\s*'(?:[^']|'')*'\s*,\s*'[^']*'/;

/** KiCad writes the output file's name and the local time into the header: a fixed name and time keep neither. */
export function normaliseHeader(step: string, name: string) {
	const header = step.slice(0, 4096);
	if (!FILE_NAME.test(header)) throw new Error('the STEP header has no FILE_NAME');
	return header.replace(FILE_NAME, `FILE_NAME('${name.replace(/'/g, "''")}','2020-01-01T00:00:00'`) + step.slice(4096);
}
