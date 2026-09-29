// What the pointer is on, in Fusion's order: a point near it, then an edge near it, then the face under it. Edges and
// points come from the faces around the pointer (a ring of rays catches an edge seen side-on), measured in screen
// pixels. Before the measurement file has arrived only faces can be picked.
import * as THREE from 'three';
import type { MeasureRef } from '$lib/state/hash';
import type { Part } from '../parts';
import type { SurfaceHit, Viewer } from '../scene';
import type { Snap, SnapRole, Topology } from './data';
import { faceOf } from './faces';

/**
 * Pixels: how near the pointer a point or an edge must be, and how much nearer an edge must be to beat a point. Touch
 * is coarser. With ⌘/Ctrl held only points count, from further away.
 */
export type Tolerance = { point: number; edge: number; bias: number };
export const MOUSE: Tolerance = { point: 8, edge: 5, bias: 3 };
export const TOUCH: Tolerance = { point: 22, edge: 14, bias: 6 };
export const LOCK = 64;

export type Pick =
	| { kind: 'face'; ref: MeasureRef; body: Part; mesh: THREE.Mesh; face: number }
	| { kind: 'edge'; ref: MeasureRef; body: Part; edge: number }
	| { kind: 'point'; ref: MeasureRef; body: Part; point: THREE.Vector3; role: SnapRole };

export type Candidate = { pick: Pick; px: number };
export type PickOptions = { touch: boolean; snapping: boolean; lock: boolean };

/**
 * Fusion's priority among what lies near the pointer: a point, then an edge, then the face under it. A point gives way
 * to an edge the pointer sits clearly closer to, so a small hole's centre does not swallow its rim. With `lock`, only
 * points count.
 */
export function choose(points: Candidate[], edges: Candidate[], face: Pick | null, tolerance: Tolerance, lock: boolean): Pick | null {
	const nearest = (list: Candidate[], limit: number) => list.filter((c) => c.px <= limit).sort((a, b) => a.px - b.px)[0] ?? null;
	if (lock) return nearest(points, LOCK)?.pick ?? null;
	const point = nearest(points, tolerance.point), edge = nearest(edges, tolerance.edge);
	if (point && (!edge || point.px <= edge.px + tolerance.bias)) return point.pick;
	return edge?.pick ?? face;
}

const RING = 8;

export class Picker {
	/** Snap points that stay pickable when the pointer leaves their edge or face, until the camera moves. */
	sticky: Snap[] = [];

	constructor(
		readonly viewer: Viewer,
		readonly topology: () => Topology | null
	) {}

