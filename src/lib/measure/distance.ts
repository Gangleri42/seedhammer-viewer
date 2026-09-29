import { Box3, Vector3 } from 'three';
import { boxGap, meshPair, meshPairIn, REACH, type CurveIndex, type FaceIndex, type Frame, type Pair } from './mesh';
import {
	TAU,
	arcFoot,
	arcFrame,
	curveAt,
	curveBox,
	curveDomain,
	curveFoot,
	curveLength,
	minimise,
	perpendicular,
	segmentSegment,
	surfaceFoot,
	surfaceNormal,
	unitSurface,
	type Arc
} from './primitives';
import type { Closest, Curve, EdgeEntity, Entity, FaceEntity, PointEntity, Surface } from './types';

/** What one measurement shares: the cached indexes, and every pair measured so far. */
export type Context = {
	face(e: FaceEntity): FaceIndex;
	curve(e: EdgeEntity): CurveIndex;
	memo: Map<string, Closest>;
};

const swap = (c: Closest): Closest => ({ distance: c.distance, a: c.b, b: c.a, exact: c.exact });

/**
 * Shortest distance between two bounded entities, with the point on each that realises it. Exact geometry decides
 * wherever it can; the meshes bound the answer and stand in for it (exact: false) when the exact search cannot be
 * trusted.
 */
export function closest(a: Entity, b: Entity, ctx: Context): Closest {
	if (a.id === b.id) {
		const p = pointOn(a, ctx);
		return { distance: 0, a: p, b: p.clone(), exact: true };
	}
	const flip = a.id > b.id;
	const key = flip ? `${b.id}\n${a.id}` : `${a.id}\n${b.id}`;
	let found = ctx.memo.get(key);
	if (!found) {
		found = flip ? dispatch(b, a, ctx) : dispatch(a, b, ctx);
		ctx.memo.set(key, found);
	}
	return flip ? swap(found) : found;
}

function dispatch(a: Entity, b: Entity, ctx: Context): Closest {
	if (b.type === 'face') return withFace(a, b, ctx);
	if (a.type === 'face') return swap(withFace(b, a, ctx));
	return curves(a, b, ctx);
}

function pointOn(e: Entity, ctx: Context) {
	if (e.type === 'point') return e.position.clone();
	if (e.type === 'edge') {
		const [t0, t1] = curveDomain(e.curve);
		return curveAt(e.curve, (t0 + t1) / 2, new Vector3());
	}
	const face = ctx.face(e);
	return face.nearest(face.centroid)?.point.clone() ?? face.centroid.clone();
}

function curves(a: PointEntity | EdgeEntity, b: PointEntity | EdgeEntity, ctx: Context): Closest {
	if (b.type === 'point') {
		if (a.type === 'point') return { distance: a.position.distanceTo(b.position), a: a.position.clone(), b: b.position.clone(), exact: true };
		return swap(pointCurve(b, a));
	}
	if (a.type === 'point') return pointCurve(a, b);
	return edgeEdge(a, b, ctx);
}

function pointCurve(p: PointEntity, e: EdgeEntity): Closest {
	const foot = new Vector3();
	const distance = curveFoot(e.curve, p.position, foot);
	return { distance, a: p.position.clone(), b: foot, exact: e.curve.kind !== 'polyline' };
}

function edgeEdge(a: EdgeEntity, b: EdgeEntity, ctx: Context): Closest {
	const ca = a.curve, cb = b.curve;
	const exact = ca.kind !== 'polyline' && cb.kind !== 'polyline';
	if (ca.kind === 'line' && cb.kind === 'line') {
		const pa = new Vector3(), pb = new Vector3();
		return { distance: segmentSegment(ca.start, ca.end, cb.start, cb.end, pa, pb), a: pa, b: pb, exact };
	}
	// Against an arc, walk the other curve (of two arcs, the one needing fewer samples, then the smaller) and
	// project each point exactly onto the arc.
	if (cb.kind === 'arc') {
		const walkA = sampleCount(ca, cb.radius), walkB = ca.kind === 'arc' ? sampleCount(cb, ca.radius) : Infinity;
		if (ca.kind !== 'arc' || walkA < walkB || (walkA === walkB && ca.radius <= cb.radius)) return { ...walk(ca, cb, walkA), exact };
	}
	if (ca.kind === 'arc') return swap({ ...walk(cb, ca, sampleCount(cb, ca.radius)), exact });
	// Polylines against lines and polylines: their segments meet exactly on the stand-in meshes.
	const found = meshPair(ctx.curve(a).bvh, ctx.curve(b).bvh);
	return found ? { ...found, exact } : { distance: NaN, a: new Vector3(), b: new Vector3(), exact: false };
}

