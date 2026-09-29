import { describe, expect, it } from 'vitest';
import { FACE, readMeasure, type FaceRecord } from '../src/lib/measure/format.ts';
import { buildMeasure, surfaceDistance, thin, type RawMeasure, type SolidMesh } from './measure.ts';

const loops = [[0]];
const face = (kind: number, ...surface: number[]): FaceRecord => [kind, 1, loops, ...surface];

describe('exact surfaces', () => {
	it.each([
		['plane z = 5', face(FACE.plane, 0, 0, 1, 5), [1, 2, 7], 2],
		['cylinder r = 3 on the z axis', face(FACE.cylinder, 0, 0, 0, 0, 0, 1, 10, 3, -1), [5, 0, 2], 2],
		['cone at 45°, a point on it', face(FACE.cone, 0, 0, 0, 0, 0, 1, Math.PI / 4, 1), [1, 0, 1], 0],
		['cone at 45°, a point behind its apex', face(FACE.cone, 0, 0, 0, 0, 0, 1, Math.PI / 4, 1), [0, 0, -1], 1],
		['sphere r = 3', face(FACE.sphere, 0, 0, 10, 3, 1), [0, 0, 0], 7],
		['torus R = 10, r = 2', face(FACE.torus, 0, 0, 0, 0, 0, 1, 10, 2, 1), [10, 0, 5], 3]
	])('measures the distance to a %s', (_name, record, [x, y, z], expected) => {
		expect(surfaceDistance(record, x, y, z)).toBeCloseTo(expected, 9);
	});

	it('has no surface for a free-form face', () => {
		expect(surfaceDistance(face(FACE.other), 0, 0, 0)).toBeNull();
	});
});

describe('polyline thinning', () => {
	it('drops points on a straight run and keeps the ends and corners', () => {
		expect(thin([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], 0.01)).toEqual([0, 0, 0, 3, 0, 0]);
		expect(thin([0, 0, 0, 1, 0, 0, 1, 1, 0], 0.01)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
	});
});

/** A 10 × 10 square on z = 0 as two triangles, tessellated with its last vertex lifted by `lift`. */
function square(lift = 0): { raw: RawMeasure; mesh: SolidMesh } {
	const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, lift]);
	const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
	const raw: RawMeasure = {
		v: 1,
		solids: [{ p: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], e: [[0, 0, 1], [0, 1, 2], [0, 2, 3], [0, 3, 0]], f: [[FACE.plane, 100, [[0, 1, 2, 3]], 0, 0, 1, 0]] }]
	};
	const mesh: SolidMesh = {
		positions,
		indices,
		faces: new Uint16Array(4),
		original: { positions, indices, faces: new Uint32Array(2) },
		error: 0.01
	};
	return { raw, mesh };
}

describe('measurement file', () => {
	it('gives the same bytes on every build and reads back', async () => {
		const { raw, mesh } = square();
		const first = buildMeasure(raw, [mesh], 'ab'.repeat(32));
		const second = buildMeasure(raw, [mesh], 'ab'.repeat(32));
		expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
		// gzip without a file time.
		expect([...first.bytes.subarray(0, 8)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
		const file = await readMeasure(first.bytes.slice().buffer);
		expect(file).toMatchObject({ v: 1, units: 'mm', glb: 'ab'.repeat(32) });
		const solid = file.solids[0]!;
		expect(solid.f[0]).toEqual([FACE.plane, 100, [[0, 1, 2, 3]], 0, 0, 1, 0]);
		// At least the simplify error plus the tessellation's deflection.
		expect(solid.tol).toBeGreaterThanOrEqual(0.02);
	});

	it('reads a file a server already inflated', async () => {
		const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, units: 'mm', glb: '', solids: [] }));
		await expect(readMeasure(bytes.buffer)).resolves.toMatchObject({ v: 1, solids: [] });
		await expect(readMeasure(new TextEncoder().encode('{"v":2}').buffer)).rejects.toThrow();
	});

	it('treats a face whose tessellation leaves its surface as free-form', async () => {
		const { raw, mesh } = square(0.05);
		const file = await readMeasure(buildMeasure(raw, [mesh], '').bytes.slice().buffer);
		expect(file.solids[0]!.f[0]).toEqual([FACE.other, 100, [[0, 1, 2, 3]]]);
	});
});
