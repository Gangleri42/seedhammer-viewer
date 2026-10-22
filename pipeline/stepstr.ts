// What this site's pipeline takes from stepstr, the submodule: its conversion, the catalogue's types and check, part ids
// and glTF I/O. Its modules load their packages from stepstr's own node_modules, so the conversion here is the one
// stepstr's builds name by ABOUT.conversion, and this repository depends on none of them itself.
import { createRequire } from 'node:module';

export { about } from '../stepstr/pipeline/about.ts';
export { convert, publishable, WASM, type Converted, type Summary } from '../stepstr/pipeline/convert.ts';
export { readConfig } from '../stepstr/pipeline/nostr/config.ts';
export { parseCatalogue } from '../stepstr/src/lib/catalogue/catalogue.ts';
export type { Blob, Catalogue, CatalogueVersion, CompanionRevision, CompanionTrack, Finish } from '../stepstr/src/lib/catalogue/catalogue.ts';
export type { MeasureData, SolidRecord } from '../stepstr/src/lib/measure/format.ts';
export { partId } from '../stepstr/src/lib/pipeline/ids.ts';
export { MemoryIO } from '../stepstr/src/lib/pipeline/memory-io.ts';

// The zip writer stepstr's own tools use; a zip made here opens wherever stepstr's do.
const stepstrRequire = createRequire(new URL('../stepstr/package.json', import.meta.url));
export const { zipSync } = stepstrRequire('fflate') as typeof import('../stepstr/node_modules/fflate/lib/index.js');
