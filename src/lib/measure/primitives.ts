import { Box3, Line3, Vector3 } from 'three';
import type { Curve, Surface } from './types';

/** Directions within this many radians of each other are parallel. */
export const PARALLEL = 1e-6;
/** Lengths under this many millimetres are zero: a degenerate edge, a point on an axis. */
export const ZERO = 1e-9;
export const TAU = 2 * Math.PI;

export type Arc = Extract<Curve, { kind: 'arc' }>;

const mod = (x: number, m: number) => ((x % m) + m) % m;

const _cross = new Vector3();

/** Angle between two directions, 0..π. atan2 keeps small angles accurate where acos loses them. */
export function angleBetween(u: Vector3, v: Vector3) {
	return Math.atan2(_cross.crossVectors(u, v).length(), u.dot(v));
}

/** Angle between two lines with these directions, 0..π/2. */
export function acute(u: Vector3, v: Vector3) {
	return Math.atan2(_cross.crossVectors(u, v).length(), Math.abs(u.dot(v)));
}

/** Some unit vector perpendicular to the unit vector n. */
export function perpendicular(n: Vector3, target: Vector3) {
	// Cross with the coordinate axis least aligned with n.
	const x = Math.abs(n.x), y = Math.abs(n.y), z = Math.abs(n.z);
	if (x <= y && x <= z) target.set(0, -n.z, n.y);
	else if (y <= z) target.set(n.z, 0, -n.x);
	else target.set(-n.y, n.x, 0);
	return target.normalize();
}

const units = new WeakMap<Surface, Surface>();

/** The surface with a unit normal or axis: exported data carries float32 rounding, and the projections assume unit. */
export function unitSurface(s: Surface): Surface {
	let unit = units.get(s);
	if (!unit) {
		if (s.kind === 'plane') unit = { ...s, normal: s.normal.clone().normalize() };
		else if (s.kind === 'cylinder' || s.kind === 'cone' || s.kind === 'torus') unit = { ...s, axis: s.axis.clone().normalize() };
		else unit = s;
		units.set(s, unit);
	}
	return unit;
}

type ArcFrame = { normal: Vector3; e1: Vector3; e2: Vector3; start: number; sweep: number; full: boolean };
const frames = new WeakMap<Arc, ArcFrame>();

/** The arc's orthonormal frame (ref made perpendicular to the normal) and its range, the sweep capped at a turn. */
export function arcFrame(arc: Arc): ArcFrame {
	let frame = frames.get(arc);
	if (!frame) {
		const normal = arc.normal.clone().normalize();
		const e1 = arc.ref.clone().addScaledVector(normal, -arc.ref.dot(normal));
		if (e1.lengthSq() < 1e-12) perpendicular(normal, e1);
		else e1.normalize();
		const full = Math.abs(arc.sweep) >= TAU - 1e-9;
		const start = arc.sweep < 0 ? arc.start + arc.sweep : arc.start;
		frame = { normal, e1, e2: new Vector3().crossVectors(normal, e1), start, sweep: full ? TAU : Math.abs(arc.sweep), full };
		frames.set(arc, frame);
	}
	return frame;
}

export function arcPoint(arc: Arc, psi: number, target: Vector3) {
	const { e1, e2 } = arcFrame(arc);
	return target.copy(arc.centre).addScaledVector(e1, arc.radius * Math.cos(psi)).addScaledVector(e2, arc.radius * Math.sin(psi));
}

function onArc(arc: Arc, psi: number) {
	const { start, sweep, full } = arcFrame(arc);
	return full || mod(psi - start, TAU) <= sweep + 1e-12;
}

const split = { h: 0, rho: 0 };
const _rv = new Vector3();

/** Splits q − origin into h along the unit axis and rho across it; e gets the unit radial direction. */
function radial(q: Vector3, origin: Vector3, axis: Vector3, e: Vector3, hint?: Vector3) {
	_rv.subVectors(q, origin);
	split.h = _rv.dot(axis);
	e.copy(_rv).addScaledVector(axis, -split.h);
	split.rho = e.length();
	if (split.rho >= ZERO) {
		e.divideScalar(split.rho);
	} else {
		// On the axis every direction is equally near: follow the hint, else take any.
		if (hint) {
			e.subVectors(hint, origin);
			e.addScaledVector(axis, -e.dot(axis));
		}
		if (!hint || e.lengthSq() < ZERO * ZERO) perpendicular(axis, e);
		else e.normalize();
	}
	return split;
}