/** Walks a curve, projecting each point exactly onto the arc; the least of those distances is the curves'. */
function walk(path: Curve, arc: Arc, count: number): Pair {
	const p = new Vector3(), q = new Vector3();
	const [t0, t1] = curveDomain(path);
	const { minima, flat, samples } = minimise((t) => arcFoot(arc, curveAt(path, t, p), q), t0, t1, count);
	curveAt(path, flat ? samples[0] : minima[0].t, p);
	return { distance: arcFoot(arc, p, q), a: p, b: q };
}

/**
 * Samples for walking a curve: 33 on a line, 128 a turn on an arc, every vertex and midpoint on a polyline; more
 * when the curve is long for the size of what it is measured against, so that a dip cannot hide between samples.
 */
function sampleCount(c: Curve, size: number) {
	const base =
		c.kind === 'line' ? 33 : c.kind === 'arc' ? Math.max(17, Math.ceil((128 * arcFrame(c).sweep) / TAU) + 1) : 2 * Math.max(1, c.points.length - 1) + 1;
	const need = Math.min(4097, Math.ceil((4 * curveLength(c)) / size) + 1);
	if (!(need > base)) return base;
	if (c.kind !== 'polyline') return need;
	// The same number between each pair of vertices, so the vertices stay sampled.
	const segments = c.points.length - 1;
	return segments * Math.ceil((need - 1) / segments) + 1;
}

/** The scale on which the distance to a surface bends: its radius, the tube's for a torus. */
function sizeOf(s: Surface) {
	if (s.kind === 'cylinder' || s.kind === 'sphere') return s.radius;
	if (s.kind === 'torus') return s.minor;
	return Infinity;
}

/** Surfaces with closed-form projections. A torus whose tube reaches its axis (a spindle) measures on the mesh. */
function projectable(s: Surface) {
	if (s.kind === 'torus') return s.major > s.minor;
	if (s.kind === 'cone') return s.halfAngle > 0 && s.halfAngle < Math.PI / 2;
	return s.kind !== 'other';
}

/** The direction an entity is laid out along: a plane's normal, a turned surface's axis, an arc's, a line's. */
function directionOf(e: EdgeEntity | FaceEntity) {
	if (e.type === 'edge') {
		const c = e.curve;
		if (c.kind === 'arc') return arcFrame(c).normal;
		return c.kind === 'line' && c.start.distanceToSquared(c.end) > 0 ? c.end.clone().sub(c.start).normalize() : null;
	}
	const s = unitSurface(e.surface);
	if (s.kind === 'plane') return s.normal;
	return s.kind === 'cylinder' || s.kind === 'cone' || s.kind === 'torus' ? s.axis : null;
}

/**
 * Directions that are parallel or square can hold a family of equally near points between them: parallel planes, a
 * shaft along a plane, coaxial cylinders, a torus resting on a plane, a circle over one. The mesh search then runs in
 * a frame along those directions.
 */
function familyFrame(da: Vector3 | null, db: Vector3 | null): Frame | null {
	if (!da || !db) return null;
	const cos = Math.abs(da.dot(db));
	let x: Vector3;
	if (1 - cos < 1e-12) x = perpendicular(da, new Vector3());
	else if (cos < 1e-6) x = db.clone().addScaledVector(da, -db.dot(da)).normalize();
	else return null;
	return { x, y: da.clone().cross(x), z: da };
}

/** How far an entity's stand-in mesh may stray from its exact geometry. */
function tolerance(e: Entity, ctx: Context) {
	if (e.type === 'point') return 0;
	return e.type === 'edge' ? ctx.curve(e).tol : e.tol;
}

function boxOf(e: Entity, ctx: Context) {
	if (e.type === 'point') return new Box3(e.position.clone(), e.position.clone());
	if (e.type === 'edge') return curveBox(e.curve, new Box3());
	return ctx.face(e).box.clone().expandByScalar(e.tol);
}

/**
 * Anything against a face. The meshes give the global minimum to within both tolerances; candidates on the exact
 * surfaces that pass the trim test come next, then the faces' boundary edges, nearest first while their boxes can
 * still beat the best. The exact answer stands if it agrees with the meshes.
 */
