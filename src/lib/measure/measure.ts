import { Box3, Vector3 } from 'three';
import { closest, type Context } from './distance';
import { curveIndex, FaceIndex, type CurveIndex } from './mesh';
import { PARALLEL, ZERO, acute, angleBetween, arcFrame, curveBox, lineLine, perpendicular, unitSurface, type Arc } from './primitives';
import type { Anchor, Closest, Entity, FaceEntity, Measurement, Row, RowKey, Unit } from './types';

const LABELS: Record<RowKey, string> = {
	distance: 'Distance',
	angle: 'Angle',
	centre: 'Centre distance',
	axisDistance: 'Axis distance',
	min: 'Min',
	max: 'Max',
	dx: 'ΔX',
	dy: 'ΔY',
	dz: 'ΔZ',
	perpendicular: 'Perpendicular',
	axisToPlane: 'Axis to plane',
	axisAngle: 'Axis angle',
	x: 'X',
	y: 'Y',
	z: 'Z',
	length: 'Length',
	radius: 'Radius',
	diameter: 'Diameter',
	area: 'Area',
	loopLength: 'Loop length',
	centreX: 'Centre X',
	centreY: 'Centre Y',
	centreZ: 'Centre Z',
	coneAngle: 'Cone angle'
};

const DEGREES = 180 / Math.PI;

function row(key: RowKey, value: number, exact = true): Row {
	const unit: Unit = key === 'area' ? 'mm²' : key === 'angle' || key === 'axisAngle' || key === 'coneAngle' ? '°' : 'mm';
	return { key, label: LABELS[key], value, unit, exact };
}

/**
 * Fusion's Measure tool over exact geometry. Face and curve indexes are built on first use and kept by entity id;
 * pairs measured along the way are remembered for one measure() call.
 */
export class Measurer {
	#faces = new Map<string, FaceIndex>();
	#curves = new Map<string, CurveIndex>();

	/** Rows for one selection (Fusion's single-selection properties) plus point/centre anchors. */
	properties(e: Entity): Measurement {
		const out: Measurement = { rows: [], anchors: [] };
		if (e.type === 'point') {
			out.rows.push(row('x', e.position.x), row('y', e.position.y), row('z', e.position.z));
			out.anchors.push({ kind: 'point', role: 'position', at: e.position.clone() });
		} else if (e.type === 'edge') {
			out.rows.push(row('length', e.length));
			if (e.curve.kind === 'arc') {
				out.rows.push(row('radius', e.curve.radius), row('diameter', 2 * e.curve.radius));
				centre(e.curve.centre, out);
			}
		} else {
			const s = unitSurface(e.surface);
			if (s.kind === 'cylinder' || s.kind === 'sphere') out.rows.push(row('radius', s.radius), row('diameter', 2 * s.radius));
			if (s.kind === 'torus') out.rows.push(row('radius', s.minor), row('diameter', 2 * s.minor));
			out.rows.push(row('area', e.area), row('loopLength', e.loopLength));
			if (s.kind === 'cone') out.rows.push(row('coneAngle', 2 * s.halfAngle * DEGREES));
			const disc = s.kind === 'plane' ? discOf(e) : null;
			if (disc) centre(disc.centre, out);
			if (s.kind === 'sphere') out.anchors.push({ kind: 'point', role: 'centre', at: s.centre.clone() });
		}
		return out;
	}

	/** Rows for a pair: Distance, Angle, Centre distance/Axis distance, Min, Max, ΔX/ΔY/ΔZ, then extras; with anchors. */
	measure(a: Entity, b: Entity): Measurement {
		const ctx = this.#context();
		const out: Measurement = { rows: [], anchors: [] };
		const d = closest(a, b, ctx);
		if (Number.isFinite(d.distance)) {
			out.rows.push(row('distance', d.distance, d.exact));
			out.anchors.push({ kind: 'segment', role: 'distance', a: d.a.clone(), b: d.b.clone() });
		}
		const angled = angle(a, b, ctx, out);
		circular(a, b, d, ctx, out);
		if (a.type === 'point' && b.type === 'point') deltas(a.position, b.position, out);
		perpendicularRow(a, b, d, out);
		axisToPlane(a, b, d, ctx, out);
		if (!angled) axisAngle(a, b, ctx, out);
		return out;
	}

	/** Drops cached FaceIndexes (call when the model changes). */
	clear() {
		this.#faces.clear();
		this.#curves.clear();
	}

