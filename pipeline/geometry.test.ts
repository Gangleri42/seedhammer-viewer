import { Document } from '@gltf-transform/core';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { compression } from './build-model.ts';
import { creaseNormals, splitByFace, weld } from './geometry.ts';

/** A flat n × n grid over [0, 10]² at z = 0: face 0 left of x = 5, face 1 right of it. */
function grid(n: number) {
	const positions: number[] = [], indices: number[] = [], faces: number[] = [];
	for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push((10 * i) / n, (10 * j) / n, 0);
	for (let j = 0; j < n; j++) {
		for (let i = 0; i < n; i++) {
			const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
			const face = i < n / 2 ? 0 : 1;
			indices.push(a, b, d, a, d, c);
			faces.push(face, face);
		}
	}
	return { positions: new Float32Array(positions), indices: new Uint32Array(indices), faces: new Uint32Array(faces) };
}

/** Whether every triangle's corners carry one face id, and which ids occur. */
function faceCheck(indices: ArrayLike<number>, faces: ArrayLike<number>) {
	const seen = new Set<number>();
	let mixed = 0;
	for (let i = 0; i < indices.length; i += 3) {
		const f = faces[indices[i]];
		if (faces[indices[i + 1]] !== f || faces[indices[i + 2]] !== f) mixed++;
		seen.add(f);
	}
	return { mixed, faces: [...seen].sort() };
}

beforeAll(async () => {
	await MeshoptSimplifier.ready;
	await MeshoptEncoder.ready;
});

describe('face ids through the pipeline', () => {
	it('gives a border vertex one copy per face and shares no vertex between faces', () => {
		const { positions, indices, faces } = grid(4);
		const split = splitByFace(positions, indices, faces);
		// 25 grid points, the 5 on x = 5 twice.
		expect(split.positions.length / 3).toBe(30);
		expect(faceCheck(split.indices, split.faces)).toEqual({ mixed: 0, faces: [0, 1] });
		for (let i = 0; i < split.indices.length; i++) expect(split.faces[split.indices[i]]).toBe(faces[(i / 3) | 0]);
	});

	it('keeps the simplifier from merging two faces, even at a coarse error', () => {
		const { positions, indices, faces } = grid(20);
		const welded = weld(positions, indices);
		const split = splitByFace(welded.positions, welded.indices, faces);
		const [simplified] = MeshoptSimplifier.simplify(split.indices, split.positions, 3, 3, 1, ['ErrorAbsolute']);
		expect(simplified.length).toBeLessThan(split.indices.length);
		expect(faceCheck(simplified, split.faces)).toEqual({ mixed: 0, faces: [0, 1] });
	});

	it('shades and draws a smooth border between faces like the inside of a face', () => {
		const { positions, indices, faces } = grid(4);
		const split = splitByFace(positions, indices, faces);
		const geometry = creaseNormals(split.positions, split.indices, split.faces);
		for (let i = 0; i < geometry.normals.length; i += 3) expect([...geometry.normals.subarray(i, i + 3)]).toEqual([0, 0, 1]);
		expect(faceCheck(geometry.indices, geometry.faces).mixed).toBe(0);
		// Edges run along the outer border only: 16 segments, none of them on x = 5 between y = 0 and 10.
		expect(geometry.edges.length / 2).toBe(16);
		for (let e = 0; e < geometry.edges.length; e += 2) {
			const [a, b] = [geometry.edges[e], geometry.edges[e + 1]];
			const onInnerLine = geometry.positions[a * 3] === 5 && geometry.positions[b * 3] === 5 && geometry.positions[a * 3 + 1] % 10 !== 0;
			expect(onInnerLine).toBe(false);
		}
	});

	it('draws the crease between two faces at a right angle', () => {
		// A floor (face 0) and a wall (face 1) that meet along the y axis.
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1]);
		const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4]);
		const split = splitByFace(positions, indices, new Uint32Array([0, 0, 1, 1]));
		const geometry = creaseNormals(split.positions, split.indices, split.faces);
		const edges = new Set<string>();
		for (let e = 0; e < geometry.edges.length; e += 2) {
			const ends = [geometry.edges[e], geometry.edges[e + 1]].map((v) => [...geometry.positions.subarray(v * 3, v * 3 + 3)].join(','));
			edges.add(ends.sort().join(' '));
		}
		expect(edges.has('0,0,0 0,1,0')).toBe(true);
	});

	it('leaves _FACEID an integer attribute when a mesh only has faces 0 and 1', async () => {
		const doc = new Document();
		const buffer = doc.createBuffer();
		const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])).setBuffer(buffer);
		const faceIds = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 0, 1, 1])).setBuffer(buffer);
		const primitive = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('_FACEID', faceIds)
			.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2, 1, 3, 2])).setBuffer(buffer));
		doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
		await doc.transform(...compression());
		const out = primitive.getAttribute('_FACEID')!;
		expect(out.getArray()).toBeInstanceOf(Uint16Array);
		expect(out.getNormalized()).toBe(false);
		expect([...out.getArray()!].sort()).toEqual([0, 0, 1, 1]);
		expect(primitive.getAttribute('POSITION')!.getNormalized()).toBe(true);
	});
});
