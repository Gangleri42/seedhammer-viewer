// The model manifest, static/models/index.json (schema v2), written by pipeline/build-all.ts and never committed.
// Every version of every model is listed with its files' byte sizes and sha256 hashes: the hash is the name a
// Blossom server serves the file under, so the viewer can ask for a file by content wherever it runs.

export type ModelFile = { path: string; bytes: number; sha256: string };

export type ModelVersion = {
	version: number;
	glb: ModelFile;
	step: ModelFile;
	/** The same mesh without meshopt compression, for hosts that block WebAssembly. Optional. */
	plain?: ModelFile;
	triangles: number;
	bodies: number;
	built: string;
	/** The hardware repository commit the STEP came from. */
	commit?: string;
};

export type ModelEntry = { title: string; latest: number; versions: ModelVersion[] };

export type ModelIndex = {
	version: 2;
	/** Blossom servers known to hold the files, most reliable first. Optional hints; hosts may know better. */
	servers?: string[];
	models: Record<string, ModelEntry>;
};
