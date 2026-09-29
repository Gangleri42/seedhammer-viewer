// The rendered triangles of a B-rep face, found through the _FACEID vertex attribute. The BVH reorders a geometry's
// index buffer when it is built, so triangles are grouped by face afterwards, once per geometry; instances share it.
import * as THREE from 'three';

const byGeometry = new WeakMap<THREE.BufferGeometry, Map<number, number[]>>();

/** Each face's triangles (their positions in the index buffer), or null for a geometry without face ids. */
export function trianglesByFace(geometry: THREE.BufferGeometry): Map<number, number[]> | null {
	const cached = byGeometry.get(geometry);
	if (cached) return cached;
	const ids = geometry.getAttribute('_faceid');
	const index = geometry.getIndex();
	if (!ids || !index) return null;
	const map = new Map<number, number[]>();
	for (let t = 0; t < index.count / 3; t++) {
		const face = ids.getX(index.getX(t * 3));
		let list = map.get(face);
		if (!list) map.set(face, (list = []));
		list.push(t);
	}
	byGeometry.set(geometry, map);
	return map;
}

/** The face a vertex belongs to, or null without face ids. */
export function faceOf(mesh: THREE.Mesh, vertex: number): number | null {
	const ids = mesh.geometry.getAttribute('_faceid');
	return ids ? ids.getX(vertex) : null;
}

/**
 * A face's triangles as a geometry of its own, in the mesh's space: a highlight made a child of the mesh follows its
 * placement, visibility and cuts. It owns its buffers, since disposing a geometry that shares the model's attributes
 * would delete them on the GPU and the body would vanish.
 */
export function faceGeometry(mesh: THREE.Mesh, face: number): THREE.BufferGeometry | null {
	const triangles = trianglesByFace(mesh.geometry)?.get(face);
	if (!triangles) return null;
	const position = mesh.geometry.getAttribute('position');
	const index = mesh.geometry.getIndex()!;
	const out = new Float32Array(triangles.length * 9);
	triangles.forEach((t, i) => {
		for (let k = 0; k < 3; k++) {
			const v = index.getX(t * 3 + k);
			out.set([position.getX(v), position.getY(v), position.getZ(v)], i * 9 + k * 3);
		}
	});
	return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(out, 3));
}

/** A face's triangles in world space, nine numbers per triangle. */
export function faceSoup(mesh: THREE.Mesh, face: number): Float32Array {
	const geometry = faceGeometry(mesh, face);
	if (!geometry) return new Float32Array();
	mesh.updateWorldMatrix(true, false);
	geometry.applyMatrix4(mesh.matrixWorld);
	const soup = geometry.getAttribute('position').array as Float32Array;
	geometry.dispose();
	return soup;
}
