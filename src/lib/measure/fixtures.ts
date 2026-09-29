// Synthetic entities for the tests: soups tessellated at a known chordal deflection, with exact boundary edges.
import { Vector3 } from 'three';
import { TAU, curveLength } from './primitives';
import type { Curve, EdgeEntity, FaceEntity, PointEntity, Surface } from './types';

export const DEFLECTION = 0.005;
export const TOL = DEFLECTION + 1e-4;

let serial = 0;
const next = (kind: string) => `${kind}${++serial}`;

export const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
export const X = v(1, 0, 0);
export const Y = v(0, 1, 0);
export const Z = v(0, 0, 1);

export function point(position: Vector3): PointEntity {
	return { type: 'point', id: next('p'), role: 'vertex', position };
}

export function edge(curve: Curve): EdgeEntity {
	return { type: 'edge', id: next('e'), curve, length: curveLength(curve) };
}

export const line = (start: Vector3, end: Vector3) => edge({ kind: 'line', start, end });

export const arc = (centre: Vector3, normal: Vector3, radius: number, ref: Vector3, start = 0, sweep = TAU) =>
	edge({ kind: 'arc', centre, normal, radius, ref, start, sweep });

/** Segments for a sweep of a circle so that every chord stays within the deflection. */
function steps(radius: number, sweep: number, deflection = DEFLECTION) {
	return Math.max(2, Math.ceil(sweep / (2 * Math.acos(1 - deflection / radius))));
}

/** Two triangles per cell of a grid of points; shared points give bitwise-equal vertices, so seams weld. */
function grid(rows: Vector3[][]) {
	const soup: number[] = [];
	for (let i = 0; i + 1 < rows.length; i++) {
		for (let j = 0; j + 1 < rows[i].length; j++) {
			const a = rows[i][j], b = rows[i + 1][j], c = rows[i + 1][j + 1], d = rows[i][j + 1];
			for (const p of [a, b, c, a, c, d]) soup.push(p.x, p.y, p.z);
		}
	}
	return new Float32Array(soup);
}

/** n + 1 points around a sweep; a full turn ends on its first point. */
function ring<T>(n: number, sweep: number, at: (i: number) => T) {
	const points = Array.from({ length: n + 1 }, (_, i) => at(i));
	if (sweep >= TAU - 1e-9) points[n] = points[0];
	return points;
}

function face(surface: Surface, rows: Vector3[][], edges: EdgeEntity[], area: number, tol = TOL): FaceEntity {
	const loopLength = edges.reduce((sum, e) => sum + e.length, 0);
	return { type: 'face', id: next('f'), surface, area, loopLength, soup: grid(rows), tol, edges };
}

type RectangleOptions = { tol?: number; other?: boolean; soupOffset?: number };

/** The parallelogram origin + s·u + t·w, s and t in [0, 1], normal u × w. */
export function rectangle(origin: Vector3, u: Vector3, w: Vector3, { tol = TOL, other = false, soupOffset = 0 }: RectangleOptions = {}) {
	const normal = u.clone().cross(w).normalize();
	const at = (s: number, t: number) => origin.clone().addScaledVector(u, s).addScaledVector(w, t);
	const rows = Array.from({ length: 5 }, (_, i) =>
		Array.from({ length: 5 }, (_, j) => at(i / 4, j / 4).addScaledVector(normal, soupOffset))
	);
	const corners = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
	const edges = corners.map((c, i) => line(c, corners[(i + 1) % 4]));
	const surface: Surface = other ? { kind: 'other' } : { kind: 'plane', origin, normal };
	return face(surface, rows, edges, u.clone().cross(w).length(), tol);
}

/** A circular planar face: a fan from the centre to its rim. */
export function disc(centre: Vector3, normal: Vector3, ref: Vector3, radius: number) {
	const e2 = normal.clone().cross(ref), n = steps(radius, TAU);
	const rim = ring(n, TAU, (i) => centre.clone().addScaledVector(ref, radius * Math.cos((TAU * i) / n)).addScaledVector(e2, radius * Math.sin((TAU * i) / n)));
	return face({ kind: 'plane', origin: centre, normal }, [new Array<Vector3>(n + 1).fill(centre), rim], [arc(centre, normal, radius, ref)], Math.PI * radius * radius);
}

/** A polyline through points along an arc, standing in for a curve the kernel cannot describe exactly. */
export function sampled(centre: Vector3, normal: Vector3, radius: number, ref: Vector3, sweep: number, deflection = DEFLECTION) {
	const e2 = normal.clone().cross(ref), n = steps(radius, sweep, deflection);
	const points = Array.from({ length: n + 1 }, (_, i) =>
		centre.clone().addScaledVector(ref, radius * Math.cos((sweep * i) / n)).addScaledVector(e2, radius * Math.sin((sweep * i) / n))
	);
	return edge({ kind: 'polyline', points, deflection });
}