	/** The pick under a canvas pixel, and the snap points to show for it. */
	pick(x: number, y: number, options: PickOptions): { pick: Pick | null; snaps: Snap[] } {
		const tolerance = options.touch ? TOUCH : MOUSE;
		const centre = this.viewer.surfaceAt(x, y);
		const face = centre ? facePick(centre) : null;
		const topology = this.topology();
		if (!topology) return { pick: face, snaps: [] };

		const faces = new Map<string, { body: Part; face: number }>();
		const around = (hit: SurfaceHit | null) => {
			const f = hit && faceOf(hit.mesh, hit.vertex);
			if (hit && f !== null) faces.set(`${hit.part.id}:${f}`, { body: hit.part, face: f });
		};
		around(centre);
		for (const radius of options.touch ? [tolerance.edge, tolerance.edge / 2] : [tolerance.edge]) {
			for (let i = 0; i < RING; i++) {
				const angle = (i / RING) * Math.PI * 2;
				around(this.viewer.surfaceAt(x + radius * Math.cos(angle), y + radius * Math.sin(angle)));
			}
		}

		// Only what lies within reach is tested for being hidden, one ray each.
		const pointReach = options.lock ? LOCK : tolerance.point;
		const points: Candidate[] = [];
		const edges: Candidate[] = [];
		const snapsBy = new Map<string, Snap[]>();
		const seen = new Set<string>();
		for (const { body, face: f } of faces.values()) {
			for (const e of topology.faceEdges(body, f)) {
				const key = `${body.id}:${e}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const near = this.#nearest(topology.polyline(body, e), x, y);
				if (near && near.px <= tolerance.edge && this.#visible(near.point, near.screen)) {
					edges.push({ pick: { kind: 'edge', ref: { part: body.id, kind: 'e', index: e }, body, edge: e }, px: near.px });
				}
				const snaps = topology.snapsOfEdge(body, e);
				snapsBy.set(key, snaps);
				for (const snap of snaps) {
					// Vertices can always be picked; centres and midpoints only while snapping, as with Fusion's snap points.
					if (snap.role !== 'vertex' && !options.snapping) continue;
					const screen = this.viewer.toScreen(snap.point);
					const px = screen ? Math.hypot(screen.x - x, screen.y - y) : Infinity;
					if (px > pointReach || (snap.role === 'vertex' && !this.#visible(snap.point, screen!))) continue;
					points.push({ pick: pointPick(snap, body), px });
				}
			}
		}
		if (options.snapping) {
			for (const snap of this.sticky) {
				const screen = this.viewer.toScreen(snap.point);
				const body = topology.body(snap.ref.part);
				if (screen && body) points.push({ pick: pointPick(snap, body), px: Math.hypot(screen.x - x, screen.y - y) });
			}
		}

		const pick = choose(points, edges, face, tolerance, options.lock);
		let snaps: Snap[] = [];
		if (pick?.kind === 'edge') snaps = snapsBy.get(`${pick.body.id}:${pick.edge}`) ?? [];
		else if (pick?.kind === 'face') snaps = topology.snapsOfFace(pick.body, pick.face);
		else if (pick?.kind === 'point') snaps = [{ ref: pick.ref, role: pick.role, point: pick.point }];
		if (!options.snapping) snaps = snaps.filter((s) => s.role === 'vertex');
		if (pick && pick.kind !== 'point' && snaps.length) this.sticky = snaps.filter((s) => s.role !== 'vertex');
		return { pick, snaps: dedupe([...snaps, ...(options.snapping ? this.sticky : [])]) };
	}

	/** The point of a polyline nearest a pixel on screen, where the section keeps it. */
	#nearest(points: THREE.Vector3[], x: number, y: number) {
		let best: { px: number; point: THREE.Vector3; screen: THREE.Vector2 } | null = null;
		const a = new THREE.Vector2(), b = new THREE.Vector2(), p = new THREE.Vector2(x, y);
		for (let i = 0; i + 1 < points.length; i++) {
			if (!this.viewer.toScreen(points[i], a) || !this.viewer.toScreen(points[i + 1], b)) continue;
			const ab = b.clone().sub(a);
			const t = ab.lengthSq() ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0;
			const onScreen = a.clone().addScaledVector(ab, t);
			const px = onScreen.distanceTo(p);
			if (best && px >= best.px) continue;
			const point = points[i].clone().lerp(points[i + 1], t);
			if (!this.viewer.section.keeps(point)) continue;
			best = { px, point, screen: onScreen };
		}
		return best;
	}

	/** Whether nothing shown lies in front of a point (a small margin lets it sit on its own surface). */
	#visible(point: THREE.Vector3, screen: THREE.Vector2) {
		const hit = this.viewer.surfaceAt(screen.x, screen.y);
		if (!hit) return true;
		const distance = this.viewer.rayAt(screen.x, screen.y).origin.distanceTo(point);
		return distance <= hit.distance + Math.max(0.05, distance * 1e-3);
	}
}

function facePick(hit: SurfaceHit): Pick | null {
	const face = faceOf(hit.mesh, hit.vertex);
	return face === null ? null : { kind: 'face', ref: { part: hit.part.id, kind: 'f', index: face }, body: hit.part, mesh: hit.mesh, face };
}

function pointPick(snap: Snap, body: Part): Pick {
	return { kind: 'point', ref: snap.ref, body, point: snap.point, role: snap.role };
}

function dedupe(snaps: Snap[]) {
	const out: Snap[] = [];
	for (const snap of snaps) if (!out.some((s) => s.point.distanceToSquared(snap.point) < 1e-12)) out.push(snap);
	return out;
}
