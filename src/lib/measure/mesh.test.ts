import { Vector3 } from 'three';
import { ExtendedTriangle } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { cylinder, rectangle, sphere, v, X, Z } from './fixtures';
import { ARC_PROXY, FaceIndex, curveIndex, meshPair } from './mesh';

const index = (face: { soup: Float32Array; tol: number }) => new FaceIndex(face.soup, face.tol);

describe('FaceIndex', () => {
	const square = index(rectangle(v(0, 0, 0), v(10, 0, 0), v(0, 10, 0)));

	it('keeps points on the face, within its tolerance', () => {
		expect(square.contains(v(3, 7, 0))).toBe(true);
		expect(square.contains(v(3, 7, 0.005))).toBe(true);
		expect(square.contains(v(3, 7, 0.01))).toBe(false);
		expect(square.contains(v(-0.001, 5, 0))).toBe(false);
	});

	it('leaves the border to the edges', () => {
		expect(square.contains(v(10, 5, 0))).toBe(false);
		expect(square.contains(v(10 - 5e-6, 5, 0))).toBe(false);
		expect(square.contains(v(10 - 1e-4, 5, 0))).toBe(true);
		// Corners, and vertices where the border meets inner edges.
		expect(square.contains(v(0, 0, 0))).toBe(false);
		expect(square.contains(v(2.5, 0, 0))).toBe(false);
		expect(square.contains(v(2.5, 2.5, 0))).toBe(true);
	});

	it('welds a closed soup at its seam, so the seam is not a border', () => {
		const tube = index(cylinder(v(0, 0, 0), Z, X, 2, 5));
		expect(tube.contains(v(2, 0, 2.5))).toBe(true);
		expect(tube.contains(v(2, 0, 0))).toBe(false);
		expect(index(sphere(v(0, 0, 0), 3)).contains(v(0, 0, 3))).toBe(true);
	});

	it('knows its box, centroid and extent', () => {
		expect(square.centroid.distanceTo(v(5, 5, 0))).toBeLessThan(1e-6);
		expect(square.box.max.x).toBeCloseTo(10, 6);
		expect(square.extent(v(0, 0, 0), new Vector3(1, 1, 0).normalize())).toEqual([0, expect.closeTo(Math.hypot(10, 10), 5)]);
	});

	it('handles an empty soup', () => {
		const empty = new FaceIndex(new Float32Array(0), 0.01);
		expect(empty.nearest(v(0, 0, 0))).toBeNull();
		expect(empty.contains(v(0, 0, 0))).toBe(false);
		expect(meshPair(empty.bvh, square.bvh)).toBeNull();
	});
});

describe('meshPair', () => {
	it('matches brute force between two tilted meshes', () => {
		const a = rectangle(v(0, 0, 0), v(10, 2, 1), v(-1, 8, 3));
		const b = cylinder(v(4, 3, 8), new Vector3(1, 1, 1).normalize(), new Vector3(1, -1, 0).normalize(), 2, 6);
		const pair = meshPair(index(a).bvh, index(b).bvh);
		const triangle = (soup: Float32Array, i: number) => {
			const t = new ExtendedTriangle();
			t.set(new Vector3().fromArray(soup, i), new Vector3().fromArray(soup, i + 3), new Vector3().fromArray(soup, i + 6));
			return t;
		};
		let brute = Infinity;
		for (let i = 0; i < a.soup.length; i += 9) {
			const ta = triangle(a.soup, i);
			for (let j = 0; j < b.soup.length; j += 9) brute = Math.min(brute, ta.distanceToTriangle(triangle(b.soup, j)));
		}
		expect(pair?.distance).toBeCloseTo(brute, 9);
		expect(pair?.a.distanceTo(pair.b)).toBeCloseTo(pair?.distance ?? NaN, 9);
	});

	it('puts the witness of overlapping coplanar faces on both, not at the origin', () => {
		const pair = meshPair(index(rectangle(v(3, 3, 10), v(10, 0, 0), v(0, 10, 0))).bvh, index(rectangle(v(8, 8, 10), v(10, 0, 0), v(0, 10, 0))).bvh);
		expect(pair?.distance).toBe(0);
		expect(pair?.a.distanceTo(pair.b)).toBeLessThan(1e-8);
		for (const axis of ['x', 'y'] as const) {
			expect(pair?.a[axis]).toBeGreaterThanOrEqual(8 - 1e-6);
			expect(pair?.a[axis]).toBeLessThanOrEqual(13 + 1e-6);
		}
	});

	it('measures curves through their segments', () => {
		const line = curveIndex({ kind: 'line', start: v(0, 0, 5), end: v(10, 0, 5) });
		const pair = meshPair(line.bvh, index(rectangle(v(0, -5, 0), v(10, 0, 0), v(0, 10, 0))).bvh);
		expect(pair?.distance).toBeCloseTo(5, 6);
		const arc = curveIndex({ kind: 'arc', centre: v(0, 0, 0), normal: v(0, 0, 1), radius: 5, ref: v(1, 0, 0), start: 0, sweep: 2 * Math.PI });
		expect(arc.tol).toBe(ARC_PROXY);
		expect(line.tol).toBe(0);
		expect(meshPair(arc.bvh, line.bvh)?.distance).toBeCloseTo(5, 6);
	});
});
