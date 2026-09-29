// The measurement file, static/models/<model>/v<n>.measure.json.gz: the exact geometry behind one GLB, written by
// pipeline/measure.ts and read by the Measure tool. Everything is per solid, in the solid's own frame and in
// millimetres; a body node's `solid` extra names its solid, and the body's parent node carries its world matrix.
// Face ids are the GLB's _FACEID vertex attribute; edges and vertices are numbered the way OpenCascade maps them.

export const MEASURE_VERSION = 1;

/** The first entry of an edge or face record. */
export const EDGE = { line: 0, arc: 1, curve: 2 } as const;
export const FACE = { plane: 0, cylinder: 1, cone: 2, sphere: 3, torus: 4, other: 5 } as const;

/** A line from vertex a to vertex b. */
export type LineRecord = [kind: 0, a: number, b: number];
/**
 * An arc that starts at centre + radius·ref (vertex a) and turns counterclockwise about the normal by sweep, in
 * (0, 2π], to vertex b. A full circle has a = b and sweep = 2π.
 */
export type ArcRecord = [
	kind: 1, a: number, b: number,
	cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, rx: number, ry: number, rz: number,
	radius: number, sweep: number
];
/** Any other curve: its exact length, the point halfway along it, and a polyline through it (x, y, z, ...). */
export type CurveRecord = [kind: 2, a: number, b: number, length: number, mx: number, my: number, mz: number, polyline: number[]];
/** null is a seam or a degenerated edge, which cannot be picked. A vertex id is -1 where the edge has no vertex. */
export type EdgeRecord = LineRecord | ArcRecord | CurveRecord | null;

/**
 * A face: kind, exact area, loops of edge ids (outer loop first, seams left out), then its surface:
 * - plane: nx, ny, nz, d (outward normal, n·p = d)
 * - cylinder: px, py, pz, ax, ay, az, length, radius, s (the axis runs from p along a for length)
 * - cone: apex x, y, z, axis x, y, z (pointing into the face), half-angle, s
 * - sphere: cx, cy, cz, radius, s
 * - torus: cx, cy, cz, ax, ay, az, major, minor, s
 * - other: nothing
 * s is +1 where the material lies inside the surface (a boss), -1 where it lies outside (a hole).
 */
export type FaceRecord = [kind: number, area: number, loops: number[][], ...surface: number[]];

export type SolidRecord = {
	/** How far the rendered triangles may lie from the exact faces, measured both ways, mm. */
	tol: number;
	/** Vertex positions: x, y, z per vertex. */
	p: number[];
	e: EdgeRecord[];
	f: FaceRecord[];
};

export type MeasureFile = {
	v: typeof MEASURE_VERSION;
	units: 'mm';
	/** sha256 of the GLB this file belongs to. */
	glb: string;
	/** By the GLB's `solid` extra; null for a solid with no triangles. */
	solids: (SolidRecord | null)[];
};

const isGzip = (bytes: Uint8Array) => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Parses a measurement file: gzipped as published, or already inflated by a server that sent it compressed. */
export async function readMeasure(buffer: ArrayBuffer): Promise<MeasureFile> {
	const bytes = new Uint8Array(buffer);
	const text = isGzip(bytes)
		? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
		: new TextDecoder().decode(bytes);
	const data = JSON.parse(text) as MeasureFile;
	if (data?.v !== MEASURE_VERSION || data.units !== 'mm' || !Array.isArray(data.solids)) {
		throw new Error('not a measurement file this viewer can read');
	}
	return data;
}
