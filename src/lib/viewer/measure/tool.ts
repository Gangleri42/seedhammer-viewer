// The Measure tool: it picks faces, edges and points the way Fusion's Measure does, measures the two selections the app
// hands it, and draws the result over the model. App.svelte talks to nothing else here; the selections themselves live
// in the app's view state (and so in the link), and come back through setSelection.
import type { MeasureFile } from '$lib/measure/format';
import { Measurer } from '$lib/measure/measure';
import { nextSelection } from '$lib/measure/selection';
import type { Entity, Measurement, Row } from '$lib/measure/types';
import { formatRow } from '$lib/measure/units';
import { sameRef, type MeasureRef } from '$lib/state/hash';
import { isShown, shownPart, type Part } from '../parts';
import type { CanvasTool, Palette, Viewer } from '../scene';
import { Annotations, type Dimension, type Mark } from './annotate';
import { Topology, type Snap } from './data';
import { trianglesByFace } from './faces';
import { Highlights, type Highlight } from './highlight';
import { Picker, type Pick } from './pick';

export type Selection = {
	ref: MeasureRef;
	/** "Face · cylinder", "Edge · circle", "Centre". */
	title: string;
	part: string;
	hidden: boolean;
	rows: Row[];
	/** The circle for its centre, or the centre for its circle. */
	alternate: MeasureRef | null;
};
export type MeasureStatus = 'loading' | 'ready' | 'unavailable' | 'error';
/** What the panel shows. `ready` is false until the measurement file has arrived. */
export type Outcome = { selections: Selection[]; rows: Row[]; ready: boolean };

type Hover = { x: number; y: number; touch: boolean };

/** Anchors worth a line on screen, and which result row each belongs to. */
const LINES: Record<string, { row: string; dashed?: boolean; focus?: boolean }> = {
	distance: { row: 'distance' },
	centre: { row: 'centre', dashed: true },
	min: { row: 'min', focus: true },
	max: { row: 'max', focus: true },
	perpendicular: { row: 'perpendicular', dashed: true, focus: true },
	dx: { row: 'dx', dashed: true, focus: true },
	dy: { row: 'dy', dashed: true, focus: true },
	dz: { row: 'dz', dashed: true, focus: true }
};

const meshOf = (body: Part, face: number) => body.meshes.find((mesh) => trianglesByFace(mesh.geometry)?.has(face)) ?? null;

export class MeasureTool implements CanvasTool {
	active = false;
	#viewer: Viewer;
	#on: { change(refs: MeasureRef[]): void; outcome(outcome: Outcome): void };
	#data: MeasureFile | null = null;
	#topology: Topology | null = null;
	#refs: MeasureRef[] = [];
	#picker: Picker;
	#highlights: Highlights;
	#annotations: Annotations;
	#measurer = new Measurer();
	#hover: Hover | null = null;
	#keys = { lock: false, hide: false };
	#pending = false;
	#moving = false;
	#hovered: { pick: Pick | null; snaps: Snap[] } = { pick: null, snaps: [] };
	#snapping = true;
	#precision = 2;
	#selected: Highlight[] = [];
	#selectedMarks: Mark[] = [];
	#dimensions: Dimension[] = [];
	#result: Measurement | null = null;
	#listeners: [string, EventListener][] = [];

