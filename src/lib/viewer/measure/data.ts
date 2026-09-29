// The measurement file's solids placed in the scene. A body's solid is in the frame of its occurrence node (the body
// node's own matrix only undoes the GLB's quantization), so world = occurrence.matrixWorld × p. Everything here is
// built when asked for and cached until the model moves or changes.
import * as THREE from 'three';
import { EDGE, FACE, type EdgeRecord, type FaceRecord, type MeasureFile, type SolidRecord } from '$lib/measure/format';
import type { Curve, EdgeEntity, Entity, FaceEntity, Surface } from '$lib/measure/types';
import type { MeasureKind, MeasureRef } from '$lib/state/hash';
import type { Part, PartIndex } from '../parts';
import { faceSoup, trianglesByFace } from './faces';

export type SnapRole = 'vertex' | 'centre' | 'midpoint';
/** A point that can be picked: a vertex, the centre of a circular edge or the middle of an open edge. */
export type Snap = { ref: MeasureRef; role: SnapRole; point: THREE.Vector3 };

type Frame = { matrix: THREE.Matrix4; rotation: THREE.Matrix3; handed: number };
type Arc = Extract<Curve, { kind: 'arc' }>;

const TWO_PI = Math.PI * 2;
const SHAPES: Record<number, string> = { [FACE.plane]: 'plane', [FACE.cylinder]: 'cylinder', [FACE.cone]: 'cone', [FACE.sphere]: 'sphere', [FACE.torus]: 'torus' };

/** Two base-36 characters from a text: the check that ties a link's item to its size. */
function hash36(text: string) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return ((h >>> 0) % 1296).toString(36).padStart(2, '0');
}

export function arcPoint(arc: Arc, angle: number) {
	const side = new THREE.Vector3().crossVectors(arc.normal, arc.ref);
	const a = arc.start + angle;
	return arc.centre.clone().addScaledVector(arc.ref, arc.radius * Math.cos(a)).addScaledVector(side, arc.radius * Math.sin(a));
}

export class Topology {
	#frames = new Map<Part, Frame>();
	#polylines = new Map<string, THREE.Vector3[]>();

	constructor(
		readonly data: MeasureFile,
		readonly parts: PartIndex
	) {}

	/** Forgets world positions: the model moved. */
	reset() {
		this.#frames.clear();
		this.#polylines.clear();
	}

	body(id: string): Part | null {
		const part = this.parts.byId.get(id);
		return part?.body ? part : null;
	}

	solid(body: Part): SolidRecord | null {
		const index = (body.object.userData as { solid?: number }).solid;
		return index === undefined ? null : (this.data.solids[index] ?? null);
	}

	frame(body: Part): Frame {
		let frame = this.#frames.get(body);
		if (!frame) {
			const occurrence = body.object.parent!;
			occurrence.updateWorldMatrix(true, false);
			const matrix = occurrence.matrixWorld.clone();
			frame = { matrix, rotation: new THREE.Matrix3().setFromMatrix4(matrix), handed: Math.sign(matrix.determinant()) || 1 };
			this.#frames.set(body, frame);
		}
		return frame;
	}

	point(body: Part, x: number, y: number, z: number) {
		return new THREE.Vector3(x, y, z).applyMatrix4(this.frame(body).matrix);
	}

	direction(body: Part, x: number, y: number, z: number) {
		return new THREE.Vector3(x, y, z).applyMatrix3(this.frame(body).rotation).normalize();
	}