function withFace(a: Entity, b: FaceEntity, ctx: Context): Closest {
	const face = ctx.face(b);
	let proxy: Pair | null;
	if (a.type === 'point') {
		const hit = face.nearest(a.position);
		proxy = hit && { distance: hit.distance, a: a.position.clone(), b: hit.point };
	} else {
		const mesh = a.type === 'edge' ? ctx.curve(a) : { bvh: ctx.face(a).bvh, soup: a.soup };
		const frame = familyFrame(directionOf(a), directionOf(b));
		proxy = frame ? meshPairIn(frame, mesh.soup, b.soup) : meshPair(mesh.bvh, face.bvh);
	}
	if (!proxy) return { distance: NaN, a: new Vector3(), b: new Vector3(), exact: false };
	const approximate: Closest = { ...proxy, exact: false };
	if (!projectable(b.surface) || (a.type === 'face' && !projectable(a.surface))) return approximate;

	let best: Closest | undefined;
	for (const c of interior(a, b, proxy, ctx)) if (!best || c.distance < best.distance) best = c;

	const boxA = boxOf(a, ctx), boxB = boxOf(b, ctx);
	const edges: { gap: number; measure: () => Closest }[] = [];
	if (a.type === 'face') for (const e of a.edges) edges.push({ gap: boxGap(boxOf(e, ctx), boxB), measure: () => closest(e, b, ctx) });
	for (const e of b.edges) edges.push({ gap: boxGap(boxA, boxOf(e, ctx)), measure: () => closest(a, e, ctx) });
	edges.sort((x, y) => x.gap - y.gap);
	for (const edge of edges) {
		if (best && edge.gap >= best.distance) break;
		const c = edge.measure();
		if (Number.isFinite(c.distance) && (!best || c.distance < best.distance)) best = c;
	}

	const slack = tolerance(a, ctx) + b.tol + REACH;
	return best?.exact && best.distance <= proxy.distance + slack ? best : approximate;
}

/** Candidates inside the faces: nearest points on the exact surfaces, kept where the trim test puts them on the faces. */
function interior(a: Entity, b: FaceEntity, proxy: Pair, ctx: Context): Closest[] {
	const faceB = ctx.face(b);
	if (a.type === 'point') {
		const foot = new Vector3();
		surfaceFoot(b.surface, a.position, foot, proxy.b);
		return faceB.contains(foot) ? [{ distance: a.position.distanceTo(foot), a: a.position.clone(), b: foot, exact: true }] : [];
	}
	if (a.type === 'edge') return curveFace(a.curve, b.surface, faceB, proxy);
	const faceA = ctx.face(a);
	const { x, y, converged, directions } = newton(a.surface, b.surface, proxy.a, a.tol + b.tol);
	const pair = faceA.contains(x) && faceB.contains(y) ? { a: x, b: y } : slide(a.surface, b.surface, x, y, directions, faceA, faceB);
	return pair ? [{ distance: pair.a.distanceTo(pair.b), a: pair.a, b: pair.b, exact: converged }] : [];
}

/**
 * A family of equally near pairs (parallel planes, parallel cylinders) often reaches the faces' boundary where the
 * meshes happened to meet, and the trim test turns that pair away. Along the family's directions the middle of both
 * faces' extents usually lies on both faces: where the distance there is the same, that pair stands, mid-family.
 */
function slide(sa: Surface, sb: Surface, x: Vector3, y: Vector3, directions: Vector3[], faceA: FaceIndex, faceB: FaceIndex) {
	const d = x.distanceTo(y);
	const middle = directions.map((u) => {
		const [lowA, highA] = faceA.extent(x, u), [lowB, highB] = faceB.extent(x, u);
		const low = Math.max(lowA, lowB), high = Math.min(highA, highB);
		return low <= high ? (low + high) / 2 : NaN;
	});
	for (const along of [[0, 1], [0], [1]]) {
		const p = x.clone();
		for (const k of along) p.addScaledVector(directions[k], middle[k]);
		if (!Number.isFinite(p.x)) continue;
		const pa = new Vector3(), pb = new Vector3();
		surfaceFoot(sa, p, pa, x);
		surfaceFoot(sb, pa, pb, y);
		if (Math.abs(pa.distanceTo(pb) - d) <= 1e-9 * (1 + d) && faceA.contains(pa) && faceB.contains(pb)) return { a: pa, b: pb };
	}
	return null;
}

/** Local minima of the curve's distance to the unbounded surface, where the foot lands on the face. */
function curveFace(curve: Curve, surface: Surface, face: FaceIndex, proxy: Pair): Closest[] {
	const p = new Vector3(), q = new Vector3();
	const exact = curve.kind !== 'polyline';
	const at = (t: number): Closest => {
		curveAt(curve, t, p);
		surfaceFoot(surface, p, q, proxy.b);
		return { distance: p.distanceTo(q), a: p.clone(), b: q.clone(), exact };
	};
	const [t0, t1] = curveDomain(curve);
	const toSurface = (t: number) => Math.abs(surfaceFoot(surface, curveAt(curve, t, p), q, proxy.b));
	const { minima, flat, samples } = minimise(toSurface, t0, t1, sampleCount(curve, sizeOf(surface)));
	if (!flat) return minima.map((m) => at(m.t)).filter((c) => face.contains(c.b));
	// The whole curve is equally near: of the samples whose feet are on the face, the one nearest the meshes' pair.
	const byNearness = Array.from(samples, (t) => ({ t, d: curveAt(curve, t, p).distanceTo(proxy.a) })).sort((m, n) => m.d - n.d);
	for (const { t } of byNearness) {
		const c = at(t);
		if (face.contains(c.b)) return [c];
	}
	return [];
}