const _e = new Vector3();
const _m = new Vector3();
const _q = new Vector3();

/**
 * Foot of q on the unbounded surface, written to target; returns the signed distance, positive on the side the
 * normal points to (outside a cylinder, sphere, cone or torus). hint chooses the foot where every direction is
 * equally near: a point on an axis, at a sphere's centre, on a torus's spine.
 */
export function surfaceFoot(surface: Surface, q: Vector3, target: Vector3, hint?: Vector3): number {
	const s = unitSurface(surface);
	switch (s.kind) {
		case 'plane': {
			const d = _q.subVectors(q, s.origin).dot(s.normal);
			target.copy(q).addScaledVector(s.normal, -d);
			return d;
		}
		case 'cylinder': {
			const { h, rho } = radial(q, s.origin, s.axis, _e, hint);
			target.copy(s.origin).addScaledVector(s.axis, h).addScaledVector(_e, s.radius);
			return rho - s.radius;
		}
		case 'sphere': {
			const length = _q.subVectors(q, s.centre).length();
			if (length < ZERO) {
				if (hint) _q.subVectors(hint, s.centre);
				if (!hint || _q.lengthSq() < ZERO * ZERO) _q.set(0, 0, 1);
				target.copy(s.centre).addScaledVector(_q.normalize(), s.radius);
			} else {
				target.copy(s.centre).addScaledVector(_q, s.radius / length);
			}
			return length - s.radius;
		}
		case 'cone': {
			const { h, rho } = radial(q, s.apex, s.axis, _e, hint);
			const cos = Math.cos(s.halfAngle), sin = Math.sin(s.halfAngle);
			const along = h * cos + rho * sin;
			if (along <= 0) {
				// Behind the apex, where the apex itself is nearest.
				target.copy(s.apex);
				return Math.hypot(h, rho);
			}
			target.copy(s.apex).addScaledVector(s.axis, along * cos).addScaledVector(_e, along * sin);
			return rho * cos - h * sin;
		}
		case 'torus': {
			radial(q, s.centre, s.axis, _e, hint);
			_m.copy(s.centre).addScaledVector(_e, s.major);
			const length = _q.subVectors(q, _m).length();
			if (length < ZERO) {
				if (hint) _q.subVectors(hint, _m);
				if (!hint || _q.lengthSq() < ZERO * ZERO) _q.copy(s.axis);
				target.copy(_m).addScaledVector(_q.normalize(), s.minor);
			} else {
				target.copy(_m).addScaledVector(_q, s.minor / length);
			}
			return length - s.minor;
		}
		default:
			target.copy(q);
			return NaN;
	}
}

/** Unit normal at x, a point on the surface. Only the tangent plane is used, so the sign is free. */
export function surfaceNormal(surface: Surface, x: Vector3, target: Vector3): Vector3 {
	const s = unitSurface(surface);
	switch (s.kind) {
		case 'plane':
			return target.copy(s.normal);
		case 'cylinder':
			radial(x, s.origin, s.axis, target);
			return target;
		case 'sphere':
			target.subVectors(x, s.centre);
			return target.lengthSq() > ZERO * ZERO ? target.normalize() : target.set(0, 0, 1);
		case 'cone': {
			const { rho } = radial(x, s.apex, s.axis, target);
			if (rho < ZERO) return target.copy(s.axis);
			return target.multiplyScalar(Math.cos(s.halfAngle)).addScaledVector(s.axis, -Math.sin(s.halfAngle));
		}
		case 'torus':
			radial(x, s.centre, s.axis, _e);
			_m.copy(s.centre).addScaledVector(_e, s.major);
			target.subVectors(x, _m);
			return target.lengthSq() > ZERO * ZERO ? target.normalize() : target.copy(s.axis);
		default:
			return target.set(0, 0, 1);
	}
}

const _sd = new Vector3();
const _sq = new Vector3();

/** Nearest point of the segment ab to q, into target (which must not be q); returns the distance. */
export function segmentFoot(a: Vector3, b: Vector3, q: Vector3, target: Vector3) {
	_sd.subVectors(b, a);
	const length2 = _sd.lengthSq();
	const t = length2 < ZERO * ZERO ? 0 : Math.min(1, Math.max(0, _sq.subVectors(q, a).dot(_sd) / length2));
	target.copy(a).addScaledVector(_sd, t);
	return q.distanceTo(target);
}

