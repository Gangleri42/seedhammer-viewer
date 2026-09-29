// Turns the manifest + mesh export of export/step/step_to_manifest.py into the viewer's GLB.
//
// The GLB keeps the CAD occurrence tree. Geometry is in millimetres, Z up; the root node carries the glTF-conventional
// scale and rotation, which the viewer resets so its world frame equals the CAD frame.
import { readFileSync } from 'node:fs';
import { Document, NodeIO, Primitive, type Material, type Mesh, type Node, type TypedArray } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { creaseNormals, weld, type Geometry } from './geometry.ts';
import { partId } from './ids.ts';
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

export type BuildResult = { glb: Uint8Array; version: number; doc: string; bodies: number; trianglesIn: number; trianglesOut: number };

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

	/** The body's triangles per colour group, each welded, simplified and given crease normals. */
	function bodyGroups(idx: number): Group[] {
		const buf = readFileSync(`${src}/m_${String(idx).padStart(3, '0')}.bin`);
		const [nodes, tris] = new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 8));
		const raw = new Float32Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + 8 + nodes * 12));
		const indices = new Uint32Array(buf.buffer.slice(buf.byteOffset + 8 + nodes * 12, buf.byteOffset + 8 + nodes * 12 + tris * 12));
		const positions = scale === 1 ? raw : raw.map((v) => v * scale);
		stats.trianglesIn += tris;
		const entry = manifest.meshes[idx];
		const error = config.simplifyErrorByComponent?.[entry.component] ?? config.simplifyError;
		const layout = entry.groups ?? [[null, tris] as [string | null, number]];
		// Seams between colour groups stay locked so neighbouring groups keep meeting without cracks.
		const flags: ('ErrorAbsolute' | 'LockBorder')[] = layout.length > 1 ? ['ErrorAbsolute', 'LockBorder'] : ['ErrorAbsolute'];
		const groups: Group[] = [];
		let start = 0;
		for (const [appearance, count] of layout) {
			const part = indices.subarray(start * 3, (start + count) * 3);
			start += count;
			if (!count) continue;
			const welded = weld(positions, part);
			const [simplified] = MeshoptSimplifier.simplify(welded.indices, welded.positions, 3, 3, error, flags);
			if (simplified.length) groups.push({ appearance, geometry: creaseNormals(welded.positions, simplified) });
		}
		return groups;
	}

	const doc = new Document();
	doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
	const buffer = doc.createBuffer();
	const edgeMaterial = doc.createMaterial('edges').setBaseColorFactor([0, 0, 0, 1]).setExtras({ kind: 'edges' });
	const materials = new Map<string, Material>();
	const geometries = new Map<number, Group[]>();
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
		let groups = geometries.get(idx);
		if (!groups) geometries.set(idx, (groups = bodyGroups(idx)));
		if (!groups.length) return null;
		const finish = finishOf(idx);
		const mesh = doc.createMesh(manifest.meshes[idx].body);
		for (const { appearance: own, geometry } of groups) {
			// Faces in the body's own colour take the instance colour and the configured finish. With a metal finish, faces
			// with a colour of their own keep it (a chip's black body stays black); glass is one tint over the whole body.
			const material = !own || finish?.kind === 'glass' ? materialFor(appearance, finish) : materialFor(own);
			const position = accessor('VEC3', geometry.positions);
			mesh.addPrimitive(
				doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', accessor('VEC3', geometry.normals))
					.setIndices(accessor('SCALAR', geometry.indices)).setMaterial(material)
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
	for (const occ of manifest.occurrences) {
		const w = toColumnMajor(occ.matrix, scale);
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
		nodes.get(body.occ)!.addChild(doc.createNode(body.body).setMesh(mesh).setExtras({ id: partId(path), name: body.body, body: true }));
		stats.bodies++;
	}
	for (const groups of geometries.values()) for (const g of groups) stats.trianglesOut += g.geometry.indices.length / 3;

	await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16 }));
	const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
	const glb = await io.writeBinary(doc);

	// Nothing private may ship in the GLB's JSON (names, extras); the binary chunk is geometry.
	const jsonLength = new DataView(glb.buffer, glb.byteOffset + 12, 4).getUint32(0, true);
	assertPublic('GLB JSON', new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));

	return { glb, version: manifest.version, doc: manifest.doc, bodies: stats.bodies, trianglesIn: stats.trianglesIn, trianglesOut: stats.trianglesOut };
}
