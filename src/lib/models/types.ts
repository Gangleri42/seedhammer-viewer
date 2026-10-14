// The model manifest, static/models/index.json (schema v4), written by pipeline/build-all.ts and never committed.
// The newest three versions of each model are listed with their files' byte sizes and sha256 hashes: the hash is the
// name a Blossom server serves the file under, so the viewer can ask for a file by content wherever it runs.
// Schema v3 added the upstream boards (`board`, `slot`, `bare`). Schema v4 names a version by the hardware repository
// commit its STEP file came from (`id`, `date`) instead of a number, and `latest` is that id.

export type ModelFile = { path: string; bytes: number; sha256: string };

export type ModelVersion = {
	/** The short hash of the hardware repository commit the STEP file came from; links name the version by it. */
	id: string;
	/** That commit's date, UTC, YYYY-MM-DD. */
	date: string;
	/** The model as exported from CAD, board included ("as in CAD"). */
	glb: ModelFile;
	step: ModelFile;
	/** The exact geometry behind the GLB, for measuring (src/lib/measure/format.ts). Versions without it cannot be measured. */
	measure?: ModelFile;
	/** The same mesh without meshopt compression, for hosts that block WebAssembly. Optional. */
	plain?: ModelFile;
	triangles: number;
	bodies: number;
	/**
	 * Where an upstream board goes: the part id of the CAD board's sub-assembly, and a shift for exports whose board sits
	 * off KiCad's frame. Missing when the CAD board is in another frame; such a version shows only its CAD board.
	 */
	slot?: BoardSlot;
	/** The latest version only: the model without the CAD board's parts, to carry an upstream board. */
	bare?: { glb: ModelFile; measure?: ModelFile };
};

export type BoardSlot = { id: string; fix?: [number, number, number] };

/** One upstream revision of a model's board: a commit whose 3D export changed. */
export type BoardRevision = {
	/** A hash of the board's 3D inputs, stable across rebases and KiCad upgrades. */
	id: string;
	/** The first commit with this board, short hash, its committer date in UTC and its subject. */
	commit: string;
	date: string;
	subject: string;
	glb: ModelFile;
	measure: ModelFile;
	step: ModelFile;
	triangles: number;
	bodies: number;
	/** What the export changed on the way, in words (models from the repository's lib, closest stock models...). */
	fixups: string[];
	/** References of parts without a 3D model in any library. */
	missing: string[];
};

export type BoardTrack = {
	/** github.com/<repo>, branch <ref>, board file <file>. */
	source: { repo: string; ref: string; file: string };
	/** The branch head the build looked at (short hash): CI rebuilds when the branch moves past it. */
	head: string;
	latest: string | null;
	/** Set when the head's board could not be built; latest then stays at the last board that could. */
	failed?: { commit: string; reason: string };
	/** Newest first. */
	revisions: BoardRevision[];
};

/** `versions` newest first; `latest` is the newest one's id. */
export type ModelEntry = { title: string; latest: string; versions: ModelVersion[]; board?: BoardTrack };

export type ModelIndex = {
	version: 4;
	/** Blossom servers known to hold the files, most reliable first. Optional hints; hosts may know better. */
	servers?: string[];
	models: Record<string, ModelEntry>;
};