	vertex(body: Part, i: number) {
		const p = this.solid(body)!.p;
		return this.point(body, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
	}

	edge(body: Part, e: number): EdgeRecord {
		return this.solid(body)?.e[e] ?? null;
	}

	face(body: Part, f: number): FaceRecord | null {
		return this.solid(body)?.f[f] ?? null;
	}

	/** Edge ids of a face, every loop. */
	faceEdges(body: Part, f: number): number[] {
		return this.face(body, f)?.[2].flat() ?? [];
	}

	length(body: Part, e: number): number {
		const edge = this.edge(body, e);
		if (!edge) return 0;
		if (edge[0] === EDGE.line) return this.vertex(body, edge[1]).distanceTo(this.vertex(body, edge[2]));
		if (edge[0] === EDGE.arc) return edge[12] * edge[13];
		return edge[3];
	}

	/** An edge's exact curve in world space. */
	curve(body: Part, e: number): Curve | null {
		const edge = this.edge(body, e);
		if (!edge) return null;
		if (edge[0] === EDGE.line) return { kind: 'line', start: this.vertex(body, edge[1]), end: this.vertex(body, edge[2]) };
		if (edge[0] === EDGE.arc) {
			const [, , , cx, cy, cz, nx, ny, nz, rx, ry, rz, radius, sweep] = edge;
			// A mirrored placement turns the other way round; flipping the normal keeps p(ψ) = c + r(cos ψ·ref + sin ψ·n × ref).
			const normal = this.direction(body, nx, ny, nz).multiplyScalar(this.frame(body).handed);
			return { kind: 'arc', centre: this.point(body, cx, cy, cz), normal, radius, ref: this.direction(body, rx, ry, rz), start: 0, sweep };
		}
		return { kind: 'polyline', points: this.polyline(body, e), deflection: this.solid(body)!.tol };
	}

	/** Points along an edge in world space, for drawing and picking. */
	polyline(body: Part, e: number): THREE.Vector3[] {
		const key = `${body.id}:${e}`;
		const cached = this.#polylines.get(key);
		if (cached) return cached;
		const edge = this.edge(body, e);
		let points: THREE.Vector3[] = [];
		if (edge?.[0] === EDGE.line) points = [this.vertex(body, edge[1]), this.vertex(body, edge[2])];
		else if (edge?.[0] === EDGE.arc) {
			const arc = this.curve(body, e) as Arc;
			const steps = Math.max(8, Math.ceil(arc.sweep / (Math.PI / 36)));
			for (let i = 0; i <= steps; i++) points.push(arcPoint(arc, (arc.sweep * i) / steps));
		} else if (edge) {
			const flat = edge[7];
			for (let i = 0; i < flat.length; i += 3) points.push(this.point(body, flat[i], flat[i + 1], flat[i + 2]));
		}
		this.#polylines.set(key, points);
		return points;
	}

	/** The middle of an open edge; a closed one has none. */
	midpoint(body: Part, e: number): THREE.Vector3 | null {
		const edge = this.edge(body, e);
		if (!edge) return null;
		if (edge[0] === EDGE.line) return this.vertex(body, edge[1]).add(this.vertex(body, edge[2])).multiplyScalar(0.5);
		if (edge[0] === EDGE.arc) return edge[13] < TWO_PI - 1e-6 ? arcPoint(this.curve(body, e) as Arc, edge[13] / 2) : null;
		return edge[1] !== edge[2] ? this.point(body, edge[4], edge[5], edge[6]) : null;
	}

	centre(body: Part, e: number): THREE.Vector3 | null {
		const edge = this.edge(body, e);
		return edge?.[0] === EDGE.arc ? this.point(body, edge[3], edge[4], edge[5]) : null;
	}

	snapsOfEdge(body: Part, e: number): Snap[] {
		const edge = this.edge(body, e);
		if (!edge) return [];
		const ref = (kind: MeasureKind, index: number): MeasureRef => ({ part: body.id, kind, index });
		const snaps: Snap[] = [];
		for (const v of new Set([edge[1], edge[2]])) if (v >= 0) snaps.push({ ref: ref('v', v), role: 'vertex', point: this.vertex(body, v) });
		const middle = this.midpoint(body, e);
		if (middle) snaps.push({ ref: ref('m', e), role: 'midpoint', point: middle });
		const centre = this.centre(body, e);
		if (centre) snaps.push({ ref: ref('c', e), role: 'centre', point: centre });
		return snaps;
	}

	/** The centres of a face's circular edges: a hole's or a boss's centre, on either end. */
	snapsOfFace(body: Part, f: number): Snap[] {
		const snaps: Snap[] = [];
		for (const e of this.faceEdges(body, f)) {
			const centre = this.centre(body, e);
			if (centre && !snaps.some((s) => s.point.distanceToSquared(centre) < 1e-12)) snaps.push({ ref: { part: body.id, kind: 'c', index: e }, role: 'centre', point: centre });
		}
		return snaps;
	}

	surface(body: Part, face: FaceRecord): Surface {
		const s = face.slice(3) as number[];
		switch (face[0]) {
			case FACE.plane:
				return { kind: 'plane', origin: this.point(body, s[0] * s[3], s[1] * s[3], s[2] * s[3]), normal: this.direction(body, s[0], s[1], s[2]) };
			case FACE.cylinder:
				return { kind: 'cylinder', origin: this.point(body, s[0], s[1], s[2]), axis: this.direction(body, s[3], s[4], s[5]), radius: s[7] };
			case FACE.cone:
				return { kind: 'cone', apex: this.point(body, s[0], s[1], s[2]), axis: this.direction(body, s[3], s[4], s[5]), halfAngle: s[6] };
			case FACE.sphere:
				return { kind: 'sphere', centre: this.point(body, s[0], s[1], s[2]), radius: s[3] };
			case FACE.torus:
				return { kind: 'torus', centre: this.point(body, s[0], s[1], s[2]), axis: this.direction(body, s[3], s[4], s[5]), major: s[6], minor: s[7] };
			default:
				return { kind: 'other' };
		}
	}

	/** The mesh of the body that draws a face (faces keep to one colour group). */
	meshOf(body: Part, f: number): THREE.Mesh | null {
		return body.meshes.find((mesh) => trianglesByFace(mesh.geometry)?.has(f)) ?? null;
	}

	edgeEntity(body: Part, e: number): EdgeEntity {
		return { type: 'edge', id: `${body.id}.e${e}`, curve: this.curve(body, e)!, length: this.length(body, e) };
	}

	faceEntity(body: Part, f: number): FaceEntity {
		const face = this.face(body, f)!;
		const mesh = this.meshOf(body, f);
		return {
			type: 'face',
			id: `${body.id}.f${f}`,
			surface: this.surface(body, face),
			area: face[1],
			loopLength: (face[2][0] ?? []).reduce((sum, e) => sum + this.length(body, e), 0),
			soup: mesh ? faceSoup(mesh, f) : new Float32Array(),
			tol: this.solid(body)!.tol,
			edges: face[2].flat().map((e) => this.edgeEntity(body, e))
		};
	}

	/** What the math measures for a selected item, in world space; null when the item is not in this file. */
	entity(ref: MeasureRef): Entity | null {
		if (!this.valid(ref)) return null;
		const body = this.body(ref.part)!;
		const id = `${ref.part}.${ref.kind}${ref.index}`;
		switch (ref.kind) {
			case 'f':
				return this.faceEntity(body, ref.index);
			case 'e':
				return this.edgeEntity(body, ref.index);
			case 'v':
				return { type: 'point', id, role: 'vertex', position: this.vertex(body, ref.index) };
			case 'c':
				return { type: 'point', id, role: 'centre', position: this.centre(body, ref.index)! };
			case 'm':
				return { type: 'point', id, role: 'midpoint', position: this.midpoint(body, ref.index)! };
		}
	}

	/** Whether a link's item exists in this file and, when it carries a check, is the same size as when it was made. */
	valid(ref: MeasureRef): boolean {
		const body = this.body(ref.part);
		const solid = body && this.solid(body);
		if (!body || !solid) return false;
		const { index } = ref;
		const exists =
			ref.kind === 'f' ? index < solid.f.length
			: ref.kind === 'v' ? index < solid.p.length / 3
			: ref.kind === 'e' ? !!solid.e[index]
			: ref.kind === 'c' ? solid.e[index]?.[0] === EDGE.arc
			: !!this.midpoint(body, index);
		return exists && (!ref.check || ref.check === this.check(ref));
	}

	/** Two characters from the item's kind and size, rounded to 0.01 mm (or mm²). */
	check(ref: MeasureRef): string {
		const body = this.body(ref.part)!;
		const solid = this.solid(body)!;
		const i = ref.index;
		if (ref.kind === 'f') return hash36(`f${solid.f[i][0]}:${solid.f[i][1].toFixed(2)}`);
		if (ref.kind === 'v') return hash36(`v${solid.p.slice(i * 3, i * 3 + 3).map((v) => v.toFixed(2)).join(',')}`);
		return hash36(`e${solid.e[i]![0]}:${this.length(body, i).toFixed(2)}`);
	}

	/** The ref as a link stores it, with its check. */
	withCheck(ref: MeasureRef): MeasureRef {
		return { part: ref.part, kind: ref.kind, index: ref.index, check: this.check(ref) };
	}

	/** "Face · cylinder", "Edge · circle", "Centre", for the panel. */
	title(ref: MeasureRef): string {
		const body = this.body(ref.part)!;
		if (ref.kind === 'f') return `Face · ${SHAPES[this.face(body, ref.index)![0]] ?? 'free-form'}`;
		if (ref.kind === 'e') {
			const edge = this.edge(body, ref.index)!;
			return `Edge · ${edge[0] === EDGE.line ? 'line' : edge[0] === EDGE.arc ? (edge[13] >= TWO_PI - 1e-6 ? 'circle' : 'arc') : 'curve'}`;
		}
		return ref.kind === 'v' ? 'Vertex' : ref.kind === 'c' ? 'Centre' : 'Midpoint';
	}

	/**
	 * The other way to take a circle: a circular edge or face and its centre point. Touch has no hover to find the
	 * centre with, so the panel offers the switch instead.
	 */
	alternate(ref: MeasureRef): MeasureRef | null {
		const body = this.body(ref.part)!;
		if (ref.kind === 'c') return { part: ref.part, kind: 'e', index: ref.index };
		if (ref.kind === 'e') return this.centre(body, ref.index) ? { part: ref.part, kind: 'c', index: ref.index } : null;
		if (ref.kind === 'f') {
			const face = this.face(body, ref.index)!;
			const outer = face[2][0] ?? [];
			const circle = outer.length === 1 && this.centre(body, outer[0]);
			const round = face[0] === FACE.plane || face[0] === FACE.cylinder;
			return round && circle ? { part: ref.part, kind: 'c', index: outer[0] } : null;
		}
		return null;
	}
}
