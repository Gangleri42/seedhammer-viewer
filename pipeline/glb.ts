// The parts of a GLB the converter made, read from its JSON chunk alone: the occurrence tree with each node's
// extras and placement. The geometry stays compressed; the measurement data has it exactly.
type Node = {
	name?: string;
	children?: number[];
	matrix?: number[];
	translation?: [number, number, number];
	rotation?: [number, number, number, number];
	scale?: [number, number, number];
	mesh?: number;
	extras?: { id?: string; name?: string; component?: string; body?: boolean; solid?: number; ownFlagged?: boolean };
};
export type Gltf = {
	scene?: number;
	scenes: { nodes: number[] }[];
	nodes: Node[];
	meshes?: { primitives: { material?: number; mode?: number; extras?: { own?: boolean } }[] }[];
	materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number }; extras?: { appearance?: string | null; kind?: string } }[];
};

/** A column-major 4×4 matrix, as glTF stores one. */
export type Mat = number[];

export type Part = {
	id: string;
	name: string;
	/** Occurrences only: the component it is an instance of. */
	component?: string;
	body: boolean;
	/** Bodies only: the solid's index in the measurement data. */
	solid?: number;
	/** Bodies only: the glTF mesh. */
	mesh?: number;
	parent: Part | null;
	/** Placement in the model's own frame, mm (the root's glTF scale and rotation left out). */
	world: Mat;
};

export function gltfJson(glb: Uint8Array): Gltf {
	const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('not a GLB with a JSON chunk');
	return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
}

export const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat, b: Mat): Mat {
	const out = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
	return out;
}

/** The inverse of a rotation plus a translation: the transpose, and the translation turned back. */
export function invertRigid(m: Mat): Mat {
	const out = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
	for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
	return out;
}

function local(node: Node): Mat {
	if (node.matrix) return node.matrix;
	const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
	const [sx, sy, sz] = node.scale ?? [1, 1, 1];
	const [tx, ty, tz] = node.translation ?? [0, 0, 0];
	return [
		(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
		2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
		2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
		tx, ty, tz, 1
	];
}

/**
 * Whether the GLB marks the triangles in each body's own colour (`own` on the primitive): its root says so. stepstr's
 * converter does since its own-colour marks; in an older file the first group of a body is its own colour, if any.
 */
export const ownFlagged = (gltf: Gltf) => gltf.scenes[gltf.scene ?? 0].nodes.some((root) => gltf.nodes[root].extras?.ownFlagged === true);

/** Every part, parents before children, below the root node the converter names after the file. */
export function partsOf(gltf: Gltf): Part[] {
	const parts: Part[] = [];
	const visit = (index: number, parent: Part | null, frame: Mat) => {
		const node = gltf.nodes[index];
		const extras = node.extras ?? {};
		const world = multiply(frame, local(node));
		const part: Part = {
			id: extras.id ?? '',
			name: extras.name ?? node.name ?? '',
			...(extras.component === undefined ? {} : { component: extras.component }),
			body: !!extras.body,
			...(extras.solid === undefined ? {} : { solid: extras.solid }),
			...(node.mesh === undefined ? {} : { mesh: node.mesh }),
			parent,
			world
		};
		parts.push(part);
		for (const child of node.children ?? []) visit(child, part, world);
	};
	for (const root of gltf.scenes[gltf.scene ?? 0].nodes) for (const child of gltf.nodes[root].children ?? []) visit(child, null, IDENTITY);
	return parts;
}