/**
 * Nearest points of two unbounded surfaces, from a seed on A: damped Newton on A's tangent chart, where
 * X(u, v) is the foot on A of x + u·e1 + v·e2 and F(u, v) = |X − foot on B of X|². The gradient is exact,
 * 2(r·e1, r·e2); the Hessian comes from nine samples of F. Along a flat direction (a family of equally near points)
 * no step is taken. Alternating projection is no substitute: parallel cylinders 0.001 mm apart take it ~20,000
 * iterations.
 */
function newton(sa: Surface, sb: Surface, seed: Vector3, tol: number) {
	const x = new Vector3(), y = seed.clone(), r = new Vector3();
	const n = new Vector3(), e1 = new Vector3(), e2 = new Vector3();
	const chart = new Vector3(), onA = new Vector3(), onB = new Vector3();
	const reach = Math.max(1, 10 * tol);
	const F = (u: number, v: number) => {
		chart.copy(x).addScaledVector(e1, u).addScaledVector(e2, v);
		surfaceFoot(sa, chart, onA, x);
		surfaceFoot(sb, onA, onB, y);
		return onA.distanceToSquared(onB);
	};
	// The Hessian's last eigenvectors, (c, s) and (−s, c) in the tangent frame e1, e2.
	let c = 1, s = 0, framed = false;
	surfaceFoot(sa, seed, x, seed);
	for (let i = 0; i < 60; i++) {
		surfaceFoot(sb, x, y, y);
		if (r.subVectors(x, y).lengthSq() < 1e-24) break;
		surfaceNormal(sa, x, n);
		perpendicular(n, e1);
		e2.crossVectors(n, e1);
		framed = true;
		const gu = 2 * r.dot(e1), gv = 2 * r.dot(e2);
		const f = F(0, 0);
		const h = Math.max(1e-6, 1e-4 * Math.sqrt(f));
		const huu = (F(h, 0) - 2 * f + F(-h, 0)) / (h * h);
		const hvv = (F(0, h) - 2 * f + F(0, -h)) / (h * h);
		const huv = (F(h, h) - F(h, -h) - F(-h, h) + F(-h, -h)) / (4 * h * h);
		// The eigenvectors are at the angle that clears the off-diagonal term.
		const theta = Math.atan2(2 * huv, huu - hvv) / 2;
		c = Math.cos(theta);
		s = Math.sin(theta);
		const l1 = huu * c * c + 2 * huv * s * c + hvv * s * s;
		const l2 = huu * s * s - 2 * huv * s * c + hvv * c * c;
		const floor = Math.max(1e-8 * Math.max(Math.abs(l1), Math.abs(l2)), 1e-12);
		// Newton where curved up, the full reach downhill where curved down, nothing where flat.
		const along = (g: number, l: number) => (l > floor ? -g / l : l < -floor ? -Math.sign(g) * reach : 0);
		const s1 = along(gu * c + gv * s, l1), s2 = along(gv * c - gu * s, l2);
		let su = s1 * c - s2 * s, sv = s1 * s + s2 * c;
		const length = Math.hypot(su, sv);
		if (length > reach) {
			su *= reach / length;
			sv *= reach / length;
		}
		let accepted = false;
		for (let k = 0; k < 40 && !accepted; k++) {
			accepted = F(su, sv) <= f - 1e-4 * Math.abs(gu * su + gv * sv);
			if (!accepted) {
				su /= 2;
				sv /= 2;
			}
		}
		if (!accepted) break;
		// F left X(su, sv) in onA.
		x.copy(onA);
		if (Math.hypot(su, sv) < 1e-10) break;
	}
	surfaceFoot(sb, x, y, y);
	// Wherever it stopped, the pair is exact only if it is stationary: x − y square to A there, as it is to B.
	surfaceNormal(sa, x, n);
	r.subVectors(x, y);
	const drift = r.clone().addScaledVector(n, -r.dot(n)).length();
	if (!framed) {
		perpendicular(n, e1);
		e2.crossVectors(n, e1);
	}
	const directions = [e1.clone().multiplyScalar(c).addScaledVector(e2, s), e1.clone().multiplyScalar(-s).addScaledVector(e2, c)];
	return { x, y, converged: drift <= 1e-6 * (1 + r.length()), directions };
}
