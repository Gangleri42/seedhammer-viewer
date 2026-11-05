// The parts of a GLB the converter made, read from its JSON chunk alone: the occurrence tree with each node's
// extras. The geometry stays compressed.
type Node = {
	name?: string;
	children?: number[];
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
};

export function gltfJson(glb: Uint8Array): Gltf {
	const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('not a GLB with a JSON chunk');
	return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
}

/**
 * Whether the GLB marks the triangles in each body's own colour (`own` on the primitive): its root says so. stepstr's
 * converter does since its own-colour marks; in an older file the first group of a body is its own colour, if any.
 */
export const ownFlagged = (gltf: Gltf) => gltf.scenes[gltf.scene ?? 0].nodes.some((root) => gltf.nodes[root].extras?.ownFlagged === true);

/** Every part, parents before children, below the root node the converter names after the file. */
export function partsOf(gltf: Gltf): Part[] {
	const parts: Part[] = [];
	const visit = (index: number, parent: Part | null) => {
		const node = gltf.nodes[index];
		const extras = node.extras ?? {};
		const part: Part = {
			id: extras.id ?? '',
			name: extras.name ?? node.name ?? '',
			...(extras.component === undefined ? {} : { component: extras.component }),
			body: !!extras.body,
			...(extras.solid === undefined ? {} : { solid: extras.solid }),
			...(node.mesh === undefined ? {} : { mesh: node.mesh }),
			parent
		};
		parts.push(part);
		for (const child of node.children ?? []) visit(child, part);
	};
	for (const root of gltf.scenes[gltf.scene ?? 0].nodes) for (const child of gltf.nodes[root].children ?? []) visit(child, null);
	return parts;
}
