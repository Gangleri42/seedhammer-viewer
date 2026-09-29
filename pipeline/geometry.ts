// Pure mesh helpers: weld, split per B-rep face, and crease-split normals with feature edges. Units are mm.
const CREASE = Math.cos((30 * Math.PI) / 180);

/** `faces` holds each vertex's B-rep face id; no vertex is shared by two faces. */
export type Geometry = { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Uint32Array; faces: Uint16Array };

/** Merges nodes at the same position (1e-4 mm) so the simplifier sees a closed surface. */
export function weld(positions: Float32Array, indices: Uint32Array) {
	const map = new Map<string, number>();
	const remap = new Uint32Array(positions.length / 3);
	const out: number[] = [];
	for (let i = 0; i < remap.length; i++) {
		const k = `${Math.round(positions[i * 3] * 1e4)},${Math.round(positions[i * 3 + 1] * 1e4)},${Math.round(positions[i * 3 + 2] * 1e4)}`;
		let j = map.get(k);
		if (j === undefined) {
			j = out.length / 3;
			map.set(k, j);
			out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
		}
		remap[i] = j;
	}
	const welded = indices.map((i) => remap[i]);
	return { positions: new Float32Array(out), indices: welded };
}

/**
 * Gives every (vertex, face) pair its own vertex, so no vertex is shared by two B-rep faces. The simplifier then treats
 * face borders as seams, which it keeps, and every triangle it returns lies on one face.
 */
export function splitByFace(positions: Float32Array, indices: Uint32Array, triangleFaces: Uint32Array) {
	const map = new Map<number, number>();
	const out: number[] = [];
	const faces: number[] = [];
	const split = new Uint32Array(indices.length);
	for (let i = 0; i < indices.length; i++) {
		const v = indices[i], face = triangleFaces[(i / 3) | 0];
		if (face > 0xffff) throw new Error(`face id ${face} does not fit the 16-bit _FACEID attribute`);
		const key = v * 0x10000 + face;
		let j = map.get(key);
		if (j === undefined) {
			j = faces.length;
			map.set(key, j);
			out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
			faces.push(face);
		}
		split[i] = j;
	}
	return { positions: new Float32Array(out), indices: split, faces: Uint16Array.from(faces) };
}

/**
 * Splits vertices along creases sharper than 30 degrees and collects those creases (plus open borders) as edges.
 * Neighbours are found by position, so a smooth border between two faces shades and draws like the inside of a face;
 * an output vertex never serves two faces.
 */
export function creaseNormals(positions: Float32Array, indices: Uint32Array, vertexFaces?: Uint16Array): Geometry {
	const triCount = indices.length / 3;
	const faceN = new Float32Array(triCount * 3);
	const unitN = new Float32Array(triCount * 3);
	for (let t = 0; t < triCount; t++) {
		const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
		const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
		const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const len = Math.hypot(nx, ny, nz) || 1;
		faceN.set([nx, ny, nz], t * 3);
		unitN.set([nx / len, ny / len, nz / len], t * 3);
	}
	const dot = (s: number, t: number) => unitN[s * 3] * unitN[t * 3] + unitN[s * 3 + 1] * unitN[t * 3 + 1] + unitN[s * 3 + 2] * unitN[t * 3 + 2];

	// Copies of one position (split per face) count as one vertex for neighbours and edges.
	const byPosition = new Map<string, number>();
	const canon = new Uint32Array(positions.length / 3);
	let vertexCount = 0;
	for (let v = 0; v < canon.length; v++) {
		const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
		let c = byPosition.get(key);
		if (c === undefined) byPosition.set(key, (c = vertexCount++));
		canon[v] = c;
	}
	const corner = indices.map((v) => canon[v]);

	const start = new Uint32Array(vertexCount + 1);
	for (const v of corner) start[v + 1]++;
	for (let v = 0; v < vertexCount; v++) start[v + 1] += start[v];
	const fill = start.slice(0, vertexCount);
	const incident = new Uint32Array(corner.length);
	for (let i = 0; i < corner.length; i++) incident[fill[corner[i]]++] = (i / 3) | 0;

	const outPos: number[] = [], outNor: number[] = [], outFace: number[] = [];
	const outIdx = new Uint32Array(indices.length);
	const seen = new Map<string, number>();
	for (let i = 0; i < indices.length; i++) {
		const t = (i / 3) | 0, v = corner[i], face = vertexFaces?.[indices[i]] ?? 0;
		let nx = 0, ny = 0, nz = 0;
		for (let k = start[v]; k < start[v + 1]; k++) {
			const s = incident[k];
			if (dot(s, t) < CREASE) continue;
			nx += faceN[s * 3]; ny += faceN[s * 3 + 1]; nz += faceN[s * 3 + 2];
		}
		const len = Math.hypot(nx, ny, nz) || 1;
		nx /= len; ny /= len; nz /= len;
		const k = `${v}:${face}:${Math.round(nx * 500)},${Math.round(ny * 500)},${Math.round(nz * 500)}`;
		let j = seen.get(k);
		if (j === undefined) {
			j = outPos.length / 3;
			seen.set(k, j);
			const p = indices[i];
			outPos.push(positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2]);
			outNor.push(nx, ny, nz);
			outFace.push(face);
		}
		outIdx[i] = j;
	}

	// Feature edges on the welded mesh: a crease between two triangles, or a border with only one.
	const edgeTris = new Map<number, number[]>();
	for (let t = 0; t < triCount; t++) {
		for (let e = 0; e < 3; e++) {
			const a = corner[t * 3 + e], b = corner[t * 3 + ((e + 1) % 3)];
			const k = Math.min(a, b) * vertexCount + Math.max(a, b);
			const list = edgeTris.get(k);
			if (list) list.push(t);
			else edgeTris.set(k, [t]);
		}
	}
	const edgePos: number[] = [];
	for (const [k, tris] of edgeTris) {
		if (tris.length === 2 && dot(tris[0], tris[1]) >= CREASE) continue;
		const a = Math.floor(k / vertexCount), b = k % vertexCount;
		edgePos.push(a, b);
	}
	// Edge vertices live in the same buffer as the surface: reuse the first split copy of each welded vertex.
	const firstCopy = new Int32Array(vertexCount).fill(-1);
	for (let i = 0; i < corner.length; i++) if (firstCopy[corner[i]] < 0) firstCopy[corner[i]] = outIdx[i];
	const edges = new Uint32Array(edgePos.map((v) => firstCopy[v]));

	return { positions: new Float32Array(outPos), normals: new Float32Array(outNor), indices: outIdx, edges, faces: Uint16Array.from(outFace) };
}
