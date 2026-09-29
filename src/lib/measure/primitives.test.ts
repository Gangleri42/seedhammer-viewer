import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { arcFoot, curveBox, lineLine, minimise, segmentSegment, surfaceFoot, type Arc } from './primitives';
import type { Surface } from './types';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

function foot(surface: Surface, q: Vector3, hint?: Vector3) {
	const at = new Vector3();
	const signed = surfaceFoot(surface, q, at, hint);
	return { signed, at };
}

describe('surface feet', () => {
	it('projects onto a plane with a signed distance along its normal', () => {
		const { signed, at } = foot({ kind: 'plane', origin: v(0, 0, 1), normal: v(0, 0, 2) }, v(3, 4, -2));
		expect(signed).toBeCloseTo(-3, 12);
		expect(at.distanceTo(v(3, 4, 1))).toBeLessThan(1e-12);
	});

	it('projects onto a cylinder, and follows the hint from its axis', () => {
		const cylinder: Surface = { kind: 'cylinder', origin: v(0, 0, 0), axis: v(0, 0, 1), radius: 2 };
		const outside = foot(cylinder, v(5, 0, 7));
		expect(outside.signed).toBeCloseTo(3, 12);
		expect(outside.at.distanceTo(v(2, 0, 7))).toBeLessThan(1e-12);
		expect(foot(cylinder, v(0, 1, 0)).signed).toBeCloseTo(-1, 12);
		const onAxis = foot(cylinder, v(0, 0, 3), v(0, -7, 0));
		expect(onAxis.at.distanceTo(v(0, -2, 3))).toBeLessThan(1e-12);
	});

	it('projects onto a sphere, and follows the hint from its centre', () => {
		const sphere: Surface = { kind: 'sphere', centre: v(1, 1, 1), radius: 2 };
		expect(foot(sphere, v(1, 1, 5)).signed).toBeCloseTo(2, 12);
		expect(foot(sphere, v(1, 1, 1), v(4, 1, 1)).at.distanceTo(v(3, 1, 1))).toBeLessThan(1e-12);
	});

	it('projects onto a cone, and onto its apex from behind', () => {
		const cone: Surface = { kind: 'cone', apex: v(0, 0, 0), axis: v(0, 0, 1), halfAngle: Math.PI / 4 };
		const front = foot(cone, v(4, 0, 2));
		expect(front.signed).toBeCloseTo(Math.SQRT2, 12);
		expect(front.at.distanceTo(v(3, 0, 3))).toBeLessThan(1e-12);
		const behind = foot(cone, v(1, 0, -3));
		expect(behind.at.length()).toBeLessThan(1e-12);
		expect(behind.signed).toBeCloseTo(Math.hypot(1, 3), 12);
	});

	it('projects onto a torus', () => {
		const torus: Surface = { kind: 'torus', centre: v(0, 0, 0), axis: v(0, 0, 1), major: 10, minor: 2 };
		const above = foot(torus, v(10, 0, 5));
		expect(above.signed).toBeCloseTo(3, 12);
		expect(above.at.distanceTo(v(10, 0, 2))).toBeLessThan(1e-12);
		expect(foot(torus, v(0, 11, 0)).signed).toBeCloseTo(-1, 12);
	});
});

describe('arc feet', () => {
	const quarter: Arc = { kind: 'arc', centre: v(0, 0, 0), normal: v(0, 0, 1), radius: 10, ref: v(1, 0, 0), start: 0, sweep: Math.PI / 2 };

	it('lands inside the sweep, or on the nearer end', () => {
		const at = new Vector3();
		expect(arcFoot(quarter, v(10, 10, 3), at)).toBeCloseTo(Math.hypot(10 * Math.SQRT2 - 10, 3), 12);
		arcFoot(quarter, v(-10, -5, 0), at);
		expect(at.distanceTo(v(0, 10, 0))).toBeLessThan(1e-12);
		arcFoot(quarter, v(5, -10, 0), at);
		expect(at.distanceTo(v(10, 0, 0))).toBeLessThan(1e-12);
	});

	it('is equally near everywhere from its axis', () => {
		const at = new Vector3();
		expect(arcFoot(quarter, v(0, 0, 5), at)).toBeCloseTo(Math.hypot(10, 5), 12);
		arcFoot(quarter, v(0, 0, 5), at, v(0, 3, 0));
		expect(at.distanceTo(v(0, 10, 0))).toBeLessThan(1e-12);
	});

	it('has a box that reaches the arc’s extremes', () => {
		const box = curveBox({ ...quarter, start: Math.PI / 4 }, new Box3());
		expect(box.max.y).toBeCloseTo(10, 12);
		expect(box.max.x).toBeCloseTo(10 * Math.SQRT1_2, 12);
		expect(box.min.x).toBeCloseTo(-10 * Math.SQRT1_2, 12);
	});
});

describe('segments and lines', () => {
	it('meets parallel overlapping segments in the middle of their overlap', () => {
		const pa = new Vector3(), pb = new Vector3();
		expect(segmentSegment(v(0, 0, 0), v(10, 0, 0), v(4, 3, 0), v(20, 3, 0), pa, pb)).toBeCloseTo(3, 12);
		expect(pa.distanceTo(v(7, 0, 0))).toBeLessThan(1e-12);
		expect(pb.distanceTo(v(7, 3, 0))).toBeLessThan(1e-12);
	});

	it('handles a segment that is a point', () => {
		const pa = new Vector3(), pb = new Vector3();
		expect(segmentSegment(v(1, 1, 1), v(1, 1, 1), v(0, 0, 0), v(2, 0, 0), pa, pb)).toBeCloseTo(Math.SQRT2, 12);
		expect(pb.distanceTo(v(1, 0, 0))).toBeLessThan(1e-12);
	});

	it('finds the closest points of skew lines, and none for parallel ones', () => {
		const at = lineLine(v(0, 0, 0), v(1, 0, 0), v(3, -2, 5), v(0, 1, 0));
		expect(at?.s).toBeCloseTo(3, 12);
		expect(at?.t).toBeCloseTo(2, 12);
		expect(lineLine(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(-1, 0, 0))).toBeNull();
	});
});

describe('minimise', () => {
	it('refines every sampled minimum and keeps the lowest first', () => {
		const f = (t: number) => Math.min((t - 1) ** 2 + 0.5, (t - 4) ** 2);
		const { minima, flat } = minimise(f, 0, 5, 33);
		expect(flat).toBe(false);
		expect(minima[0].t).toBeCloseTo(4, 6);
		expect(minima[0].value).toBeCloseTo(0, 12);
		expect(minima.some((m) => Math.abs(m.t - 1) < 1e-6)).toBe(true);
	});

	it('finds a minimum at the end of the range and a V-shaped one', () => {
		expect(minimise((t) => t, 2, 3, 17).minima[0]).toEqual({ t: 2, value: 2 });
		expect(minimise((t) => Math.abs(t - Math.PI), 0, 10, 33).minima[0].t).toBeCloseTo(Math.PI, 10);
	});

	it('reports a family of equal values as flat', () => {
		const { flat, samples } = minimise(() => 5, 0, 1, 33);
		expect(flat).toBe(true);
		expect(samples).toHaveLength(33);
	});
});