const _av = new Vector3();

/** Nearest point of the bounded arc to q, into target; returns the distance. */
export function arcFoot(arc: Arc, q: Vector3, target: Vector3, hint?: Vector3) {
	const { e1, e2, start, sweep, full } = arcFrame(arc);
	_av.subVectors(q, arc.centre);
	let x = _av.dot(e1), y = _av.dot(e2);
	if (Math.hypot(x, y) < ZERO) {
		// On the axis every point of the circle is equally near: the hint's direction, else the arc's middle.
		if (hint) {
			_av.subVectors(hint, arc.centre);
			x = _av.dot(e1);
			y = _av.dot(e2);
		}
		if (!hint || Math.hypot(x, y) < ZERO) {
			x = Math.cos(start + sweep / 2);
			y = Math.sin(start + sweep / 2);
		}
	}
	let psi = Math.atan2(y, x);
	if (!full && mod(psi - start, TAU) > sweep) {
		// Beyond the ends: the end whose direction is nearer.
		const end = start + sweep;
		psi = Math.cos(psi - start) >= Math.cos(psi - end) ? start : end;
	}
	arcPoint(arc, psi, target);
	return q.distanceTo(target);
}

const _pf = new Vector3();

/** Nearest point of the bounded curve to q, into target (which must not be q); returns the distance. */
export function curveFoot(c: Curve, q: Vector3, target: Vector3, hint?: Vector3) {
	if (c.kind === 'line') return segmentFoot(c.start, c.end, q, target);
	if (c.kind === 'arc') return arcFoot(c, q, target, hint);
	const { points } = c;
	if (points.length === 1) return q.distanceTo(target.copy(points[0]));
	let best = Infinity;
	for (let i = 1; i < points.length; i++) {
		const d = segmentFoot(points[i - 1], points[i], q, _pf);
		if (d < best) {
			best = d;
			target.copy(_pf);
		}
	}
	return best;
}

/** Parameter range: [0, 1] along a line, the angle along an arc, [0, segments] along a polyline. */
export function curveDomain(c: Curve): [number, number] {
	if (c.kind === 'line') return [0, 1];
	if (c.kind === 'arc') {
		const { start, sweep } = arcFrame(c);
		return [start, start + sweep];
	}
	return [0, Math.max(0, c.points.length - 1)];
}

export function curveAt(c: Curve, t: number, target: Vector3) {
	if (c.kind === 'line') return target.lerpVectors(c.start, c.end, t);
	if (c.kind === 'arc') return arcPoint(c, t, target);
	const last = c.points.length - 1;
	if (last < 1) return last ? target : target.copy(c.points[0]);
	const i = Math.min(last - 1, Math.max(0, Math.floor(t)));
	return target.lerpVectors(c.points[i], c.points[i + 1], t - i);
}

export function curveLength(c: Curve) {
	if (c.kind === 'line') return c.start.distanceTo(c.end);
	if (c.kind === 'arc') return c.radius * arcFrame(c).sweep;
	let length = 0;
	for (let i = 1; i < c.points.length; i++) length += c.points[i - 1].distanceTo(c.points[i]);
	return length;
}

const _bx = new Vector3();

/** Axis-aligned box of the exact curve; a polyline's grows by its deflection. */
export function curveBox(c: Curve, target: Box3) {
	target.makeEmpty();
	if (c.kind === 'line') return target.expandByPoint(c.start).expandByPoint(c.end);
	if (c.kind === 'polyline') {
		for (const p of c.points) target.expandByPoint(p);
		return target.expandByScalar(c.deflection);
	}
	const { e1, e2, start, sweep } = arcFrame(c);
	target.expandByPoint(arcPoint(c, start, _bx)).expandByPoint(arcPoint(c, start + sweep, _bx));
	// Each coordinate peaks where its derivative, −sin ψ·e1 + cos ψ·e2, vanishes.
	for (const k of ['x', 'y', 'z'] as const) {
		const peak = Math.atan2(e2[k], e1[k]);
		for (const psi of [peak, peak + Math.PI]) if (onArc(c, psi)) target.expandByPoint(arcPoint(c, psi, _bx));
	}
	return target;
}

export type Minimum = { t: number; value: number };

const GOLDEN = (Math.sqrt(5) - 1) / 2;