	#context(): Context {
		return {
			face: (e) => cached(this.#faces, e.id, () => new FaceIndex(e.soup, e.tol)),
			curve: (e) => cached(this.#curves, e.id, () => curveIndex(e.curve)),
			memo: new Map()
		};
	}
}

function cached<T>(map: Map<string, T>, key: string, make: () => T) {
	let value = map.get(key);
	if (value === undefined) map.set(key, (value = make()));
	return value;
}

/** "12.35 mm", "≈ 0.12 mm", "135.00°", "314.16 mm²". Under half a display unit shows as 0, never "-0.00". */
export function formatValue(value: number, unit: Unit, decimals: number, exact: boolean): string {
	const shown = Math.abs(value) < 0.5 * 10 ** -decimals ? 0 : value;
	return `${exact ? '' : '≈ '}${shown.toFixed(decimals)}${unit === '°' ? '°' : ` ${unit}`}`;
}

export function formatRow(row: Row, decimals: number): string {
	return formatValue(row.value, row.unit, decimals, row.exact);
}

function centre(at: Vector3, out: Measurement) {
	out.rows.push(row('centreX', at.x), row('centreY', at.y), row('centreZ', at.z));
	out.anchors.push({ kind: 'point', role: 'centre', at: at.clone() });
}

function deltas(from: Vector3, to: Vector3, out: Measurement) {
	out.rows.push(row('dx', to.x - from.x), row('dy', to.y - from.y), row('dz', to.z - from.z));
	// A staircase from A to B, one leg per axis.
	const x = new Vector3(to.x, from.y, from.z), y = new Vector3(to.x, to.y, from.z);
	out.anchors.push(
		{ kind: 'segment', role: 'dx', a: from.clone(), b: x },
		{ kind: 'segment', role: 'dy', a: x.clone(), b: y },
		{ kind: 'segment', role: 'dz', a: y.clone(), b: to.clone() }
	);
}

type Line = { start: Vector3; end: Vector3 };
type Plane = { origin: Vector3; normal: Vector3; face: FaceEntity };
/** A point-centred circle: an arc, a circular planar face, or a sphere (which has no normal). */
type Round = { centre: Vector3; normal: Vector3 | null; radius: number; ref: Vector3 | null };
/** An axis-centred circle: a cylinder face. */
type Shaft = { origin: Vector3; axis: Vector3; radius: number; face: FaceEntity };
type Axis = { origin: Vector3; direction: Vector3 };

const lineOf = (e: Entity): Line | null => (e.type === 'edge' && e.curve.kind === 'line' ? e.curve : null);

function direction(l: Line) {
	const u = l.end.clone().sub(l.start);
	return u.lengthSq() > ZERO * ZERO ? u.normalize() : null;
}

function planeOf(e: Entity): Plane | null {
	if (e.type !== 'face') return null;
	const s = unitSurface(e.surface);
	return s.kind === 'plane' ? { origin: s.origin, normal: s.normal, face: e } : null;
}

function shaftOf(e: Entity): Shaft | null {
	if (e.type !== 'face') return null;
	const s = unitSurface(e.surface);
	return s.kind === 'cylinder' ? { origin: s.origin, axis: s.axis, radius: s.radius, face: e } : null;
}

/** A planar face bounded only by arcs about one centre is circular; its circle is the outer one. */
function discOf(face: FaceEntity): Arc | null {
	const arcs = face.edges.map((e) => e.curve).filter((c): c is Arc => c.kind === 'arc');
	if (!arcs.length || arcs.length < face.edges.length) return null;
	if (arcs.some((c) => c.centre.distanceTo(arcs[0].centre) > 1e-6)) return null;
	return arcs.reduce((outer, c) => (c.radius > outer.radius ? c : outer));
}

function roundOf(e: Entity): Round | null {
	if (e.type === 'edge' && e.curve.kind === 'arc') {
		const { normal, e1 } = arcFrame(e.curve);
		return { centre: e.curve.centre, normal, radius: e.curve.radius, ref: e1 };
	}
	if (e.type !== 'face') return null;
	const s = unitSurface(e.surface);
	if (s.kind === 'sphere') return { centre: s.centre, normal: null, radius: s.radius, ref: null };
	if (s.kind !== 'plane') return null;
	const disc = discOf(e);
	return disc && { centre: disc.centre, normal: s.normal, radius: disc.radius, ref: arcFrame(disc).e1 };
}

/** The axis an entity turns about or runs along, for the Axis angle. */
function axisOf(e: Entity): Axis | null {
	if (e.type === 'edge') {
		const c = e.curve;
		if (c.kind === 'arc') return { origin: c.centre, direction: arcFrame(c).normal };
		if (c.kind !== 'line') return null;
		const u = direction(c);
		return u && { origin: c.start, direction: u };
	}
	if (e.type !== 'face') return null;
	const s = unitSurface(e.surface);
	if (s.kind === 'cylinder') return { origin: s.origin, direction: s.axis };
	if (s.kind === 'cone') return { origin: s.apex, direction: s.axis };
	if (s.kind === 'torus') return { origin: s.centre, direction: s.axis };
	if (s.kind !== 'plane') return null;
	const disc = discOf(e);
	return disc && { origin: disc.centre, direction: s.normal };
}

const onLine = (origin: Vector3, u: Vector3, p: Vector3) => origin.clone().addScaledVector(u, p.clone().sub(origin).dot(u));
const onPlane = (plane: Plane, p: Vector3) => p.clone().addScaledVector(plane.normal, -p.clone().sub(plane.origin).dot(plane.normal));
const alongPlane = (u: Vector3, plane: Plane) => Math.abs(u.dot(plane.normal)) < Math.sin(PARALLEL);

type Opening = { radians: number; apex: Vector3; a: Vector3; b: Vector3 };

/**
 * Fusion's Angle: only between lines and planar faces, 0–180° opening toward the geometry, hidden when parallel.
 * Returns whether the pair is one the Angle covers, parallel or not.
 */
function angle(a: Entity, b: Entity, ctx: Context, out: Measurement) {
	const la = lineOf(a), lb = lineOf(b), pa = planeOf(a), pb = planeOf(b);
	let opening: Opening | null;
	if (la && lb) opening = lineLineAngle(la, lb);
	else if (la && pb) opening = linePlaneAngle(la, pb, ctx);
	else if (pa && lb) opening = flip(linePlaneAngle(lb, pa, ctx));
	else if (pa && pb) opening = planePlaneAngle(pa, pb, ctx);
	else return false;
	if (opening) {
		out.rows.push(row('angle', opening.radians * DEGREES));
		out.anchors.push({ kind: 'angle', apex: opening.apex, a: opening.a, b: opening.b });
	}
	return true;
}

const flip = (o: Opening | null) => o && { ...o, a: o.b, b: o.a };

/** From p toward the edge's middle, or toward its farther end when p is the middle. */
function ray(l: Line, p: Vector3) {
	const r = l.start.clone().add(l.end).multiplyScalar(0.5).sub(p);
	if (r.length() >= 1e-9 * l.start.distanceTo(l.end)) return r;
	return (p.distanceTo(l.start) > p.distanceTo(l.end) ? l.start : l.end).clone().sub(p);
}

/** Between the rays from the lines' closest points toward each edge. */
function lineLineAngle(l1: Line, l2: Line): Opening | null {
	const u1 = direction(l1), u2 = direction(l2);
	if (!u1 || !u2 || acute(u1, u2) < PARALLEL) return null;
	const at = lineLine(l1.start, u1, l2.start, u2);
	if (!at) return null;
	const p1 = l1.start.clone().addScaledVector(u1, at.s), p2 = l2.start.clone().addScaledVector(u2, at.t);
	const r1 = ray(l1, p1), r2 = ray(l2, p2);
	const apex = p1.add(p2).multiplyScalar(0.5);
	return { radians: angleBetween(r1, r2), apex, a: apex.clone().add(r1), b: apex.clone().add(r2) };
}

/** From where the line meets the plane: toward the edge, and along the plane toward the face. */
function linePlaneAngle(l: Line, plane: Plane, ctx: Context): Opening | null {
	const u = direction(l);
	if (!u || alongPlane(u, plane)) return null;
	const apex = l.start.clone().addScaledVector(u, plane.origin.clone().sub(l.start).dot(plane.normal) / u.dot(plane.normal));
	const r = ray(l, apex);
	const length = r.length();
	r.divideScalar(length);
	const toFace = ctx.face(plane.face).centroid.clone().sub(apex);
	const p = r.clone().addScaledVector(plane.normal, -r.dot(plane.normal));
	let radians = Math.PI / 2;
	if (p.length() >= 1e-9) {
		p.normalize();
		if (toFace.dot(p) < 0) p.negate();
		radians = angleBetween(r, p);
	} else {
		// Square to the plane: 90°, drawn toward the face.
		p.copy(toFace).addScaledVector(plane.normal, -toFace.dot(plane.normal));
		if (p.length() < 1e-9) perpendicular(plane.normal, p);
		p.normalize();
	}
	return { radians, apex, a: apex.clone().addScaledVector(r, length), b: apex.clone().addScaledVector(p, length) };
}

/** From the planes' line of intersection, square to it, toward each face's centroid. */
function planePlaneAngle(p1: Plane, p2: Plane, ctx: Context): Opening | null {
	if (acute(p1.normal, p2.normal) < PARALLEL) return null;
	const u = p1.normal.clone().cross(p2.normal);
	const d1 = p1.normal.dot(p1.origin), d2 = p2.normal.dot(p2.origin);
	const o = p2.normal.clone().cross(u).multiplyScalar(d1).add(u.clone().cross(p1.normal).multiplyScalar(d2)).divideScalar(u.lengthSq());
	u.normalize();
	const f1 = ctx.face(p1.face), f2 = ctx.face(p2.face);
	const w1 = across(f1, o, u), w2 = across(f2, o, u);
	const apex = onLine(o, u, f1.centroid.clone().add(f2.centroid).multiplyScalar(0.5));
	return { radians: angleBetween(w1, w2), apex, a: apex.clone().add(w1), b: apex.clone().add(w2) };
}

/** From the line toward the face's centroid, square to the line; toward its farthest vertex when the centroid is on it. */
function across(face: FaceIndex, o: Vector3, u: Vector3) {
	const w = face.centroid.clone().sub(o);
	w.addScaledVector(u, -w.dot(u));
	if (w.length() >= 1e-9) return w;
	w.subVectors(face.farthestFrom(o, u, new Vector3()), o);
	return w.addScaledVector(u, -w.dot(u));
}

/** Centre distance (or Axis distance), then Min and Max, then the centres' ΔX ΔY ΔZ, when both are circular. */
function circular(a: Entity, b: Entity, d: Closest, ctx: Context, out: Measurement) {
	const ra = roundOf(a), rb = roundOf(b), sa = shaftOf(a), sb = shaftOf(b);
	if (ra && rb) rounds(ra, rb, out);
	else if (ra && sb) roundShaft(ra, sb, false, ctx, out);
	else if (sa && rb) roundShaft(rb, sa, true, ctx, out);
	else if (sa && sb) shafts(sa, sb, d, ctx, out);
}

function rounds(ra: Round, rb: Round, out: Measurement) {
	out.rows.push(row('centre', ra.centre.distanceTo(rb.centre)));
	out.anchors.push({ kind: 'segment', role: 'centre', a: ra.centre.clone(), b: rb.centre.clone() });
	// Min and Max need parallel circles; a sphere is parallel to anything, and its offset along the normal is free.
	if (!ra.normal || !rb.normal || acute(ra.normal, rb.normal) < PARALLEL) {
		extremes(ra.centre, ra.radius, rb.centre, rb.radius, ra.normal ?? rb.normal, !ra.normal || !rb.normal, ra.ref ?? rb.ref, out);
	}
	deltas(ra.centre, rb.centre, out);
}

/** A circle or sphere against a cylinder: its centre to the axis, and Min and Max in the circle's cross-section. */
function roundShaft(round: Round, shaft: Shaft, flipped: boolean, ctx: Context, out: Measurement) {
	const foot = onLine(shaft.origin, shaft.axis, round.centre);
	out.rows.push(row('centre', round.centre.distanceTo(foot)));
	const [a, b] = flipped ? [foot, round.centre] : [round.centre, foot];
	out.anchors.push({ kind: 'segment', role: 'centre', a: a.clone(), b: b.clone() }, axisAnchor(shaft, ctx));
	if (round.normal && acute(round.normal, shaft.axis) >= PARALLEL) return;
	if (flipped) extremes(foot, shaft.radius, round.centre, round.radius, shaft.axis, true, round.ref, out);
	else extremes(round.centre, round.radius, foot, shaft.radius, shaft.axis, true, round.ref, out);
}

/** Two cylinders: parallel axes give Centre distance, Min and Max in a cross-section; skew ones the Axis distance. */
function shafts(sa: Shaft, sb: Shaft, d: Closest, ctx: Context, out: Measurement) {
	const axes = [axisAnchor(sa, ctx), axisAnchor(sb, ctx)];
	if (acute(sa.axis, sb.axis) < PARALLEL) {
		// The cross-section through the middle of the Distance.
		const middle = Number.isFinite(d.distance) ? d.a.clone().add(d.b).multiplyScalar(0.5) : sa.origin;
		const c1 = onLine(sa.origin, sa.axis, middle), c2 = onLine(sb.origin, sb.axis, c1);
		out.rows.push(row('centre', c1.distanceTo(c2)));
		out.anchors.push({ kind: 'segment', role: 'centre', a: c1.clone(), b: c2.clone() }, ...axes);
		extremes(c1, sa.radius, c2, sb.radius, sa.axis, true, null, out);
		return;
	}
	const at = lineLine(sa.origin, sa.axis, sb.origin, sb.axis);
	if (!at) return;
	const p1 = sa.origin.clone().addScaledVector(sa.axis, at.s), p2 = sb.origin.clone().addScaledVector(sb.axis, at.t);
	out.rows.push(row('axisDistance', p1.distanceTo(p2)));
	out.anchors.push({ kind: 'segment', role: 'centre', a: p1, b: p2 }, ...axes);
}

function axisAnchor(shaft: Shaft, ctx: Context): Anchor {
	const [from, to] = ctx.face(shaft.face).extent(shaft.origin, shaft.axis);
	return { kind: 'axis', from: shaft.origin.clone().addScaledVector(shaft.axis, from), to: shaft.origin.clone().addScaledVector(shaft.axis, to) };
}

/**
 * Min and Max between two parallel circles with centres c1, c2 and common normal n (null for two spheres). In a
 * cross-section (flat: a cylinder or a sphere) the offset along n does not count.
 */
function extremes(c1: Vector3, r1: number, c2: Vector3, r2: number, n: Vector3 | null, flat: boolean, ref: Vector3 | null, out: Measurement) {
	const delta = c2.clone().sub(c1);
	const offset = n ? n.clone().multiplyScalar(delta.dot(n)) : new Vector3();
	const inPlane = delta.clone().sub(offset);
	const h = flat ? 0 : offset.length();
	const L = inPlane.length();
	const m = L >= r1 + r2 ? L - r1 - r2 : L <= Math.abs(r1 - r2) ? Math.abs(r1 - r2) - L : 0;
	out.rows.push(row('min', Math.hypot(h, m)), row('max', Math.hypot(h, L + r1 + r2)));

	// Anchors lie along û, the in-plane direction between the centres, or the reference direction when they line up.
	const u = L > ZERO ? inPlane.divideScalar(L) : inPlaneDirection(ref, n);
	const at = (c: Vector3, r: number) => c.clone().addScaledVector(u, r);
	let minA = at(c1, r1), minB = at(c2, -r2);
	if (L >= r1 + r2 || L <= Math.abs(r1 - r2)) {
		// Of the four pairs of points on that line, the one realising Min.
		let miss = Infinity;
		for (const s1 of [1, -1]) {
			for (const s2 of [1, -1]) {
				const pa = at(c1, s1 * r1), pb = at(c2, s2 * r2);
				const gap = Math.abs(pb.clone().sub(pa).sub(offset).length() - m);
				if (gap < miss) {
					miss = gap;
					minA = pa;
					minB = pb;
				}
			}
		}
	} else {
		// The circles cross: Min runs from where they cross, each end in its own circle's plane.
		const along = (L * L + r1 * r1 - r2 * r2) / (2 * L);
		const w = n ? n.clone().cross(u).normalize() : perpendicular(u, new Vector3());
		minA = c1.clone().addScaledVector(u, along).addScaledVector(w, Math.sqrt(Math.max(0, r1 * r1 - along * along)));
		minB = minA.clone().add(offset);
	}
	out.anchors.push({ kind: 'segment', role: 'min', a: minA, b: minB }, { kind: 'segment', role: 'max', a: at(c1, -r1), b: at(c2, r2) });
}

function inPlaneDirection(ref: Vector3 | null, n: Vector3 | null) {
	const u = ref ? ref.clone() : new Vector3(1, 0, 0);
	if (n) u.addScaledVector(n, -u.dot(n));
	if (u.lengthSq() > 1e-12) return u.normalize();
	return n ? perpendicular(n, u) : u.set(1, 0, 0);
}

/** Perpendicular: parallel planes, parallel lines, a line along a plane, a point to a plane; when it is not the Distance. */
function perpendicularRow(a: Entity, b: Entity, d: Closest, out: Measurement) {
	const foot = perpendicularFrom(a, b, d.a) ?? flipFoot(perpendicularFrom(b, a, d.b));
	if (!foot || !(Math.abs(foot.value - d.distance) > 1e-6)) return;
	out.rows.push(row('perpendicular', foot.value));
	out.anchors.push({ kind: 'segment', role: 'perpendicular', a: foot.from, b: foot.to });
}

type Foot = { value: number; from: Vector3; to: Vector3 };

const flipFoot = (f: Foot | null) => f && { value: f.value, from: f.to, to: f.from };

/** The perpendicular from a to b, when they are parallel; drawn from near, a's end of the Distance. */
function perpendicularFrom(a: Entity, b: Entity, near: Vector3): Foot | null {
	const la = lineOf(a), ua = la && direction(la);
	const pb = planeOf(b);
	if (pb) {
		const pa = planeOf(a);
		let on: Vector3 | null = null;
		if (pa && acute(pa.normal, pb.normal) < PARALLEL) on = pa.origin;
		else if (la && ua && alongPlane(ua, pb)) on = la.start;
		else if (a.type === 'point') on = a.position;
		if (!on) return null;
		const from = a.type === 'point' ? a.position.clone() : near.clone();
		return { value: Math.abs(on.clone().sub(pb.origin).dot(pb.normal)), from, to: onPlane(pb, from) };
	}
	const lb = lineOf(b), ub = lb && direction(lb);
	if (!la || !ua || !lb || !ub || acute(ua, ub) >= PARALLEL) return null;
	return { value: la.start.distanceTo(onLine(lb.start, ub, la.start)), from: near.clone(), to: onLine(lb.start, ub, near) };
}

/** Axis to plane: a cylinder's axis parallel to a plane, the axis's distance from it. */
function axisToPlane(a: Entity, b: Entity, d: Closest, ctx: Context, out: Measurement) {
	for (const [shaftSide, planeSide, near, flipped] of [[a, b, d.a, false], [b, a, d.b, true]] as const) {
		const shaft = shaftOf(shaftSide), plane = planeOf(planeSide);
		if (!shaft || !plane || !alongPlane(shaft.axis, plane)) continue;
		out.rows.push(row('axisToPlane', Math.abs(shaft.origin.clone().sub(plane.origin).dot(plane.normal))));
		const onAxis = onLine(shaft.origin, shaft.axis, near), below = onPlane(plane, onAxis);
		out.anchors.push(axisAnchor(shaft, ctx), { kind: 'segment', role: 'perpendicular', a: flipped ? below : onAxis, b: flipped ? onAxis : below });
		return;
	}
}

/** Axis angle: 0–90° between the axes of turned or straight geometry, where the Angle does not already cover it. */
function axisAngle(a: Entity, b: Entity, ctx: Context, out: Measurement) {
	const xa = axisOf(a), xb = axisOf(b);
	if (!xa || !xb) return;
	const radians = acute(xa.direction, xb.direction);
	if (radians < PARALLEL) return;
	out.rows.push(row('axisAngle', radians * DEGREES));
	// Drawn where the axes pass nearest each other, both rays on the acute side.
	const at = lineLine(xa.origin, xa.direction, xb.origin, xb.direction);
	if (!at) return;
	const apex = xa.origin.clone().addScaledVector(xa.direction, at.s).add(xb.origin.clone().addScaledVector(xb.direction, at.t)).multiplyScalar(0.5);
	const toward = xb.direction.clone().multiplyScalar(Math.sign(xa.direction.dot(xb.direction)) || 1);
	const size = Math.max(halfSize(a, ctx), halfSize(b, ctx), 1);
	out.anchors.push({ kind: 'angle', apex, a: apex.clone().addScaledVector(xa.direction, size), b: apex.clone().addScaledVector(toward, size) });
}

/** Half the diagonal of an entity's box: a length to draw its axis with. */
function halfSize(e: Entity, ctx: Context) {
	if (e.type === 'point') return 0;
	const box = e.type === 'edge' ? curveBox(e.curve, new Box3()) : ctx.face(e).box;
	return box.isEmpty() ? 0 : box.min.distanceTo(box.max) / 2;
}
