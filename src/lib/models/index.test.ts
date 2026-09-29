// The built manifest must describe the built files: the hashes are what Blossom serves them under. Runs when the
// models have been built (npm run models); static/models is not committed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDGE, FACE, readMeasure } from '$lib/measure/format';
import type { ModelFile, ModelIndex, ModelVersion } from './types';

const INDEX = 'static/models/index.json';
const built = existsSync(INDEX);
const index: ModelIndex = built ? JSON.parse(readFileSync(INDEX, 'utf8')) : { version: 2, models: {} };
const files = Object.values(index.models).flatMap((m) => m.versions.flatMap((v) => [v.glb, v.step, ...(v.measure ? [v.measure] : []), ...(v.plain ? [v.plain] : [])]));
const measured = Object.entries(index.models).flatMap(([key, m]) => m.versions.filter((v) => v.measure).map((v): [string, ModelVersion] => [`${key} v${v.version}`, v]));

/** The JSON chunk of a GLB. */
function glbJson(path: string) {
	const glb = readFileSync(path);
	return JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
}
const unit = (v: number[]) => Math.abs(Math.hypot(...v) - 1) < 1e-5;

describe.skipIf(!built)('static/models/index.json', () => {
	it('is schema v2 with every model sorted newest first', () => {
		expect(index.version).toBe(2);
		expect(Object.keys(index.models).length).toBeGreaterThan(0);
		for (const entry of Object.values(index.models)) {
			expect(entry.versions.length).toBeGreaterThan(0);
			expect(entry.latest).toBe(entry.versions[0].version);
			expect([...entry.versions].sort((a, b) => b.version - a.version)).toEqual(entry.versions);
		}
	});

	it.each(files.map((f): [string, ModelFile] => [f.path, f]))('%s matches its size and sha256', (_path, file) => {
		const data = readFileSync(`static/models/${file.path}`);
		expect(data.byteLength).toBe(file.bytes);
		expect(createHash('sha256').update(data).digest('hex')).toBe(file.sha256);
		expect(file.path).not.toMatch(/^\/|\.\./);
	});
});

describe.skipIf(!built || !measured.length)('measurement files', () => {
	it.each(measured)('%s matches its GLB', async (_name, version) => {
		const bytes = readFileSync(`static/models/${version.measure!.path}`);
		expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
		const file = await readMeasure(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		expect(file.glb).toBe(version.glb.sha256);

		for (const solid of file.solids) {
			if (!solid) continue;
			const vertices = solid.p.length / 3;
			expect(solid.tol).toBeGreaterThan(0);
			for (const edge of solid.e) {
				if (!edge) continue;
				for (const v of [edge[1], edge[2]]) expect(v >= -1 && v < vertices).toBe(true);
				if (edge[0] === EDGE.arc) {
					expect(unit(edge.slice(6, 9) as number[]) && unit(edge.slice(9, 12) as number[])).toBe(true);
					expect(edge[13] > 0 && edge[13] <= 2 * Math.PI + 1e-6).toBe(true);
				}
			}
			for (const face of solid.f) {
				for (const loop of face[2]) for (const e of loop) expect(solid.e[e]).toBeTruthy();
				const surface = face.slice(3) as number[];
				if (face[0] === FACE.plane) expect(unit(surface.slice(0, 3))).toBe(true);
				if (face[0] === FACE.cylinder || face[0] === FACE.cone || face[0] === FACE.torus) expect(unit(surface.slice(3, 6))).toBe(true);
			}
		}

		// Every body names a solid, and every surface primitive carries its face ids.
		const gltf = glbJson(`static/models/${version.glb.path}`);
		for (const node of gltf.nodes) {
			if (!node.extras?.body) continue;
			expect(file.solids[node.extras.solid]).toBeTruthy();
			for (const primitive of gltf.meshes[node.mesh].primitives) {
				if ((primitive.mode ?? 4) === 4) expect(primitive.attributes._FACEID).toBeDefined();
			}
		}
	});
});
