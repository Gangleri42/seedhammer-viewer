// Turns the manifest + mesh export of export/step/step_to_manifest.py into the viewer's GLB.
//
// The GLB keeps the CAD occurrence tree. Geometry is in millimetres, Z up; the root node carries the glTF-conventional
// scale and rotation, which the viewer resets so its world frame equals the CAD frame.
import { readFileSync } from 'node:fs';
import { Document, NodeIO, Primitive, type Material, type Mesh, type Node, type TypedArray } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { creaseNormals, splitByFace, weld, type Geometry } from './geometry.ts';
import { partId } from './ids.ts';
import { sha256 } from './manifest.ts';
import { buildMeasure, type MeasureStats, type RawMeasure, type SolidMesh } from './measure.ts';
import { assertPublic } from './privacy.ts';

type Manifest = {
	doc: string;
	version: number;
	units?: 'mm' | 'cm';
	occurrences: { path: string; parent: string | null; name: string; component: string; linked: boolean; matrix: number[] }[];
	bodies: { occ: string | null; body: string; mesh: number; appearance: string | null }[];
	/** groups: [appearance, triangle count] in file order; appearance null means the body instance's colour. */
	meshes: { component: string; body: string; groups?: [string | null, number][] }[];
	appearances: Record<string, [string, string, unknown][]>;
	fastener_partners: Record<string, string>;
};
export type ModelConfig = {
	title: string;
	folder: string;
	/** Largest deviation the simplifier may introduce, mm. */
	simplifyError: number;
	/** Looser tolerances for dense parts that are mostly hidden (wire coils, springs). */
	simplifyErrorByComponent?: Record<string, number>;
	/**
	 * STEP carries colours, not materials. Each entry makes the listed bodies (by body name, or component name for all
	 * its bodies) metal or glass. Metal applies to faces in the body's own colour only, so faces with a colour of their
	 * own keep it; glass applies to the whole body. `appearance` names the Fusion appearance the entry came from.
	 */
	materials?: { appearance: string; kind: 'metal' | 'glass'; roughness?: number; parts: string[] }[];
};
type Finish = { kind: 'metal' | 'glass'; roughness?: number };
type Group = { appearance: string | null; geometry: Geometry };
type Solid = { groups: Group[]; mesh: SolidMesh };

const FASTENER = /\b(ISO|DIN)\s?\d|schraube|mutter|screw|\bnut\b|washer|scheibe|\bM\d+(\.\d+)?x\d+/i;
const srgbToLinear = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

type Mat4 = number[];
/** A row-major CAD matrix as a glTF column-major matrix, translation scaled to mm. */
function toColumnMajor(m: number[], scale: number): Mat4 {
	const out = new Array(16);
	for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c];
	out[12] *= scale;
	out[13] *= scale;
	out[14] *= scale;
	return out;
}
function invertRigid(m: Mat4): Mat4 {
	// Occurrence transforms are rotations plus translations: the inverse is the transpose plus a rotated translation.
	const out = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
	for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
	return out;
}
function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
	return out;
}
/** +1 for a rotation, -1 for a mirror; throws on anything that scales or shears, which would change measured lengths. */
function handedness(m: Mat4, what: string) {
	const col = (c: number) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
	const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			if (Math.abs(dot(col(i), col(j)) - (i === j ? 1 : 0)) > 1e-6) throw new Error(`${what}: its placement scales or shears`);
		}
	}
	const [x, y, z] = [col(0), col(1), col(2)];
	return Math.sign(x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0]));
}
/** The vertices the triangles use, renumbered from 0, with their face ids. */
function compact(positions: Float32Array, indices: number[], faces: Uint16Array) {
	const remap = new Map<number, number>();
	const out: number[] = [];
	const outFaces: number[] = [];
	const outIndices = new Uint32Array(indices.length);
	indices.forEach((v, i) => {
		let j = remap.get(v);
		if (j === undefined) {
			remap.set(v, (j = outFaces.length));
			out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
			outFaces.push(faces[v]);
		}
		outIndices[i] = j;
	});
	return { positions: new Float32Array(out), indices: outIndices, faces: Uint16Array.from(outFaces) };
}

/**
 * What meshopt({ level: 'medium', quantizePosition: 16 }) does, except that its quantize pattern would also turn
 * _FACEID into normalized values wherever a solid's face ids all fit in [-1, 1].
 */
export function compression() {
	return [reorder({ encoder: MeshoptEncoder, target: 'size' }), quantize({ quantizePosition: 16, pattern: /^(?!_FACEID$)/, patternTargets: /.*/ })];
}

export type BuildResult = {
	glb: Uint8Array;
	/** The gzipped measurement file (src/lib/measure/format.ts). */
	measure: Uint8Array;
	version: number;
	doc: string;
	bodies: number;
	trianglesIn: number;
	trianglesOut: number;
	measureStats: MeasureStats & { json: number; mirrored: number };
};