function golden(f: (t: number) => number, a: number, b: number, tol: number, sampled: Minimum): Minimum {
	let c = b - GOLDEN * (b - a), d = a + GOLDEN * (b - a);
	let fc = f(c), fd = f(d);
	for (let i = 0; i < 80 && b - a > tol; i++) {
		if (fc <= fd) {
			b = d;
			d = c;
			fd = fc;
			c = b - GOLDEN * (b - a);
			fc = f(c);
		} else {
			a = c;
			c = d;
			fc = fd;
			d = a + GOLDEN * (b - a);
			fd = f(d);
		}
	}
	// A minimum at the end of the range is the sample itself; the bracket only closes in on it.
	if (sampled.value <= fc && sampled.value <= fd) return sampled;
	return fc <= fd ? { t: c, value: fc } : { t: d, value: fd };
}

/**
 * Local minima of f over [t0, t1]: n even samples, every sampled local minimum (the ends included) refined by
 * golden section over its two neighbouring intervals, the six lowest kept. When the samples spread less than
 * 1e-9 mm the curve runs along a family of equally near points: flat, no minima, and the samples to choose from.
 */
export function minimise(f: (t: number) => number, t0: number, t1: number, n: number) {
	const ts = new Float64Array(n);
	const fs = new Float64Array(n);
	let low = Infinity, high = -Infinity;
	for (let i = 0; i < n; i++) {
		ts[i] = i === n - 1 ? t1 : t0 + ((t1 - t0) * i) / (n - 1);
		fs[i] = f(ts[i]);
		low = Math.min(low, fs[i]);
		high = Math.max(high, fs[i]);
	}
	if (high - low < 1e-9) return { minima: [] as Minimum[], flat: true, samples: ts };
	const minima: Minimum[] = [];
	const tol = 1e-13 * (t1 - t0);
	for (let i = 0; i < n; i++) {
		// Strictly below the previous sample, so a plateau counts once, at its first sample.
		if (i > 0 && fs[i] >= fs[i - 1]) continue;
		if (i < n - 1 && fs[i] > fs[i + 1]) continue;
		minima.push(golden(f, ts[Math.max(0, i - 1)], ts[Math.min(n - 1, i + 1)], tol, { t: ts[i], value: fs[i] }));
	}
	minima.sort((a, b) => a.value - b.value);
	return { minima: minima.slice(0, 6), flat: false, samples: ts };
}

const _ll = new Vector3();

/** Parameters of the closest points of the infinite lines o1 + s·u1 and o2 + t·u2 (unit directions); null if parallel. */
export function lineLine(o1: Vector3, u1: Vector3, o2: Vector3, u2: Vector3) {
	const b = u1.dot(u2);
	_ll.subVectors(o1, o2);
	const d = u1.dot(_ll), e = u2.dot(_ll), den = 1 - b * b;
	if (den <= 1e-14) return null;
	return { s: (b * e - d) / den, t: (e - b * d) / den };
}

const _s1 = new Line3();
const _s2 = new Line3();
const _u = new Vector3();
const _v = new Vector3();
const _mid = new Vector3();
const _foot = new Vector3();

/** Closest points of the segments p0p1 and q0q1 into pa and pb; returns their distance. */
export function segmentSegment(p0: Vector3, p1: Vector3, q0: Vector3, q1: Vector3, pa: Vector3, pb: Vector3) {
	let d = Math.sqrt(_s1.set(p0, p1).distanceSqToLine3(_s2.set(q0, q1), pa, pb));
	// Parallel segments are equally near all along their overlap; meet in its middle rather than at an end.
	_u.subVectors(p1, p0);
	_v.subVectors(q1, q0);
	const uu = _u.lengthSq(), vv = _v.lengthSq();
	if (uu > ZERO * ZERO && vv > ZERO * ZERO && _cross.crossVectors(_u, _v).lengthSq() <= PARALLEL * PARALLEL * uu * vv) {
		const s0 = _mid.subVectors(q0, p0).dot(_u) / uu, s1 = _mid.subVectors(q1, p0).dot(_u) / uu;
		const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(1, Math.max(s0, s1));
		if (lo <= hi) {
			_mid.copy(p0).addScaledVector(_u, (lo + hi) / 2);
			const dm = segmentFoot(q0, q1, _mid, _foot);
			if (dm <= d + 1e-9) {
				pa.copy(_mid);
				pb.copy(_foot);
				d = dm;
			}
		}
	}
	return d;
}
