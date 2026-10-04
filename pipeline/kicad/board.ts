// A KiCad board file (.kicad_pcb) read and edited as text. The pipeline needs little of it: footprints with their
// references, positions and 3D models, the extent of the Edge.Cuts outline, and what the 3D export depends on. Edits
// replace single blocks, so everything else stays byte for byte.

export type Span = { start: number; end: number };
export type Model = Span & { path: string; hidden: boolean };
export type Footprint = Span & { ref: string; x: number; y: number; angle: number; models: Model[] };
type Box = [number, number, number, number];

/** Index just past the block that opens at `start`, skipping parentheses inside strings. */
export function blockEnd(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
		} else if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return i + 1;
	}
	throw new Error(`unbalanced block at offset ${start}`);
}

const headOf = (text: string, start: number) => /^\(([^\s()"]+)/.exec(text.slice(start, start + 64))?.[1] ?? '';

/** The blocks directly inside `parent`, optionally only those whose head is `head`. */
export function children(text: string, parent: Span, head?: string): Span[] {
	const found: Span[] = [];
	for (let i = parent.start + 1; i < parent.end - 1; i++) {
		const c = text[i];
		if (c === '"') {
			for (i++; i < parent.end && text[i] !== '"'; i++) if (text[i] === '\\') i++;
		} else if (c === '(') {
			const end = blockEnd(text, i);
			if (!head || headOf(text, i) === head) found.push({ start: i, end });
			i = end - 1;
		}
	}
	return found;
}

/** The board itself: the (kicad_pcb ...) block. */
export function root(text: string): Span {
	const start = text.indexOf('(kicad_pcb');
	if (start < 0) throw new Error('not a KiCad board file');
	return { start, end: blockEnd(text, start) };
}

const unquote = (s: string) => s.replace(/\\(.)/g, '$1');

export function footprints(text: string): Footprint[] {
	return children(text, root(text), 'footprint').map((span) => {
		const block = text.slice(span.start, span.end);
		// KiCad 8 and later keep the reference as a property; older files as fp_text.
		const ref = /\(property "Reference" "((?:[^"\\]|\\.)*)"/.exec(block)?.[1] ?? /\(fp_text reference "((?:[^"\\]|\\.)*)"/.exec(block)?.[1] ?? '';
		const at = children(text, span, 'at')[0];
		const [x, y, angle = 0] = at ? text.slice(at.start, at.end).slice(3, -1).trim().split(/\s+/).map(Number) : [NaN, NaN];
		const models = children(text, span, 'model').map((m): Model => {
			const own = text.slice(m.start, m.end);
			const hidden = children(text, m, 'hide').some((h) => /\(hide\s+yes\)/.test(text.slice(h.start, h.end))) || /^\(model\s+"(?:[^"\\]|\\.)*"\s+hide\b/.test(own);
			return { ...m, path: unquote(/^\(model\s+"((?:[^"\\]|\\.)*)"/.exec(own)?.[1] ?? ''), hidden };
		});
		return { ...span, ref: unquote(ref), x, y, angle, models };
	});
}

const POINT = /\((?:start|end|mid|center|xy)\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g;

/**
 * Where a footprint reaches on the board: its courtyard, else its other graphics and pads, else its origin, turned
 * and moved by the footprint's own (at x y angle). KiCad's y points down and its angles turn counter-clockwise on
 * screen.
 */
export function footprintBox(text: string, fp: Footprint): Box | null {
	const local: [number, number][] = [];
	const graphics = children(text, fp).filter((s) => /^\(fp_/.test(text.slice(s.start, s.start + 4)));
	const courtyard = graphics.filter((s) => /\(layer\s+"[FB]\.CrtYd"\)/.test(text.slice(s.start, s.end)));
	for (const span of courtyard.length ? courtyard : graphics) {
		for (const m of text.slice(span.start, span.end).matchAll(POINT)) local.push([Number(m[1]), Number(m[2])]);
	}
	if (!courtyard.length) {
		for (const pad of children(text, fp, 'pad')) {
			const block = text.slice(pad.start, pad.end);
			const [px, py] = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(block)?.slice(1).map(Number) ?? [0, 0];
			const [w, h] = /\(size\s+([\d.]+)\s+([\d.]+)\)/.exec(block)?.slice(1).map(Number) ?? [0, 0];
			local.push([px - w / 2, py - h / 2], [px + w / 2, py + h / 2]);
		}
	}
	if (!Number.isFinite(fp.x) || !Number.isFinite(fp.y)) return null;
	if (!local.length) return [fp.x, fp.y, fp.x, fp.y];
	const t = (fp.angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
	const xs = local.map(([x, y]) => fp.x + x * c + y * s), ys = local.map(([x, y]) => fp.y - x * s + y * c);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const overlaps = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** The bounding box of the board-level Edge.Cuts graphics, KiCad mm (y down), or null without an outline. */
export function outlineBox(text: string): Box | null {
	const xs: number[] = [], ys: number[] = [];
	for (const span of children(text, root(text))) {
		const block = text.slice(span.start, span.end);
		if (!/^\(gr_/.test(block) || !/\(layer\s+"Edge\.Cuts"\)/.test(block)) continue;
		const points = [...block.matchAll(POINT)].map((m) => [Number(m[1]), Number(m[2])]);
		if (block.startsWith('(gr_circle')) {
			const [c, e] = points;
			const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
			points.push([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]);
		}
		for (const [x, y] of points) {
			xs.push(x);
			ys.push(y);
		}
	}
	return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
}

/**
 * The board as far as its 3D export is concerned: without tracks, track arcs, zones, groups and uuids, which the
 * export leaves out (no copper is exported). Pads, vias, footprints, models, outline and stackup stay, so anything
 * that could move a hole or a part changes the result. Revision ids hash this text (boards.ts candidates), and links
 * name boards by id: once published, a change here renames every revision and orphans every pinned board link.
 */
export function shapeText(text: string): string {
	const board = root(text);
	const cut = children(text, board).filter((s) => ['segment', 'arc', 'zone', 'group'].includes(headOf(text, s.start)));
	let out = '';
	let at = 0;
	for (const span of cut) {
		out += text.slice(at, span.start);
		at = span.end;
	}
	out += text.slice(at);
	return out.replace(/\((?:uuid|tstamp)\s+"?[0-9a-fA-F-]+"?\)/g, '').replace(/[ \t]*\n(?:[ \t]*\n)+/g, '\n');
}

/** The repository files a board's models point into, by their name in `lib`: what else the export reads from git. */
export function libraryRefs(text: string): string[] {
	const names = new Set<string>();
	for (const fp of footprints(text)) {
		for (const m of fp.models) {
			const match = /(?:^|[/\\])lib[/\\]([^/\\]+)$/.exec(m.path);
			if (match && !/\$\{KICAD\d*_3DMODEL_DIR\}/.test(m.path)) names.add(match[1]);
		}
	}
	return [...names].sort();
}

function replaceSpans(text: string, edits: { span: Span; with: string }[]) {
	let out = text;
	for (const { span, with: replacement } of [...edits].sort((a, b) => b.span.start - a.span.start)) {
		out = out.slice(0, span.start) + replacement + out.slice(span.end);
	}
	return out;
}

const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;

/** Gives a model a new path, keeping its offset, scale and rotation. */
function withPath(text: string, model: Model, path: string) {
	return text.slice(model.start, model.end).replace(/^\(model\s+"(?:[^"\\]|\\.)*"/, `(model ${quote(path)}`);
}

export type Fixups = {
	/** Stock models KiCad's library lacks, by path below the library without extension, and the closest one it has. */
	nearest?: Record<string, string>;
	/** Model scale by reference, for parts whose stock model has the wrong size (an inductor modelled taller). */
	scale?: Record<string, [number, number, number]>;
};

/**
 * The edits that need no 3D library, in a fixed order:
 * 1. models that point into the engineer's own checkout (an absolute path ending in lib/<file>) point at the
 *    repository's lib folder instead, when it has the file;
 * 2. footprints parked off the board, whose courtyard misses its outline altogether, are left out (they would float
 *    next to it); a connector that hangs over the edge stays;
 * 3. scale overrides, on a footprint's visible models.
 * `libPrefix` is how the board's folder reaches lib, e.g. "${KIPRJMOD}/../../lib".
 */
export function prepare(text: string, fixups: Fixups, opts: { libPrefix: string; libHas: (name: string) => boolean }) {
	const notes: string[] = [];
	const edits: { span: Span; with: string }[] = [];
	const box = outlineBox(text);
	const outside: string[] = [], rehomed: string[] = [], scaled: string[] = [];
	for (const fp of footprints(text)) {
		const reach = box && footprintBox(text, fp);
		if (box && reach && !overlaps(reach, box)) {
			outside.push(fp.ref);
			edits.push({ span: fp, with: '' });
			continue;
		}
		let block = text.slice(fp.start, fp.end);
		const local: { span: Span; with: string }[] = [];
		for (const m of fp.models) {
			const own = /^\/.+[/\\]lib[/\\]([^/\\]+)$|^[A-Za-z]:[/\\].+[/\\]lib[/\\]([^/\\]+)$/.exec(m.path);
			const name = own?.[1] ?? own?.[2];
			if (name && opts.libHas(name)) {
				local.push({ span: { start: m.start - fp.start, end: m.end - fp.start }, with: withPath(text, m, `${opts.libPrefix}/${name}`) });
				rehomed.push(fp.ref);
			}
		}
		const s = fixups.scale?.[fp.ref];
		if (s) {
			for (const m of fp.models.filter((m) => !m.hidden)) {
				const own = local.find((e) => e.span.start === m.start - fp.start)?.with ?? text.slice(m.start, m.end);
				const next = own.replace(/\(scale\s*\(xyz\s+[-\d.e]+\s+[-\d.e]+\s+[-\d.e]+\)\s*\)/, `(scale (xyz ${s.join(' ')}))`);
				if (next === own) continue;
				const edit = local.find((e) => e.span.start === m.start - fp.start);
				if (edit) edit.with = next;
				else local.push({ span: { start: m.start - fp.start, end: m.end - fp.start }, with: next });
				if (!scaled.includes(fp.ref)) scaled.push(fp.ref);
			}
		}
		block = replaceSpans(block, local);
		if (block !== text.slice(fp.start, fp.end)) edits.push({ span: fp, with: block });
	}
	if (rehomed.length) notes.push(`models from the repository's lib: ${[...new Set(rehomed)].join(', ')}`);
	if (outside.length) notes.push(`left out, parked outside the board: ${outside.join(', ')}`);
	if (scaled.length) notes.push(`model scale: ${scaled.map((ref) => `${ref} ${fixups.scale![ref].join('×')}`).join(', ')}`);
	const missingScale = Object.keys(fixups.scale ?? {}).filter((ref) => !scaled.includes(ref));
	if (missingScale.length) notes.push(`scale not needed or no such part: ${missingScale.join(', ')}`);
	return { text: replaceSpans(text, edits), notes };
}

const LIBRARY = /^\$\{KICAD\d*_3DMODEL_DIR\}[/\\](.+)\.[A-Za-z0-9]+$/;

/**
 * After a first export: models KiCad could not find get the closest stock model from `nearest`. Returns null when
 * nothing applies, so the first export stands.
 */
export function useNearest(text: string, notFound: Set<string>, nearest: Record<string, string> = {}) {
	const edits: { span: Span; with: string }[] = [];
	const swapped = new Map<string, string[]>();
	for (const fp of footprints(text)) {
		for (const m of fp.models) {
			const key = LIBRARY.exec(m.path)?.[1];
			if (!key || !notFound.has(m.path) || !nearest[key]) continue;
			edits.push({ span: m, with: withPath(text, m, `\${KICAD10_3DMODEL_DIR}/${nearest[key]}.step`) });
			const swap = `${key.split('/').pop()} → ${nearest[key].split('/').pop()}`;
			swapped.set(swap, [...(swapped.get(swap) ?? []), fp.ref]);
		}
	}
	const listed = [...swapped].map(([swap, refs]) => `${swap} (${refs.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(', ')})`);
	return edits.length ? { text: replaceSpans(text, edits), note: `closest stock models: ${listed.join('; ')}` } : null;
}

/** References of the parts that should show in 3D: those with a model that is not hidden. */
export function modelledRefs(text: string): string[] {
	return footprints(text)
		.filter((fp) => fp.models.some((m) => !m.hidden))
		.map((fp) => fp.ref)
		.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