/** A cylinder face about origin + h·axis, h in [0, height], swept from ref by angle about the axis. */
export function cylinder(origin: Vector3, axis: Vector3, ref: Vector3, radius: number, height: number, start = 0, sweep = TAU, segments = steps(radius, sweep)) {
	const e2 = axis.clone().cross(ref);
	const at = (psi: number, h: number) =>
		origin.clone().addScaledVector(axis, h).addScaledVector(ref, radius * Math.cos(psi)).addScaledVector(e2, radius * Math.sin(psi));
	const rows = [0, height].map((h) => ring(segments, sweep, (i) => at(start + (sweep * i) / segments, h)));
	const edges = [0, height].map((h) => arc(origin.clone().addScaledVector(axis, h), axis, radius, ref, start, sweep));
	if (sweep < TAU - 1e-9) for (const psi of [start, start + sweep]) edges.push(line(at(psi, 0), at(psi, height)));
	return face({ kind: 'cylinder', origin, axis, radius }, rows, edges, radius * sweep * height);
}

/** A cone face between h0 and h1 along the axis from the apex, where its radius is h·tan α. */
export function cone(apex: Vector3, axis: Vector3, ref: Vector3, halfAngle: number, h0: number, h1: number) {
	const e2 = axis.clone().cross(ref), tan = Math.tan(halfAngle);
	const n = steps(h1 * tan, TAU);
	const at = (psi: number, h: number) =>
		apex.clone().addScaledVector(axis, h).addScaledVector(ref, h * tan * Math.cos(psi)).addScaledVector(e2, h * tan * Math.sin(psi));
	const rows = [h0, h1].map((h) => ring(n, TAU, (i) => at((TAU * i) / n, h)));
	const edges = [h0, h1].map((h) => arc(apex.clone().addScaledVector(axis, h), axis, h * tan, ref));
	const area = Math.PI * (h0 + h1) * tan * ((h1 - h0) / Math.cos(halfAngle));
	return face({ kind: 'cone', apex, axis, halfAngle }, rows, edges, area);
}

/** A whole sphere; doubly curved, so each direction gets half the deflection. */
export function sphere(centre: Vector3, radius: number) {
	const lat = steps(radius, Math.PI, DEFLECTION / 2), lon = steps(radius, TAU, DEFLECTION / 2);
	const rows = Array.from({ length: lat + 1 }, (_, i) => {
		const phi = -Math.PI / 2 + (Math.PI * i) / lat;
		// Each pole is one point.
		if (i === 0 || i === lat) return new Array<Vector3>(lon + 1).fill(centre.clone().addScaledVector(Z, radius * Math.sin(phi)));
		return ring(lon, TAU, (j) => {
			const theta = (TAU * j) / lon;
			return centre.clone().add(v(radius * Math.cos(phi) * Math.cos(theta), radius * Math.cos(phi) * Math.sin(theta), radius * Math.sin(phi)));
		});
	});
	return face({ kind: 'sphere', centre, radius }, rows, [], 4 * Math.PI * radius * radius);
}

/** A whole torus about the axis; half the deflection in each direction. */
export function torus(centre: Vector3, axis: Vector3, ref: Vector3, major: number, minor: number) {
	const e2 = axis.clone().cross(ref);
	const around = steps(major + minor, TAU, DEFLECTION / 2), tube = steps(minor, TAU, DEFLECTION / 2);
	const rows = ring(around, TAU, (i) => {
		const theta = (TAU * i) / around;
		const out = ref.clone().multiplyScalar(Math.cos(theta)).addScaledVector(e2, Math.sin(theta));
		return ring(tube, TAU, (j) => {
			const phi = (TAU * j) / tube;
			return centre.clone().addScaledVector(out, major + minor * Math.cos(phi)).addScaledVector(axis, minor * Math.sin(phi));
		});
	});
	return face({ kind: 'torus', centre, axis, major, minor }, rows, [], 4 * Math.PI * Math.PI * major * minor);
}

/** The square [−half, half]² at z = 0 with a round hole at the origin. */
export function plate(half: number, hole: number) {
	const n = 8 * Math.ceil(steps(hole, TAU) / 8);
	const direction = (i: number) => v(Math.cos((TAU * i) / n), Math.sin((TAU * i) / n), 0);
	const inner = ring(n, TAU, (i) => direction(i).multiplyScalar(hole));
	// Along the same rays out to the square, so the corners (multiples of 45°) are vertices.
	const outer = ring(n, TAU, (i) => {
		const d = direction(i);
		return d.multiplyScalar(half / Math.max(Math.abs(d.x), Math.abs(d.y)));
	});
	const corners = [v(-half, -half, 0), v(half, -half, 0), v(half, half, 0), v(-half, half, 0)];
	const edges = [...corners.map((c, i) => line(c, corners[(i + 1) % 4])), arc(v(0, 0, 0), Z, hole, X)];
	return face({ kind: 'plane', origin: v(0, 0, 0), normal: Z }, [inner, outer], edges, 4 * half * half - Math.PI * hole * hole);
}
