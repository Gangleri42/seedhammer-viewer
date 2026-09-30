import type { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { X, Y, Z, arc, cone, cylinder, disc, line, plate, point, rectangle, sampled, sphere, torus, v } from './fixtures';
import { Measurer, formatRow, formatValue } from './measure';
import { TAU } from './primitives';
import type { Anchor, Entity, Measurement, Row, RowKey } from './types';

const measure = (a: Entity, b: Entity) => new Measurer().measure(a, b);
const keys = (m: Measurement) => m.rows.map((r) => r.key);
function rowOf(m: Measurement, key: RowKey) {
	const row = m.rows.find((r) => r.key === key);
	if (!row) throw new Error(`no ${key} row in ${keys(m).join(', ')}`);
	return row;
}

/** An exact row, to 1e-6. */
function exactly(m: Measurement, key: RowKey, expected: number) {
	const row = rowOf(m, key);
	expect(row.exact, `${key} exact`).toBe(true);
	expect(row.value, key).toBeCloseTo(expected, 6);
}

/** A row to 1e-3, exact or not. */
function about(m: Measurement, key: RowKey, expected: number) {
	expect(rowOf(m, key).value, key).toBeCloseTo(expected, 3);
}

function segment(m: Measurement, role: string) {
	const anchor = m.anchors.find((a): a is Extract<Anchor, { kind: 'segment' }> => a.kind === 'segment' && a.role === role);
	if (!anchor) throw new Error(`no ${role} anchor`);
	return anchor;
}

const deg = (d: number) => (d * Math.PI) / 180;
const square = (x: number, y: number, z: number, size: number) => rectangle(v(x, y, z), v(size, 0, 0), v(0, size, 0));
const ground = () => rectangle(v(-20, -20, 0), v(40, 0, 0), v(0, 40, 0));

describe('Measurer pairs', () => {
	it('1: parallel planes 5 apart, overlapping', () => {
		const m = measure(square(0, 0, 0, 10), square(5, 5, 5, 10));
		exactly(m, 'distance', 5);
		expect(keys(m)).toEqual(['distance']);
	});

	it('2: parallel planes without overlap measure between boundary edges, with the Perpendicular', () => {
		const m = measure(square(0, 0, 0, 10), rectangle(v(13, 5, 5), v(10, 0, 0), v(0, 10, 0)));
		exactly(m, 'distance', Math.hypot(3, 5));
		exactly(m, 'perpendicular', 5);
		expect(keys(m)).toEqual(['distance', 'perpendicular']);
	});

	it('3: two holes', () => {
		const m = measure(cylinder(v(0, 0, 0), Z, X, 2, 5), cylinder(v(10, 0, 0), Z, X, 3, 5));
		exactly(m, 'distance', 5);
		exactly(m, 'centre', 10);
		exactly(m, 'min', 5);
		exactly(m, 'max', 15);
		expect(keys(m)).toEqual(['distance', 'centre', 'min', 'max']);
	});

	it('4: the holes’ top circles', () => {
		const m = measure(arc(v(0, 0, 5), Z, 2, X), arc(v(10, 0, 5), Z, 3, X));
		exactly(m, 'distance', 5);
		exactly(m, 'centre', 10);
		exactly(m, 'min', 5);
		exactly(m, 'max', 15);
		exactly(m, 'dx', 10);
		exactly(m, 'dy', 0);
		exactly(m, 'dz', 0);
		expect(keys(m)).toEqual(['distance', 'centre', 'min', 'max', 'dx', 'dy', 'dz']);
		expect(segment(m, 'min').a.distanceTo(v(2, 0, 5))).toBeLessThan(1e-9);
		expect(segment(m, 'max').b.distanceTo(v(13, 0, 5))).toBeLessThan(1e-9);
	});

	it('5: a shaft over a plane rests on a line of nearest points', () => {
		const m = measure(cylinder(v(-10, 0, 10), X, Y, 4, 20), ground());
		exactly(m, 'distance', 6);
		exactly(m, 'axisToPlane', 10);
		expect(keys(m)).toEqual(['distance', 'axisToPlane']);
	});

	it('6: the upper half of that shaft: the trim test rejects the line, the boundary lines win', () => {
		const m = measure(cylinder(v(-10, 0, 10), X, Y, 4, 20, 0, Math.PI), ground());
		exactly(m, 'distance', 10);
		exactly(m, 'axisToPlane', 10);
		expect(segment(m, 'distance').a.z).toBeCloseTo(10, 9);
	});

	it('7: skew segments', () => {
		const m = measure(line(v(0, 0, 0), v(10, 0, 0)), line(v(5, -5, 3), v(5, 5, 3)));
		exactly(m, 'distance', 3);
		exactly(m, 'angle', 90);
		expect(keys(m)).toEqual(['distance', 'angle']);
		expect(segment(m, 'distance').a.distanceTo(v(5, 0, 0))).toBeLessThan(1e-9);
	});

	it('8: skew segments whose nearest points are clamped to an end', () => {
		const m = measure(line(v(0, 0, 0), v(10, 0, 0)), line(v(15, -5, 3), v(15, 5, 3)));
		exactly(m, 'distance', Math.hypot(5, 3));
		exactly(m, 'angle', 90);
	});

	it('9: the angle opens toward the edges whichever way they run', () => {
		const a = [v(0, 0, 0), v(1, 0, 0)];
		const b = [v(0, 0, 1), v(Math.cos(deg(150)), Math.sin(deg(150)), 1)];
		for (const [a0, a1] of [a, [...a].reverse()]) {
			for (const [b0, b1] of [b, [...b].reverse()]) {
				const m = measure(line(a0, a1), line(b0, b1));
				exactly(m, 'angle', 150);
				exactly(m, 'distance', 1);
			}
		}
	});

	it('10: a face hinged on the y axis at 135° and at 45°', () => {
		for (const opening of [135, 45]) {
			const hinge = v(10 * Math.cos(deg(opening)), 0, 10 * Math.sin(deg(opening)));
			const m = measure(square(0, 0, 0, 10), rectangle(v(0, 0, 0), v(0, 10, 0), hinge));
			exactly(m, 'angle', opening);
			exactly(m, 'distance', 0);
			expect(keys(m)).toEqual(['distance', 'angle']);
		}
	});

	it('11: an edge leaving a face', () => {
		const m = measure(line(v(0, 0, 0), v(-5, 0, 5)), rectangle(v(0, -5, 0), v(10, 0, 0), v(0, 10, 0)));
		exactly(m, 'angle', 135);
		exactly(m, 'distance', 0);
		const reversed = measure(rectangle(v(0, -5, 0), v(10, 0, 0), v(0, 10, 0)), line(v(-5, 0, 5), v(0, 0, 0)));
		exactly(reversed, 'angle', 135);
	});

	it('12: a point against a quarter arc and a full circle', () => {
		const p = point(v(-10, -5, 0));
		exactly(measure(p, arc(v(0, 0, 0), Z, 10, X, 0, Math.PI / 2)), 'distance', Math.sqrt(325));
		exactly(measure(p, arc(v(0, 0, 0), Z, 10, X)), 'distance', Math.sqrt(125) - 10);
	});

	it('13: a point on the axis of a cylinder, full and half', () => {
		const p = point(v(0, 0, 2.5));
		exactly(measure(p, cylinder(v(0, 0, 0), Z, X, 5, 5)), 'distance', 5);
		exactly(measure(p, cylinder(v(0, 0, 0), Z, X, 5, 5, 0, Math.PI)), 'distance', 5);
	});

	it('14: nested circles', () => {
		const m = measure(arc(v(0, 0, 0), Z, 5, X), arc(v(1, 0, 0), Z, 2, X));
		exactly(m, 'distance', 2);
		exactly(m, 'centre', 1);
		exactly(m, 'min', 2);
		exactly(m, 'max', 8);
		const min = segment(m, 'min');
		expect(min.a.distanceTo(min.b)).toBeCloseTo(2, 9);
	});

	it('15: concentric circles', () => {
		const m = measure(arc(v(0, 0, 0), Z, 3, X), arc(v(0, 0, 0), Z, 5, X));
		exactly(m, 'distance', 2);
		exactly(m, 'centre', 0);
		exactly(m, 'min', 2);
		exactly(m, 'max', 8);
	});

	it('16: coaxial circles at different heights', () => {
		const m = measure(arc(v(0, 0, 0), Z, 3, X), arc(v(0, 0, 4), Z, 6, X));
		exactly(m, 'distance', 5);
		exactly(m, 'centre', 4);
		exactly(m, 'min', 5);
		exactly(m, 'max', Math.sqrt(97));
		const min = segment(m, 'min'), max = segment(m, 'max');
		expect(min.a.distanceTo(min.b)).toBeCloseTo(5, 9);
		expect(max.a.distanceTo(max.b)).toBeCloseTo(Math.sqrt(97), 9);
	});

	it('17: overlapping circles', () => {
		const m = measure(arc(v(0, 0, 0), Z, 5, X), arc(v(6, 0, 0), Z, 5, X));
		exactly(m, 'distance', 0);
		exactly(m, 'centre', 6);
		exactly(m, 'min', 0);
		exactly(m, 'max', 16);
		// Min is drawn at a crossing of the two circles.
		const { a } = segment(m, 'min');
		expect(a.length()).toBeCloseTo(5, 9);
		expect(a.distanceTo(v(6, 0, 0))).toBeCloseTo(5, 9);
	});

	it('18: touching stacked faces meet inside their overlap', () => {
		const m = measure(square(0, 0, 10, 10), square(5, 5, 10, 10));
		exactly(m, 'distance', 0);
		for (const p of [segment(m, 'distance').a, segment(m, 'distance').b]) {
			expect(p.x).toBeGreaterThanOrEqual(5 - 1e-9);
			expect(p.x).toBeLessThanOrEqual(10 + 1e-9);
			expect(p.y).toBeGreaterThanOrEqual(5 - 1e-9);
			expect(p.y).toBeLessThanOrEqual(10 + 1e-9);
			expect(p.z).toBeCloseTo(10, 9);
		}
	});

	it('19: a point over a hole reaches the hole’s edge', () => {
		const m = measure(point(v(0, 0, 5)), plate(10, 3));
		exactly(m, 'distance', Math.sqrt(34));
		exactly(m, 'perpendicular', 5);
	});

	it('20: a sphere over a plane', () => {
		exactly(measure(sphere(v(0, 0, 10), 3), ground()), 'distance', 7);
		exactly(measure(ground(), sphere(v(0, 0, 10), 3)), 'distance', 7);
	});

	it('21: skew cylinders', () => {
		const m = measure(cylinder(v(-10, 0, 0), X, Y, 2, 20), cylinder(v(0, -10, 10), Y, Z, 3, 20));
		exactly(m, 'distance', 5);
		exactly(m, 'axisDistance', 10);
		exactly(m, 'axisAngle', 90);
		expect(keys(m)).toEqual(['distance', 'axisDistance', 'axisAngle']);
	});

	it('22: coplanar faces side by side, closer than their tolerance', () => {
		const tol = 0.01;
		const a = rectangle(v(0, 0, 0), v(10, 0, 0), v(0, 10, 0), { tol });
		const b = rectangle(v(10.005, 0, 0), v(10, 0, 0), v(0, 10, 0), { tol });
		exactly(measure(a, b), 'distance', 0.005);
	});

	it('23: a truncated cone over a plane rests on its boundary circle', () => {
		const m = measure(cone(v(0, 0, 10), v(0, 0, -1), X, Math.PI / 4, 2, 8), ground());
		exactly(m, 'distance', 2);
	});

	it('24: a torus over a plane', () => {
		exactly(measure(torus(v(0, 0, 5), Z, X, 10, 2), ground()), 'distance', 3);
	});

	it('25: a shaft in a hole', () => {
		const m = measure(cylinder(v(0.5, 0, 0), Z, X, 4, 5), cylinder(v(0, 0, 0), Z, X, 5, 5));
		exactly(m, 'distance', 0.5);
		exactly(m, 'centre', 0.5);
		exactly(m, 'min', 0.5);
		exactly(m, 'max', 9.5);
	});

	it('27: an other face, and a soup that strays past its tolerance, give the mesh value', () => {
		const p = point(v(5, 5, 5));
		const other = measure(p, rectangle(v(0, 0, 0), v(10, 0, 0), v(0, 10, 0), { other: true }));
		expect(rowOf(other, 'distance').exact).toBe(false);
		about(other, 'distance', 5);
		expect(formatRow(rowOf(other, 'distance'), 3)).toBe('≈ 5.000 mm');

		const offset = measure(p, rectangle(v(0, 0, 0), v(10, 0, 0), v(0, 10, 0), { tol: 0.01, soupOffset: 0.2 }));
		expect(rowOf(offset, 'distance').exact).toBe(false);
		about(offset, 'distance', 4.8);
		const faces = measure(square(0, 0, 0, 10), rectangle(v(0, 0, 5), v(10, 0, 0), v(0, 10, 0), { tol: 0.01, soupOffset: -0.2 }));
		expect(rowOf(faces, 'distance').exact).toBe(false);
		about(faces, 'distance', 4.8);
	});

	it('measures a pair from a warm Measurer, and again after clear()', () => {
		const measurer = new Measurer();
		const a = cylinder(v(0, 0, 0), Z, X, 2, 5), b = cylinder(v(10, 0, 0), Z, X, 3, 5);
		exactly(measurer.measure(a, b), 'distance', 5);
		exactly(measurer.measure(b, a), 'distance', 5);
		measurer.clear();
		exactly(measurer.measure(a, b), 'distance', 5);
	});

	/** Two 5k-triangle cylinders 10 apart along ref, measured once warmed up. */
	function timed(axis: Vector3, ref: Vector3) {
		const pair = () => [cylinder(v(0, 0, 0), axis, ref, 2, 5, 0, TAU, 2500), cylinder(ref.clone().multiplyScalar(10), axis, ref, 3, 5, 0, TAU, 2500)];
		const [warmA, warmB] = pair();
		new Measurer().measure(warmA, warmB);
		const [a, b] = pair();
		const start = performance.now();
		const m = new Measurer().measure(a, b);
		return { m, elapsed: performance.now() - start };
	}

	it('measures two 5k-triangle cylinders quickly', () => {
		const { m, elapsed } = timed(Z, X);
		exactly(m, 'distance', 5);
		// About 5 ms here and 25 on a shared CI runner; the pairwise search this replaced took seconds.
		expect(elapsed).toBeLessThan(500);
	});

	it('measures the same pair tilted off the world axes about as quickly', () => {
		const aligned = timed(Z, X);
		const tilted = timed(v(1, 1, 1).normalize(), v(1, -1, 0).normalize());
		exactly(tilted.m, 'distance', 5);
		exactly(tilted.m, 'centre', 10);
		// Against the aligned pair on the same machine, so a slow runner cannot fail it; boxes loosened by the tilt made
		// the search 20 to 40 times slower before it learned to align with the faces.
		expect(tilted.elapsed).toBeLessThan(aligned.elapsed * 4 + 25);
	});
});

describe('Measurer on adjacent and touching geometry', () => {
	it('measures a cube’s faces, edges and corners', () => {
		const bottom = rectangle(v(0, 0, 0), v(0, 10, 0), v(10, 0, 0));
		const top = rectangle(v(0, 0, 10), v(10, 0, 0), v(0, 10, 0));
		const front = rectangle(v(0, 0, 0), v(10, 0, 0), v(0, 0, 10));
		const adjacent = measure(bottom, front);
		exactly(adjacent, 'distance', 0);
		exactly(adjacent, 'angle', 90);
		const opposite = measure(bottom, top);
		exactly(opposite, 'distance', 10);
		expect(keys(opposite)).toEqual(['distance']);
		// A face against its own edge, and an edge of the top against the bottom.
		exactly(measure(bottom, bottom.edges[0]), 'distance', 0);
		const across = measure(top.edges[0], bottom);
		exactly(across, 'distance', 10);
		expect(keys(across)).toEqual(['distance']);
		// A corner of the top against the bottom and against the front.
		exactly(measure(point(v(10, 10, 10)), bottom), 'distance', 10);
		exactly(measure(point(v(10, 10, 10)), front), 'distance', 10);
		exactly(measure(bottom, bottom), 'distance', 0);
	});

	it('a cylinder meets its cap on their shared circle', () => {
		const wall = cylinder(v(0, 0, 0), Z, X, 3, 5), cap = disc(v(0, 0, 5), Z, X, 3);
		const m = measure(cap, wall);
		exactly(m, 'distance', 0);
		exactly(m, 'centre', 0);
		exactly(m, 'min', 0);
		exactly(m, 'max', 6);
		expect(keys(new Measurer().properties(cap))).toEqual(['area', 'loopLength', 'centreX', 'centreY', 'centreZ']);
	});

	it('a sphere resting on a plane and a shaft lying on it touch', () => {
		exactly(measure(sphere(v(0, 0, 3), 3), ground()), 'distance', 0);
		exactly(measure(cylinder(v(-10, 0, 4), X, Y, 4, 20), ground()), 'distance', 0);
	});

	it('coaxial cylinders 0.001 apart', () => {
		const m = measure(cylinder(v(0, 0, 0), Z, X, 5, 5), cylinder(v(0, 0, 0), Z, X, 5.001, 5));
		exactly(m, 'distance', 0.001);
		exactly(m, 'centre', 0);
		exactly(m, 'min', 0.001);
		exactly(m, 'max', 10.001);
	});

	it('marks what comes from a polyline as approximate', () => {
		const curve = sampled(v(0, 0, 0), Z, 10, X, Math.PI);
		const m = measure(point(v(0, 20, 0)), curve);
		expect(rowOf(m, 'distance').exact).toBe(false);
		about(m, 'distance', 10);
		const below = measure(curve, rectangle(v(-20, -20, -3), v(40, 0, 0), v(0, 40, 0)));
		expect(rowOf(below, 'distance').exact).toBe(false);
		about(below, 'distance', 3);
	});

	it('draws the angle, centre and ΔX ΔY ΔZ anchors where the geometry is', () => {
		const m = measure(line(v(0, 0, 0), v(10, 0, 0)), line(v(0, 0, 0), v(0, 10, 0)));
		expect(m.anchors.find((a) => a.kind === 'angle')).toEqual({ kind: 'angle', apex: v(0, 0, 0), a: v(5, 0, 0), b: v(0, 5, 0) });
		const centre = segment(measure(arc(v(0, 0, 0), Z, 2, X), arc(v(10, 0, 0), Z, 3, X)), 'centre');
		expect([centre.a, centre.b]).toEqual([v(0, 0, 0), v(10, 0, 0)]);
		const points = measure(point(v(1, 2, 3)), point(v(4, 6, 8)));
		const legs = ['dx', 'dy', 'dz'].map((role) => segment(points, role));
		expect(legs.map((s) => [s.a.toArray(), s.b.toArray()])).toEqual([
			[[1, 2, 3], [4, 2, 3]],
			[[4, 2, 3], [4, 6, 3]],
			[[4, 6, 3], [4, 6, 8]]
		]);
	});
});

describe('Measurer properties', () => {
	it('26: an arc and a cone', () => {
		const measurer = new Measurer();
		const quarter = measurer.properties(arc(v(0, 0, 0), Z, 10, X, 0, Math.PI / 2));
		expect(keys(quarter)).toEqual(['length', 'radius', 'diameter', 'centreX', 'centreY', 'centreZ']);
		exactly(quarter, 'length', 5 * Math.PI);
		exactly(quarter, 'radius', 10);
		exactly(quarter, 'diameter', 20);
		for (const key of ['centreX', 'centreY', 'centreZ'] as const) exactly(quarter, key, 0);
		expect(quarter.anchors).toEqual([{ kind: 'point', role: 'centre', at: v(0, 0, 0) }]);

		const conical = measurer.properties(cone(v(0, 0, 10), v(0, 0, -1), X, Math.PI / 4, 2, 8));
		expect(keys(conical)).toEqual(['area', 'loopLength', 'coneAngle']);
		exactly(conical, 'coneAngle', 90);
	});

	it('gives each selection Fusion’s properties', () => {
		const measurer = new Measurer();
		expect(keys(measurer.properties(point(v(1, 2, 3))))).toEqual(['x', 'y', 'z']);
		expect(keys(measurer.properties(line(v(0, 0, 0), v(3, 4, 0))))).toEqual(['length']);
		expect(keys(measurer.properties(square(0, 0, 0, 10)))).toEqual(['area', 'loopLength']);
		expect(keys(measurer.properties(cylinder(v(0, 0, 0), Z, X, 2, 5)))).toEqual(['radius', 'diameter', 'area', 'loopLength']);
		expect(keys(measurer.properties(sphere(v(0, 0, 0), 3)))).toEqual(['radius', 'diameter', 'area', 'loopLength']);
		const fillet = measurer.properties(torus(v(0, 0, 0), Z, X, 10, 2));
		expect(keys(fillet)).toEqual(['radius', 'diameter', 'area', 'loopLength']);
		exactly(fillet, 'radius', 2);
		const holed = measurer.properties(plate(10, 3));
		expect(keys(holed)).toEqual(['area', 'loopLength']);
		expect(holed.rows.map((r) => r.label)).toEqual(['Area', 'Loop length']);
		expect(rowOf(holed, 'area').unit).toBe('mm²');
	});
});

describe('formatting', () => {
	it('28: fixed decimals, no negative zero, ≈ for approximate values', () => {
		const row = (value: number, unit: Row['unit'], exact = true): Row => ({ key: 'distance', label: 'Distance', value, unit, exact });
		expect(formatRow(row(-0.0002, 'mm'), 3)).toBe('0.000 mm');
		expect(formatRow(row(12.34567, 'mm', false), 3)).toBe('≈ 12.346 mm');
		expect(formatRow(row(135, '°'), 2)).toBe('135.00°');
		expect(formatRow(row(100 * Math.PI, 'mm²'), 3)).toBe('314.159 mm²');
		expect(formatValue(12.346, 'mm', 2, true)).toBe('12.35 mm');
		expect(formatValue(-0.004, 'mm', 2, true)).toBe('0.00 mm');
		expect(formatValue(-3.5, 'mm', 1, true)).toBe('-3.5 mm');
		expect(formatValue(0.1234, 'mm', 2, false)).toBe('≈ 0.12 mm');
	});
});
