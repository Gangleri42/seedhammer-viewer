import { Box3, BufferAttribute, BufferGeometry, Line3, Triangle, Vector3 } from 'three';
import { ExtendedTriangle, MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import { arcFrame, arcPoint, segmentFoot } from './primitives';
import type { Curve } from './types';

declare module 'three-mesh-bvh' {
	interface ExtendedTriangle {
		// The implementation writes the closest points into the targets; the published typings leave them out.
		distanceToTriangle(other: Triangle, target1?: Vector3, target2?: Vector3): number;
	}
}

/** Two points, one on each mesh, and their distance. */
export type Pair = { distance: number; a: Vector3; b: Vector3 };

/** Chordal deflection of the stand-in mesh for an arc, mm. */
export const ARC_PROXY = 1e-3;
/** How much further than its tolerance a point may lie from the soup and still be on the face. */
export const REACH = 1e-4;
/** A trim-test hit this close to the soup's border is on the face's boundary, mm. */
const BORDER = 1e-5;
/** Soup vertices that round to the same multiple of this are one vertex, mm. */
const WELD = 1e-5;

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();

/** A face's soup ready for queries: its BVH, the triangles on its border, its box and area-weighted centroid. */
export class FaceIndex {
	readonly bvh: MeshBVH;
	readonly box = new Box3();
	readonly centroid = new Vector3();
	readonly #tol: number;
	readonly #positions: Float32Array;
	readonly #index: ArrayLike<number>;
	/** Per BVH triangle: bits 0–2 mark border edges (vertex k to k + 1), bits 3–5 vertices on the border. */
	readonly #border: Uint8Array;

	constructor(soup: Float32Array, tol: number) {
		const geometry = new BufferGeometry();
		geometry.setAttribute('position', new BufferAttribute(soup, 3));
		// Building adds an index and reorders it; triangle numbers from here on are the BVH's.
		this.bvh = new MeshBVH(geometry);
		this.bvh.getBoundingBox(this.box);
		this.#tol = tol;
		this.#positions = soup;
		this.#index = geometry.index?.array ?? new Uint32Array(0);
		this.#border = borders(soup, this.#index);
		centroidOf(soup, this.centroid);
	}

	/** Nearest soup point to p, if one lies within max. The BVH's own threshold only prunes boxes, not triangles. */
	nearest(p: Vector3, max = Infinity): HitPointInfo | null {
		const hit = this.bvh.closestPointToPoint(p, { point: new Vector3(), distance: 0, faceIndex: 0 }, 0, max);
		return hit && hit.distance <= max ? hit : null;
	}

	/**
	 * Trim test: p is on the face when it lies within the soup's tolerance of it and away from its border. Within
	 * 1e-5 mm of the border the point is on the face's boundary, which the exact edges measure instead.
	 */
	contains(p: Vector3) {
		const hit = this.nearest(p, this.#tol + REACH);
		if (!hit) return false;
		const bits = this.#border[hit.faceIndex];
		if (!bits) return true;
		for (let k = 0; k < 3; k++) {
			this.#vertex(hit.faceIndex, k, _a);
			if ((bits & (8 << k)) !== 0 && hit.point.distanceTo(_a) < BORDER) return false;
			if ((bits & (1 << k)) === 0) continue;
			if (segmentFoot(_a, this.#vertex(hit.faceIndex, (k + 1) % 3, _b), hit.point, _c) < BORDER) return false;
		}
		return true;
	}

	/** The soup's range along a line: the least and greatest (v − origin)·direction over its vertices. */
	extent(origin: Vector3, direction: Vector3): [number, number] {
		let low = Infinity, high = -Infinity;
		for (let i = 0; i < this.#positions.length; i += 3) {
			const t = _a.fromArray(this.#positions, i).sub(origin).dot(direction);
			low = Math.min(low, t);
			high = Math.max(high, t);
		}
		return [low, high];
	}

	/** The soup vertex farthest from a line (unit direction). */
	farthestFrom(origin: Vector3, direction: Vector3, target: Vector3) {
		let far = -1;
		for (let i = 0; i < this.#positions.length; i += 3) {
			_a.fromArray(this.#positions, i).sub(origin);
			const d = _a.addScaledVector(direction, -_a.dot(direction)).lengthSq();
			if (d > far) {
				far = d;
				target.fromArray(this.#positions, i);
			}
		}
		return target;
	}

	#vertex(triangle: number, k: number, target: Vector3) {
		return target.fromArray(this.#positions, this.#index[3 * triangle + k] * 3);
	}
}

/**
 * Border flags per BVH triangle. The soup is welded by quantised position; an edge only one triangle uses lies on
 * the face's border, and so do its ends.
 */
function borders(positions: Float32Array, index: ArrayLike<number>) {
	const { ids, welded } = weld(positions);
	const count = index.length / 3;
	const end = (t: number, k: number) => ids[index[3 * t + (k % 3)]];
	// Each triangle edge as one number, the smaller welded end first; −1 where the edge has collapsed.
	const edges = new Float64Array(3 * count);
	for (let t = 0; t < count; t++) {
		for (let k = 0; k < 3; k++) {
			const i = end(t, k), j = end(t, k + 1);
			edges[3 * t + k] = i === j ? -1 : i < j ? i * welded + j : j * welded + i;
		}
	}
	// Sorted, an edge used once stands alone.
	const sorted = edges.slice().sort();
	const once = new Set<number>();
	for (let s = 0, e = 1; s < sorted.length; s = e, e = s + 1) {
		while (e < sorted.length && sorted[e] === sorted[s]) e++;
		if (e - s === 1 && sorted[s] >= 0) once.add(sorted[s]);
	}
	const flags = new Uint8Array(count);
	const onBorder = new Uint8Array(welded);
	for (let t = 0; t < count; t++) {
		for (let k = 0; k < 3; k++) {
			if (!once.has(edges[3 * t + k])) continue;
			flags[t] |= 1 << k;
			onBorder[end(t, k)] = onBorder[end(t, k + 1)] = 1;
		}
	}
	for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) if (onBorder[end(t, k)]) flags[t] |= 8 << k;
	return flags;
}

/** One id per quantised position: an open-addressed hash table over the rounded coordinates. */
function weld(positions: Float32Array) {
	const vertices = positions.length / 3;
	const ids = new Int32Array(vertices);
	const size = 2 ** Math.ceil(Math.log2(2 * vertices + 2));
	const slots = new Int32Array(size).fill(-1);
	const rounded = new Float64Array(positions.length);
	let welded = 0;
	for (let v = 0; v < vertices; v++) {
		const x = Math.round(positions[3 * v] / WELD), y = Math.round(positions[3 * v + 1] / WELD), z = Math.round(positions[3 * v + 2] / WELD);
		let slot = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & (size - 1);
		for (;;) {
			const id = slots[slot];
			if (id < 0) {
				slots[slot] = ids[v] = welded;
				rounded[3 * welded] = x;
				rounded[3 * welded + 1] = y;
				rounded[3 * welded++ + 2] = z;
				break;
			}
			if (rounded[3 * id] === x && rounded[3 * id + 1] === y && rounded[3 * id + 2] === z) {
				ids[v] = id;
				break;
			}
			slot = (slot + 1) & (size - 1);
		}
	}
	return { ids, welded };
}

function centroidOf(soup: Float32Array, target: Vector3) {
	let total = 0;
	target.set(0, 0, 0);
	for (let i = 0; i + 9 <= soup.length; i += 9) {
		_a.fromArray(soup, i);
		_b.fromArray(soup, i + 3);
		_c.fromArray(soup, i + 6);
		const area = _d.subVectors(_b, _a).cross(_e.subVectors(_c, _a)).length() / 2;
		target.addScaledVector(_a.add(_b).add(_c), area / 3);
		total += area;
	}
	if (total > 0) return target.divideScalar(total);
	// No area at all: the plain vertex average.
	for (let i = 0; i + 3 <= soup.length; i += 3) target.add(_a.fromArray(soup, i));
	return soup.length ? target.divideScalar(soup.length / 3) : target;
}

/** A curve's stand-in mesh (its segments as degenerate triangles a, b, b) and how far it may stray from the curve. */
export type CurveIndex = { bvh: MeshBVH; soup: Float32Array; tol: number };

export function curveIndex(curve: Curve): CurveIndex {
	const { points, tol } = tessellate(curve);
	// A lone point is one degenerate triangle.
	const segments = Math.max(Math.min(1, points.length), points.length - 1);
	const soup = new Float32Array(segments * 9);
	for (let i = 0; i < segments; i++) {
		const b = points[Math.min(i + 1, points.length - 1)];
		points[i].toArray(soup, 9 * i);
		b.toArray(soup, 9 * i + 3);
		b.toArray(soup, 9 * i + 6);
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(soup, 3));
	return { bvh: new MeshBVH(geometry), soup, tol };
}

function tessellate(curve: Curve): { points: Vector3[]; tol: number } {
	if (curve.kind === 'line') return { points: [curve.start, curve.end], tol: 0 };
	if (curve.kind === 'polyline') return { points: curve.points, tol: curve.deflection };
	const { start, sweep } = arcFrame(curve);
	// A chord spanning θ strays r(1 − cos θ/2) from its arc.
	const step = curve.radius > ARC_PROXY / 2 ? 2 * Math.acos(1 - ARC_PROXY / curve.radius) : Math.PI / 4;
	const n = Math.max(1, Math.ceil(sweep / step));
	const points: Vector3[] = [];
	for (let i = 0; i <= n; i++) points.push(arcPoint(curve, start + (sweep * i) / n, new Vector3()));
	return { points, tol: ARC_PROXY };
}

/** Distance between two boxes, 0 where they touch or overlap. */
export function boxGap(a: Box3, b: Box3) {
	const x = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
	const y = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
	const z = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
	return Math.sqrt(x * x + y * y + z * z);
}

/**
 * A BVH flattened for pair traversal: each node's box, children and triangle range, and each triangle's bounds, in
 * the order the build left the index in.
 */
type Tree = {
	boxes: Float32Array; // per node: min x, y, z, max x, y, z
	children: Int32Array; // per node: left, right; −1 for a leaf
	ranges: Int32Array; // per node: first triangle, count
	triangles: Float64Array; // per triangle (STRIDE): box (6), unit normal (3), normal·corner (1), centroid (3), reach (1)
	positions: ArrayLike<number>;
	index: ArrayLike<number>;
};

const STRIDE = 14;

const trees = new WeakMap<MeshBVH, Tree>();

function treeOf(bvh: MeshBVH) {
	let tree = trees.get(bvh);
	if (!tree) trees.set(bvh, (tree = flatten(bvh)));
	return tree;
}

function flatten(bvh: MeshBVH): Tree {
	const { index, attributes } = bvh.geometry;
	const positions = attributes.position.array, indices = index?.array ?? new Uint32Array(0);
	const count = indices.length / 3;
	const boxes: number[] = [], children: number[] = [], ranges: number[] = [], path: number[] = [];
	// An empty BVH has no root to walk.
	if (count) {
		bvh.traverse((depth, isLeaf, box, offset, size) => {
			const node = ranges.length / 2;
			for (let k = 0; k < 6; k++) boxes.push(box[k]);
			children.push(-1, -1);
			ranges.push(isLeaf ? offset : 0, isLeaf ? size : 0);
			if (depth > 0) {
				const parent = path[depth - 1];
				children[2 * parent + (children[2 * parent] < 0 ? 0 : 1)] = node;
			}
			path[depth] = node;
		});
	}
	const triangles = new Float64Array(count * STRIDE);
	for (let t = 0; t < count; t++) {
		_a.fromArray(positions, indices[3 * t] * 3);
		_b.fromArray(positions, indices[3 * t + 1] * 3);
		_c.fromArray(positions, indices[3 * t + 2] * 3);
		const p = STRIDE * t;
		triangles[p] = Math.min(_a.x, _b.x, _c.x);
		triangles[p + 1] = Math.min(_a.y, _b.y, _c.y);
		triangles[p + 2] = Math.min(_a.z, _b.z, _c.z);
		triangles[p + 3] = Math.max(_a.x, _b.x, _c.x);
		triangles[p + 4] = Math.max(_a.y, _b.y, _c.y);
		triangles[p + 5] = Math.max(_a.z, _b.z, _c.z);
		// A degenerate triangle (a curve's segment) keeps a zero normal, which bounds nothing.
		const n = _d.subVectors(_b, _a).cross(_e.subVectors(_c, _a));
		if (n.lengthSq() > 0) n.normalize();
		n.toArray(triangles, p + 6);
		triangles[p + 9] = n.dot(_a);
		const centroid = _d.addVectors(_a, _b).add(_c).divideScalar(3);
		centroid.toArray(triangles, p + 10);
		triangles[p + 13] = Math.max(centroid.distanceTo(_a), centroid.distanceTo(_b), centroid.distanceTo(_c));
	}
	return { boxes: new Float32Array(boxes), children: new Int32Array(children), ranges: new Int32Array(ranges), triangles, positions, index: indices };
}

/** An orthonormal frame: the rows of the rotation from world space into it. */
export type Frame = { x: Vector3; y: Vector3; z: Vector3 };

const aligned = new WeakMap<Float32Array, { frame: Frame; tree: Tree }[]>();

/** The soup's tree built in a rotated frame (in float64, so nothing is lost); the last two frames are kept. */
function alignedTree(soup: Float32Array, frame: Frame) {
	const kept = aligned.get(soup) ?? [];
	const same = kept.find((k) => k.frame.x.equals(frame.x) && k.frame.y.equals(frame.y) && k.frame.z.equals(frame.z));
	if (same) return same.tree;
	const rotated = new Float64Array(soup.length);
	for (let i = 0; i < soup.length; i += 3) {
		_a.fromArray(soup, i);
		rotated[i] = _a.dot(frame.x);
		rotated[i + 1] = _a.dot(frame.y);
		rotated[i + 2] = _a.dot(frame.z);
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(rotated, 3));
	const tree = flatten(new MeshBVH(geometry));
	aligned.set(soup, [{ frame, tree }, ...kept].slice(0, 2));
	return tree;
}

function nodeGap(ta: Tree, i: number, tb: Tree, j: number) {
	const a = ta.boxes, b = tb.boxes;
	let sum = 0;
	for (let k = 0; k < 3; k++) {
		const d = Math.max(0, a[6 * i + k] - b[6 * j + 3 + k], b[6 * j + k] - a[6 * i + 3 + k]);
		sum += d * d;
	}
	return Math.sqrt(sum);
}

/** The square of a node's box diagonal. */
function nodeSize(tree: Tree, i: number) {
	const b = tree.boxes, x = b[6 * i + 3] - b[6 * i], y = b[6 * i + 4] - b[6 * i + 1], z = b[6 * i + 5] - b[6 * i + 2];
	return x * x + y * y + z * z;
}

/**
 * A cheap lower bound on the distance between two triangles: their boxes' gap, or how far one lies wholly beyond
 * the other's plane. The plane bound is what prunes long thin triangles, whose boxes are fat when tilted.
 */
function triangleGap(ta: Tree, s: number, tb: Tree, t: number) {
	const a = ta.triangles, b = tb.triangles, p = STRIDE * s, q = STRIDE * t;
	let sum = 0;
	for (let k = 0; k < 3; k++) {
		const d = Math.max(0, a[p + k] - b[q + 3 + k], b[q + k] - a[p + 3 + k]);
		sum += d * d;
	}
	return Math.max(Math.sqrt(sum), beyond(ta, s, tb, t), beyond(tb, t, ta, s));
}

/** How far all of t's corners lie beyond s's plane, on one side; 0 when they straddle it. */
function beyond(ts: Tree, s: number, tt: Tree, t: number) {
	const plane = ts.triangles, p = STRIDE * s;
	let low = Infinity, high = -Infinity;
	for (let k = 0; k < 3; k++) {
		const v = tt.index[3 * t + k] * 3;
		const h = plane[p + 6] * tt.positions[v] + plane[p + 7] * tt.positions[v + 1] + plane[p + 8] * tt.positions[v + 2] - plane[p + 9];
		low = Math.min(low, h);
		high = Math.max(high, h);
	}
	return low > 0 ? low : high < 0 ? -high : 0;
}

const _s = new Triangle();
const _t = new Triangle();
const _near = new Vector3();
const _centroid = new Vector3();

/**
 * A tighter bound where one triangle is small beside the other: its centroid's distance to the other triangle,
 * less its reach from that centroid. Two point-triangle distances against a microsecond for the exact test.
 */
function centroidGap(ta: Tree, s: number, tb: Tree, t: number) {
	load(_s, ta, s);
	load(_t, tb, t);
	const p = STRIDE * s, q = STRIDE * t;
	const fromS = _t.closestPointToPoint(_centroid.fromArray(ta.triangles, p + 10), _near).distanceTo(_centroid) - ta.triangles[p + 13];
	const fromT = _s.closestPointToPoint(_centroid.fromArray(tb.triangles, q + 10), _near).distanceTo(_centroid) - tb.triangles[q + 13];
	return Math.max(fromS, fromT);
}

function load<T extends Triangle>(tri: T, tree: Tree, t: number) {
	tri.a.fromArray(tree.positions, tree.index[3 * t] * 3);
	tri.b.fromArray(tree.positions, tree.index[3 * t + 1] * 3);
	tri.c.fromArray(tree.positions, tree.index[3 * t + 2] * 3);
	if (tri instanceof ExtendedTriangle) tri.needsUpdate = true;
	return tri;
}

/** Pairs of nodes by the gap between their boxes, least first: a binary heap over parallel arrays. */
class PairQueue {
	gap = 0;
	i = 0;
	j = 0;
	#gaps: number[] = [];
	#nodes: number[] = [];

	get size() {
		return this.#gaps.length;
	}

	push(gap: number, i: number, j: number) {
		const gaps = this.#gaps, nodes = this.#nodes;
		let k = gaps.length;
		while (k > 0) {
			const parent = (k - 1) >> 1;
			if (gaps[parent] <= gap) break;
			gaps[k] = gaps[parent];
			nodes[2 * k] = nodes[2 * parent];
			nodes[2 * k + 1] = nodes[2 * parent + 1];
			k = parent;
		}
		gaps[k] = gap;
		nodes[2 * k] = i;
		nodes[2 * k + 1] = j;
	}

	/** Takes the least pair into gap, i and j. */
	pop() {
		const gaps = this.#gaps, nodes = this.#nodes;
		this.gap = gaps[0];
		this.i = nodes[0];
		this.j = nodes[1];
		const n = gaps.length - 1;
		const gap = gaps[n], i = nodes[2 * n], j = nodes[2 * n + 1];
		gaps.length = n;
		nodes.length = 2 * n;
		if (!n) return;
		let k = 0;
		for (let child = 1; child < n; child = 2 * k + 1) {
			if (child + 1 < n && gaps[child + 1] < gaps[child]) child++;
			if (gaps[child] >= gap) break;
			gaps[k] = gaps[child];
			nodes[2 * k] = nodes[2 * child];
			nodes[2 * k + 1] = nodes[2 * child + 1];
			k = child;
		}
		gaps[k] = gap;
		nodes[2 * k] = i;
		nodes[2 * k + 1] = j;
	}
}

const _other = new ExtendedTriangle();
const _pa = new Vector3();
const _pb = new Vector3();
const pool: ExtendedTriangle[] = [];

/**
 * Nearest pair of points between two meshes, best first: pairs of BVH nodes come off a queue by the gap between
 * their boxes, the larger node of each splits, and the search stops once no gap can beat the best pair by more
 * than float noise, so a family of equally near pairs is not walked. (closestPointToGeometry is quadratic here.)
 */
export function meshPair(a: MeshBVH, b: MeshBVH) {
	return pairOf(treeOf(a), treeOf(b));
}

/**
 * meshPair for two soups, searched in a rotated frame. A family of equally near pairs (parallel planes, a shaft along
 * a plane, coaxial cylinders) prunes only where its triangles' boxes are tight, which is when the family runs along
 * the frame's axes; tilted in world space, their boxes are fat and the search visits every pair.
 */
export function meshPairIn(frame: Frame, a: Float32Array, b: Float32Array) {
	const pair = pairOf(alignedTree(a, frame), alignedTree(b, frame));
	for (const p of pair ? [pair.a, pair.b] : []) {
		_a.copy(p);
		p.copy(frame.x).multiplyScalar(_a.x).addScaledVector(frame.y, _a.y).addScaledVector(frame.z, _a.z);
	}
	return pair;
}

function pairOf(ta: Tree, tb: Tree): Pair | null {
	if (!ta.ranges.length || !tb.ranges.length) return null;
	let best = Infinity, limit = Infinity;
	const pa = new Vector3(), pb = new Vector3();
	const queue = new PairQueue();
	const visit = (i: number, j: number) => {
		const gap = nodeGap(ta, i, tb, j);
		if (gap < limit) queue.push(gap, i, j);
	};
	visit(0, 0);
	while (queue.size) {
		queue.pop();
		const { gap, i, j } = queue;
		if (gap >= limit) break;
		const leafA = ta.children[2 * i] < 0, leafB = tb.children[2 * j] < 0;
		if (!leafA && (leafB || nodeSize(ta, i) >= nodeSize(tb, j))) {
			visit(ta.children[2 * i], j);
			visit(ta.children[2 * i + 1], j);
			continue;
		}
		if (!leafB) {
			visit(i, tb.children[2 * j]);
			visit(i, tb.children[2 * j + 1]);
			continue;
		}
		const firstA = ta.ranges[2 * i], countA = ta.ranges[2 * i + 1];
		const firstB = tb.ranges[2 * j], countB = tb.ranges[2 * j + 1];
		while (pool.length < countA) pool.push(new ExtendedTriangle());
		// Triangles load (and the exact test sets them up) only once some pair of them passes the cheap bound.
		const loaded = new Uint8Array(countA);
		for (let t = firstB; t < firstB + countB; t++) {
			let other = false;
			for (let k = 0; k < countA; k++) {
				if (!(triangleGap(ta, firstA + k, tb, t) < limit) || !(centroidGap(ta, firstA + k, tb, t) < limit)) continue;
				if (!loaded[k]) {
					load(pool[k], ta, firstA + k);
					loaded[k] = 1;
				}
				if (!other) {
					load(_other, tb, t);
					other = true;
				}
				const d = pool[k].distanceToTriangle(_other, _pa, _pb);
				if (d >= best) continue;
				best = d;
				limit = best - (1e-6 + 1e-9 * best);
				if (d === 0) touching(pool[k], _other, _pa, _pb);
				pa.copy(_pa);
				pb.copy(_pb);
			}
		}
	}
	return best < Infinity ? { distance: best, a: pa, b: pb } : null;
}

const TOUCH = 1e-8;
const _edgeA = new Line3();
const _edgeB = new Line3();

/**
 * A point on both of two touching triangles, into pa and pb. distanceToTriangle's own witness is the middle of the
 * intersection segment, which for coplanar overlapping triangles is the origin.
 */
function touching(ta: ExtendedTriangle, tb: ExtendedTriangle, pa: Vector3, pb: Vector3) {
	if (ta.distanceToPoint(pa) < TOUCH && tb.distanceToPoint(pa) < TOUCH) return pb.copy(pa);
	// A centroid or corner of one inside the other, else a crossing of their edges.
	for (const [inner, outer] of [[ta, tb], [tb, ta]] as const) {
		for (const p of [inner.getMidpoint(_d), inner.a, inner.b, inner.c]) {
			if (outer.distanceToPoint(p) < TOUCH) return pb.copy(pa.copy(p));
		}
	}
	for (const [a0, a1] of [[ta.a, ta.b], [ta.b, ta.c], [ta.c, ta.a]]) {
		for (const [b0, b1] of [[tb.a, tb.b], [tb.b, tb.c], [tb.c, tb.a]]) {
			if (_edgeA.set(a0, a1).distanceSqToLine3(_edgeB.set(b0, b1), pa, pb) < TOUCH * TOUCH) return pb;
		}
	}
	return tb.closestPointToPoint(ta.getMidpoint(pa), pb);
}
