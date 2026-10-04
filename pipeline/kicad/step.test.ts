import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { exportStep, kicadCommand, normaliseHeader } from './step.ts';

const HEADER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('KiCad electronic assembly'),'2;1');
FILE_NAME('seed.step','2026-10-04T10:32:44',('Pcbnew'),('Kicad'),
  'Open CASCADE STEP processor 7.9','KiCad to STEP converter','Unknown'
  );
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#7 = PRODUCT('seed 1','seed 1','',(#8));
`;

describe('STEP headers', () => {
	it('replaces the file name and the local time, nothing else', () => {
		const out = normaliseHeader(HEADER, 'seed-1a2b3c4.step');
		expect(out).toContain(`FILE_NAME('seed-1a2b3c4.step','2020-01-01T00:00:00',('Pcbnew'),('Kicad'),`);
		expect(out.replace(/FILE_NAME\([^,]*,[^,]*,/, '')).toBe(HEADER.replace(/FILE_NAME\([^,]*,[^,]*,/, ''));
		expect(normaliseHeader(out, 'seed-1a2b3c4.step')).toBe(out);
	});

	it('refuses a file without FILE_NAME', () => {
		expect(() => normaliseHeader('ISO-10303-21;\nDATA;\n', 'x.step')).toThrow(/FILE_NAME/);
	});
});

describe('kicad-cli', () => {
	it('takes KICAD_CLI as a command prefix', () => {
		expect(kicadCommand({ KICAD_CLI: 'docker run --rm -v /w:/w kicad/kicad:10.0.6-full kicad-cli' })).toEqual(['docker', 'run', '--rm', '-v', '/w:/w', 'kicad/kicad:10.0.6-full', 'kicad-cli']);
	});

	it('reads missing models and a malformed outline from the log', () => {
		// Stands in for kicad-cli: writes the output file and prints what KiCad prints.
		const fake = ['node', '-e', [
			"const a = process.argv, out = a[a.indexOf('-o') + 1];",
			"require('fs').writeFileSync(out, 'ISO-10303-21;' + JSON.stringify(a.slice(a.indexOf('pcb'))));",
			"console.log('File not found: ${KICAD10_3DMODEL_DIR}/A.3dshapes/B.step');",
			"console.error('Board outline is malformed');"
		].join('\n'), '--'];
		const out = `${mkdtempSync(`${tmpdir()}/kicad-`)}/b.step`;
		const result = exportStep(fake, 'board.kicad_pcb', out, '/lib/3d');
		expect([...result.notFound]).toEqual(['${KICAD10_3DMODEL_DIR}/A.3dshapes/B.step']);
		expect(result.malformed).toBe(true);
		const args = JSON.parse(readFileSync(out, 'utf8').slice('ISO-10303-21;'.length));
		expect(args.slice(0, 5)).toEqual(['pcb', 'export', 'step', '-f', '--subst-models']);
		expect(args).toContain('KICAD6_3DMODEL_DIR=/lib/3d');
		expect(args).toContain('KICAD10_3DMODEL_DIR=/lib/3d');
		expect(args.slice(-3)).toEqual(['-o', out, 'board.kicad_pcb']);
	});
});