/** Builds the GLB for the export in `src`. Throws if the result would carry private data. */
export async function buildModel(src: string, config: ModelConfig): Promise<BuildResult> {
	await MeshoptSimplifier.ready;
	await MeshoptEncoder.ready;
	const manifest: Manifest = JSON.parse(readFileSync(`${src}/manifest.json`, 'utf8'));
	const scale = manifest.units === 'mm' ? 1 : 10;
	const stats = { trianglesIn: 0, trianglesOut: 0, bodies: 0 };

	const finishes = new Map<string, Finish>();
	for (const entry of config.materials ?? []) for (const part of entry.parts) finishes.set(part, entry);
	const finishOf = (idx: number) => finishes.get(manifest.meshes[idx].body) ?? finishes.get(manifest.meshes[idx].component);

	/**
	 * The solid's triangles: welded, split per B-rep face and simplified once, then cut into its colour groups and given
	 * crease normals. Face borders are seams to the simplifier, so every triangle stays on one face and neighbouring
	 * faces (and colours) keep meeting without cracks.
	 */
	function solidOf(idx: number): Solid {
		const buf = readFileSync(`${src}/m_${String(idx).padStart(3, '0')}.bin`);
		let at = buf.byteOffset;
		const take = (bytes: number) => buf.buffer.slice(at, (at += bytes));
		const [nodes, tris] = new Uint32Array(take(8));
		const raw = new Float32Array(take(nodes * 12));
		const indices = new Uint32Array(take(tris * 12));
		const triangleFaces = new Uint32Array(take(tris * 4));
		const positions = scale === 1 ? raw : raw.map((v) => v * scale);
		stats.trianglesIn += tris;
		const entry = manifest.meshes[idx];
		const error = config.simplifyErrorByComponent?.[entry.component] ?? config.simplifyError;
		const layout = entry.groups ?? [[null, tris] as [string | null, number]];

		// Faces carry their colour, so each face belongs to one colour group.
		const groupOf = new Map<number, number>();
		let start = 0;
		layout.forEach(([, count], g) => {
			for (let t = start; t < start + count; t++) groupOf.set(triangleFaces[t], g);
			start += count;
		});

		const welded = weld(positions, indices);
		const split = splitByFace(welded.positions, welded.indices, triangleFaces);
		// Never 'Permissive': that is the one mode that may collapse a vertex across a seam onto another face.
		const [simplified] = MeshoptSimplifier.simplify(split.indices, split.positions, 3, 3, error, ['ErrorAbsolute']);
		for (let i = 0; i < simplified.length; i += 3) {
			const face = split.faces[simplified[i]];
			if (split.faces[simplified[i + 1]] !== face || split.faces[simplified[i + 2]] !== face) {
				throw new Error(`${entry.body}: a simplified triangle spans two faces`);
			}
		}
		const groups: Group[] = [];
		layout.forEach(([appearance], g) => {
			const picked: number[] = [];
			for (let i = 0; i < simplified.length; i += 3) {
				if (groupOf.get(split.faces[simplified[i]]) === g) picked.push(simplified[i], simplified[i + 1], simplified[i + 2]);
			}
			if (!picked.length) return;
			const part = compact(split.positions, picked, split.faces);
			groups.push({ appearance, geometry: creaseNormals(part.positions, part.indices, part.faces) });
		});
		const original = { positions, indices, faces: triangleFaces };
		return { groups, mesh: { positions: split.positions, indices: simplified, faces: split.faces, original, error } };
	}

	const doc = new Document();
	doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
	const buffer = doc.createBuffer();
	const edgeMaterial = doc.createMaterial('edges').setBaseColorFactor([0, 0, 0, 1]).setExtras({ kind: 'edges' });
	const materials = new Map<string, Material>();
	const geometries = new Map<number, Solid>();
	const meshes = new Map<string, Mesh>();

	function makeMaterial(name: string | null, finish?: Finish): Material {
		const props = new Map((name ? manifest.appearances[name] : []).map(([id, , value]) => [id, value]));
		const model = props.get('interior_model') as number | undefined;
		const colorOf = (id: string): [number, number, number] | null => {
			const c = props.get(id) as number[] | undefined;
			return c ? [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])] : null;
		};
		const color = colorOf('metal_f0') ?? colorOf('transparent_color') ?? colorOf('opaque_albedo') ?? [0.5, 0.5, 0.5];
		const kind = finish?.kind ?? (model === 1 ? 'metal' : model === 3 ? 'glass' : 'opaque');
		const roughness = finish?.roughness ?? (props.get('surface_roughness') as number | undefined) ?? 0.5;
		const material = doc.createMaterial(finish ? `${name ?? 'default'} ${kind}` : (name ?? 'default'))
			.setRoughnessFactor(Math.max(roughness, 0.05)).setDoubleSided(false);
		if (kind === 'metal') material.setMetallicFactor(1).setBaseColorFactor([...color, 1]);
		else if (kind === 'glass') {
			// Clear glass nearly vanishes, tinted glass stays dark: opacity follows how dark the tint is.
			const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
			material.setMetallicFactor(0).setBaseColorFactor([...color, 0.1 + 0.6 * (1 - luminance)]).setAlphaMode('BLEND');
		}
		else material.setMetallicFactor(0).setBaseColorFactor([...color, 1]);
		material.setExtras({ appearance: name, kind });
		return material;
	}

	function materialFor(name: string | null, finish?: Finish) {
		const key = `${name}|${finish?.kind ?? ''}|${finish?.roughness ?? ''}`;
		let material = materials.get(key);
		if (!material) materials.set(key, (material = makeMaterial(name, finish)));
		return material;
	}

	const accessor = (type: 'VEC3' | 'SCALAR', array: Float32Array | Uint32Array) =>
		doc.createAccessor().setType(type).setArray(array as TypedArray).setBuffer(buffer);

	function meshFor(idx: number, appearance: string | null): Mesh | null {
		const key = `${idx}|${appearance}`;
		if (meshes.has(key)) return meshes.get(key)!;
		let solid = geometries.get(idx);
		if (!solid) geometries.set(idx, (solid = solidOf(idx)));
		if (!solid.groups.length) return null;
		const finish = finishOf(idx);
		const mesh = doc.createMesh(manifest.meshes[idx].body);
		for (const { appearance: own, geometry } of solid.groups) {
			// Faces in the body's own colour take the instance colour and the configured finish. With a metal finish, faces
			// with a colour of their own keep it (a chip's black body stays black); glass is one tint over the whole body.
			const material = !own || finish?.kind === 'glass' ? materialFor(appearance, finish) : materialFor(own);
			const position = accessor('VEC3', geometry.positions);
			// The B-rep face of each vertex, for the Measure tool: an integer, so quantization must leave it alone.
			const faceIds = doc.createAccessor().setType('SCALAR').setArray(geometry.faces).setBuffer(buffer);
			mesh.addPrimitive(
				doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', accessor('VEC3', geometry.normals))
					.setAttribute('_FACEID', faceIds).setIndices(accessor('SCALAR', geometry.indices)).setMaterial(material)
			);
			if (geometry.edges.length) {
				mesh.addPrimitive(
					doc.createPrimitive().setMode(Primitive.Mode.LINES).setAttribute('POSITION', position)
						.setIndices(accessor('SCALAR', geometry.edges)).setMaterial(edgeMaterial)
				);
			}
		}
		meshes.set(key, mesh);
		return mesh;
	}

	const root = doc.createNode(config.title)
		.setScale([0.001, 0.001, 0.001])
		.setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2])
		.setExtras({ doc: manifest.doc, version: manifest.version, units: 'mm', up: 'z' });
	doc.createScene(config.title).addChild(root);

	const nodes = new Map<string | null, Node>([[null, root]]);
	const world = new Map<string, Mat4>();
	let mirrored = 0;
	for (const occ of manifest.occurrences) {
		const w = toColumnMajor(occ.matrix, scale);
		if (handedness(w, occ.path) < 0) mirrored++;
		world.set(occ.path, w);
		const local = occ.parent ? multiply(invertRigid(world.get(occ.parent)!), w) : w;
		const fastener = occ.path in manifest.fastener_partners || FASTENER.test(occ.component);
		const node = doc.createNode(occ.name).setMatrix(local as never).setExtras({
			id: partId(occ.path), name: occ.name, component: occ.component, linked: occ.linked, fastener
		});
		nodes.get(occ.parent)!.addChild(node);
		nodes.set(occ.path, node);
	}
	for (const body of manifest.bodies) {
		const mesh = meshFor(body.mesh, body.appearance);
		if (!mesh) continue;
		const path = `${body.occ ?? ''}/${body.body}`;
		// `solid` names the body's entry in the measurement file.
		const extras = { id: partId(path), name: body.body, body: true, solid: body.mesh };
		nodes.get(body.occ)!.addChild(doc.createNode(body.body).setMesh(mesh).setExtras(extras));
		stats.bodies++;
	}
	for (const solid of geometries.values()) for (const g of solid.groups) stats.trianglesOut += g.geometry.indices.length / 3;

	await doc.transform(...compression());
	const io = new NodeIO()
		.registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
		.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
	const glb = await io.writeBinary(doc);

	// Nothing private may ship in the GLB's JSON (names, extras); the binary chunk is geometry.
	const jsonLength = new DataView(glb.buffer, glb.byteOffset + 12, 4).getUint32(0, true);
	assertPublic('GLB JSON', new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));

	const raw: RawMeasure = JSON.parse(readFileSync(`${src}/measure.json`, 'utf8'));
	const solids = raw.solids.map((_, idx) => {
		const solid = geometries.get(idx);
		return solid?.groups.length ? solid.mesh : null;
	});
	const measure = buildMeasure(raw, solids, sha256(glb));

	return {
		glb,
		measure: measure.bytes,
		version: manifest.version,
		doc: manifest.doc,
		bodies: stats.bodies,
		trianglesIn: stats.trianglesIn,
		trianglesOut: stats.trianglesOut,
		measureStats: { ...measure.stats, json: measure.json, mirrored }
	};
}
