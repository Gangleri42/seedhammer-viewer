// static/models/index.json (schema v3, see src/lib/models/types.ts): build-all.ts writes it from scratch on every
// run, with each file's byte size and sha256, the name Blossom serves the file under.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import models from './models.json' with { type: 'json' };
import type { ModelFile, ModelIndex } from '../src/lib/models/types.ts';

export const INDEX_PATH = 'static/models/index.json';
export const MODELS_DIR = 'static/models';

export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** Size and hash of a file below static/models, named by its manifest path. */
export function fileEntry(path: string, dir = MODELS_DIR): ModelFile {
	const data = readFileSync(`${dir}/${path}`);
	return { path, bytes: data.byteLength, sha256: sha256(data) };
}

/** Models in the order of models.json (the first is listed first in the viewer). Keys it does not know are dropped. */
export function serialize(index: ModelIndex, order: string[] = Object.keys(models)) {
	const ordered: ModelIndex = { version: 3, models: {} };
	if (index.servers?.length) ordered.servers = index.servers;
	for (const key of order) if (index.models[key]) ordered.models[key] = index.models[key];
	return JSON.stringify(ordered, null, '\t') + '\n';
}

export function writeIndex(index: ModelIndex, file = INDEX_PATH) {
	writeFileSync(file, serialize(index));
}
