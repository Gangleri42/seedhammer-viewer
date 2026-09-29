// Short part ids for share links: a hash of the part's path in the assembly ("frame:1+side_plates:1/body").
// The same path gives the same id in every version and every build, with no registry to keep in sync, so an old link
// finds its part as long as the part keeps its place and name. Six base-36 characters make a clash between two parts
// of one model vanishingly rare.
import { createHash } from 'node:crypto';

export function partId(path: string): string {
	const n = createHash('sha256').update(path).digest().readUIntBE(0, 6);
	return (n % 36 ** 6).toString(36).padStart(6, '0');
}