	constructor(viewer: Viewer, on: { change(refs: MeasureRef[]): void; outcome(outcome: Outcome): void }) {
		this.#viewer = viewer;
		this.#on = on;
		this.#picker = new Picker(viewer, () => this.#topology);
		this.#highlights = new Highlights(viewer.section);
		this.#annotations = new Annotations(viewer.renderer.domElement.parentElement!);
		this.#annotations.setVisible(false);
		// ⌘/Ctrl locks to snap points and Shift hides them: pressing or releasing one re-picks where the pointer is.
		const keys = (e: Event) => this.#setKeys((e as KeyboardEvent).metaKey || (e as KeyboardEvent).ctrlKey, (e as KeyboardEvent).shiftKey);
		this.#listeners = [['keydown', keys], ['keyup', keys], ['blur', () => this.#setKeys(false, false)]];
		for (const [type, listener] of this.#listeners) addEventListener(type, listener);
	}

	setActive(on: boolean) {
		if (on === this.active) return;
		this.active = on;
		this.#annotations.setVisible(on);
		this.#hover = null;
		this.#hovered = { pick: null, snaps: [] };
		this.#picker.sticky = [];
		if (on) {
			// The explode went back to 0 on the way in: positions are the assembled ones again.
			this.#topology?.reset();
			this.#resolve();
		} else this.#highlights.clear();
		this.#viewer.requestRender();
	}

	/** The loaded model's measurement file, or null while it loads or when there is none. */
	setModel(data: MeasureFile | null) {
		if (data === this.#data) return;
		this.#data = data;
		this.#topology = data && this.#viewer.parts ? new Topology(data, this.#viewer.parts) : null;
		this.#measurer.clear();
		this.#picker.sticky = [];
		this.#resolve();
	}

	get ready() {
		return !!this.#topology;
	}

	/** The loaded file placed in the scene (read-only use; the development build's tests look up expected values). */
	get topology() {
		return this.#topology;
	}

	/** Whether a link's item is in the loaded file, and still the same size. */
	valid(ref: MeasureRef) {
		return this.#topology?.valid(ref) ?? false;
	}

	setSelection(refs: MeasureRef[]) {
		this.#refs = refs;
		this.#resolve();
	}

	setSnapping(on: boolean) {
		this.#snapping = on;
		this.#pending = true;
	}

	setPrecision(decimals: number) {
		this.#precision = decimals;
		this.#dimensions = this.#result ? this.#lines(this.#result) : [];
		this.#draw();
	}

	/** Brings a result row's line forward (hovering the row); null for none. */
	focus(key: string | null) {
		this.#annotations.focus(key);
	}

	hover(event: PointerEvent | null) {
		if (event) this.#setKeys(event.metaKey || event.ctrlKey, event.shiftKey);
		this.#hover = event ? { ...this.#viewer.canvasPoint(event), touch: event.pointerType === 'touch' } : null;
		this.#pending = true;
	}

	click(event: PointerEvent) {
		const { x, y } = this.#viewer.canvasPoint(event);
		const lock = event.metaKey || event.ctrlKey;
		const { pick } = this.#picker.pick(x, y, { touch: event.pointerType === 'touch', snapping: this.#snapping && !event.shiftKey, lock });
		const ref = pick && this.#topology ? this.#topology.withCheck(pick.ref) : (pick?.ref ?? null);
		this.#on.change(nextSelection(this.#refs, ref));
	}

	frame(moving: boolean) {
		// No picking while the camera moves; the pointer's spot is picked again once it rests.
		if (moving) {
			if (!this.#moving) this.#picker.sticky = [];
			this.#moving = true;
			return false;
		}
		if (this.#moving) {
			this.#moving = false;
			this.#pending = true;
		}
		if (!this.#pending) return false;
		this.#pending = false;
		const before = this.#hovered;
		const h = this.#hover;
		this.#hovered = h ? this.#picker.pick(h.x, h.y, { touch: h.touch, snapping: this.#snapping && !this.#keys.hide, lock: this.#keys.lock }) : { pick: null, snaps: [] };
		const same = (a: Pick | null, b: Pick | null) => (a && b ? sameRef(a.ref, b.ref) : a === b);
		if (same(before.pick, this.#hovered.pick) && before.snaps.length === this.#hovered.snaps.length) return false;
		this.#draw();
		return true;
	}

	rendered() {
		this.#annotations.update((p) => this.#viewer.toScreen(p));
	}

	detach() {
		this.#highlights.clear();
		this.#data = null;
		this.#topology = null;
		this.#measurer.clear();
		this.#picker.sticky = [];
		this.#hovered = { pick: null, snaps: [] };
		this.#selected = [];
		this.#selectedMarks = [];
		this.#dimensions = [];
		this.#result = null;
		this.#annotations.set([], []);
	}

	setPalette(palette: Palette) {
		this.#highlights.setColor(palette.measure);
		this.#viewer.requestRender();
	}

	dispose() {
		for (const [type, listener] of this.#listeners) removeEventListener(type, listener);
		this.#highlights.dispose();
		this.#annotations.dispose();
	}

	#setKeys(lock: boolean, hide: boolean) {
		if (lock === this.#keys.lock && hide === this.#keys.hide) return;
		this.#keys = { lock, hide };
		if (this.#hover) this.#pending = true;
	}

	/** Measures the selections and reports them; items the file does not know stay listed without values. */
	#resolve() {
		const topology = this.#topology;
		const parts = this.#viewer.parts;
		const selections: Selection[] = [];
		const entities: Entity[] = [];
		this.#selected = [];
		this.#selectedMarks = [];
		for (const ref of this.#refs) {
			const body = parts?.byId.get(ref.part);
			if (!body?.body) continue;
			const known = topology?.valid(ref) ?? false;
			const entry: Selection = {
				ref,
				title: known ? topology!.title(ref) : ref.kind === 'f' ? 'Face' : '…',
				part: shownPart(body).name,
				hidden: !isShown(body),
				rows: [],
				alternate: known ? topology!.alternate(ref) : null
			};
			selections.push(entry);
			if (ref.kind === 'f') {
				const mesh = meshOf(body, ref.index);
				if (mesh) this.#selected.push({ style: 'selected', kind: 'face', mesh, face: ref.index });
			}
			if (!known) continue;
			if (ref.kind === 'e') this.#selected.push({ style: 'selected', kind: 'edge', body, points: topology!.polyline(body, ref.index) });
			const entity = topology!.entity(ref)!;
			entities.push(entity);
			if (entity.type === 'point') this.#selectedMarks.push({ at: entity.position, style: 'selected' });
			try {
				const properties = this.#measurer.properties(entity);
				entry.rows = properties.rows;
				for (const anchor of properties.anchors) if (anchor.kind === 'point' && anchor.role === 'centre') this.#selectedMarks.push({ at: anchor.at, style: 'snap' });
			} catch (err) {
				console.error('measure', err);
			}
		}
		this.#result = null;
		if (entities.length === 2) {
			try {
				this.#result = this.#measurer.measure(entities[0], entities[1]);
			} catch (err) {
				console.error('measure', err);
			}
		}
		this.#dimensions = this.#result ? this.#lines(this.#result) : [];
		this.#on.outcome({ selections, rows: this.#result?.rows ?? [], ready: !!topology });
		this.#draw();
	}

	/** Lines and labels for a pair's result. */
	#lines(result: Measurement): Dimension[] {
		const label = (key: string) => {
			const row = result.rows.find((r) => r.key === key);
			return row ? formatRow(row, this.#precision) : undefined;
		};
		const lines: Dimension[] = [];
		for (const anchor of result.anchors) {
			if (anchor.kind === 'segment') {
				const spec = LINES[anchor.role];
				if (spec) lines.push({ key: spec.row, a: anchor.a, b: anchor.b, label: label(spec.row), dashed: spec.dashed, focus: spec.focus });
			} else if (anchor.kind === 'angle') {
				lines.push({ key: 'angle', a: anchor.a, b: anchor.b, apex: anchor.apex, label: label('angle') });
			} else if (anchor.kind === 'axis') {
				lines.push({ key: 'axis', a: anchor.from, b: anchor.to, dashed: true });
			}
		}
		return lines;
	}

	#draw() {
		const hover = this.#hovered.pick;
		const topology = this.#topology;
		const items = [...this.#selected];
		const marks: Mark[] = [...this.#selectedMarks];
		if (hover && this.active && !this.#refs.some((r) => sameRef(r, hover.ref))) {
			if (hover.kind === 'face') items.push({ style: 'hover', kind: 'face', mesh: hover.mesh, face: hover.face });
			else if (hover.kind === 'edge' && topology) items.push({ style: 'hover', kind: 'edge', body: hover.body, points: topology.polyline(hover.body, hover.edge) });
			else if (hover.kind === 'point') marks.push({ at: hover.point, style: 'target' });
		}
		if (this.active) for (const snap of this.#hovered.snaps) marks.push({ at: snap.point, style: 'snap' });
		this.#highlights.show(this.active ? items : []);
		this.#annotations.set(this.#dimensions, marks.filter((m, i) => !marks.slice(0, i).some((o) => o.at.distanceToSquared(m.at) < 1e-12)));
		this.#viewer.requestRender();
	}
}
