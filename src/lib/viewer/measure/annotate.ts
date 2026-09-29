// Dimension lines, snap markers and value labels, drawn in a DOM layer over the canvas and moved after every render,
// so they stay on top of the model and follow the camera in the same frame. Colours are the theme's CSS variables.
import * as THREE from 'three';

export type Mark = { at: THREE.Vector3; style: 'snap' | 'target' | 'selected' };
/**
 * A line between two points with an optional label. `focus` lines only show while their result row is hovered.
 * An angle is drawn as two rays from its apex.
 */
export type Dimension = {
	key: string;
	a: THREE.Vector3;
	b: THREE.Vector3;
	apex?: THREE.Vector3;
	label?: string;
	dashed?: boolean;
	focus?: boolean;
};

const SVG = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, style: string) => {
	const el = document.createElementNS(SVG, tag);
	el.setAttribute('style', style);
	return el;
};
const HALO = 'stroke: var(--surface-solid); stroke-opacity: 0.85; stroke-width: 4; fill: none; stroke-linecap: round; stroke-linejoin: round';
const STROKE = 'stroke: var(--measure); stroke-width: 1.5; fill: none; stroke-linecap: round; stroke-linejoin: round';
const MARK: Record<Mark['style'], string> = {
	snap: 'fill: var(--surface-solid); stroke: var(--measure); stroke-width: 1.5',
	target: 'fill: var(--measure); stroke: var(--surface-solid); stroke-width: 1.5',
	selected: 'fill: var(--measure); stroke: var(--surface-solid); stroke-width: 2'
};

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

type Drawn = { dimension: Dimension; group: SVGGElement; halo: SVGPolylineElement; line: SVGPolylineElement; ends: SVGCircleElement[]; label?: HTMLDivElement };

export class Annotations {
	readonly layer = document.createElement('div');
	#svg = svg('svg', 'position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible');
	#drawn: Drawn[] = [];
	#marks: { mark: Mark; el: SVGCircleElement }[] = [];
	#focus: string | null = null;

	constructor(container: HTMLElement) {
		this.layer.className = 'measure-layer';
		this.layer.setAttribute('aria-hidden', 'true');
		Object.assign(this.layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1', overflow: 'hidden' });
		this.layer.append(this.#svg);
		container.append(this.layer);
	}

	set(dimensions: Dimension[], marks: Mark[]) {
		for (const drawn of this.#drawn) {
			drawn.group.remove();
			drawn.label?.remove();
		}
		for (const { el } of this.#marks) el.remove();
		this.#drawn = dimensions.map((dimension) => {
			const group = svg('g', '');
			const style = dimension.dashed ? '; stroke-dasharray: 5 4' : '';
			const halo = svg('polyline', HALO);
			const line = svg('polyline', STROKE + style);
			const ends = dimension.apex ? [] : [svg('circle', 'fill: var(--measure)'), svg('circle', 'fill: var(--measure)')];
			for (const end of ends) end.setAttribute('r', '2.5');
			group.append(halo, line, ...ends);
			this.#svg.append(group);
			let label: HTMLDivElement | undefined;
			if (dimension.label) {
				label = document.createElement('div');
				label.textContent = dimension.label;
				Object.assign(label.style, {
					position: 'absolute', transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap', padding: '1px 6px', borderRadius: '6px',
					font: '600 12px/1.4 system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', color: 'var(--measure-text)',
					background: 'var(--surface-solid)', border: '1px solid var(--measure)', boxShadow: 'var(--shadow)'
				});
				this.layer.append(label);
			}
			return { dimension, group, halo, line, ends, label };
		});
		this.#marks = marks.map((mark) => {
			const el = svg('circle', MARK[mark.style]);
			el.setAttribute('r', mark.style === 'snap' ? '4' : '4.5');
			this.#svg.append(el);
			return { mark, el };
		});
		this.#applyFocus();
	}

	/** Shows a result row's own line (min, max, deltas) and brings it forward; null for the default view. */
	focus(key: string | null) {
		this.#focus = key;
		this.#applyFocus();
	}

	#applyFocus() {
		for (const { dimension, group, label } of this.#drawn) {
			const shown = !dimension.focus || dimension.key === this.#focus;
			const faded = this.#focus !== null && dimension.key !== this.#focus;
			group.style.display = shown ? '' : 'none';
			group.style.opacity = faded ? '0.35' : '1';
			if (label) {
				label.style.display = shown ? '' : 'none';
				label.style.opacity = faded ? '0.5' : '1';
			}
		}
	}

	/** Moves everything to where the camera now shows it. */
	update(toScreen: (p: THREE.Vector3) => THREE.Vector2 | null) {
		for (const { dimension, halo, line, ends, label } of this.#drawn) {
			const points = (dimension.apex ? [dimension.a, dimension.apex, dimension.b] : [dimension.a, dimension.b]).map((p) => toScreen(p));
			if (points.some((p) => !p)) {
				for (const el of [halo, line, ...ends]) el.style.visibility = 'hidden';
				if (label) label.style.visibility = 'hidden';
				continue;
			}
			const screen = points as THREE.Vector2[];
			const list = screen.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
			for (const el of [halo, line]) {
				el.setAttribute('points', list);
				el.style.visibility = '';
			}
			ends.forEach((end, i) => {
				const p = screen[i === 0 ? 0 : screen.length - 1];
				end.setAttribute('cx', p.x.toFixed(1));
				end.setAttribute('cy', p.y.toFixed(1));
				end.style.visibility = '';
			});
			if (label) {
				const at = dimension.apex ? screen[1] : screen[0].clone().add(screen[1]).multiplyScalar(0.5);
				label.style.left = `${at.x}px`;
				label.style.top = `${at.y}px`;
				label.style.visibility = '';
			}
		}
		// Labels of lines that share a midpoint (a distance along the line of centres) would hide each other: move each
		// later one down until it is clear of those before it.
		const placed: DOMRect[] = [];
		for (const { label } of this.#drawn) {
			if (!label || label.style.visibility === 'hidden' || label.style.display === 'none') continue;
			let box = label.getBoundingClientRect();
			for (let tries = 0; tries < 6 && placed.some((other) => overlaps(box, other)); tries++) {
				label.style.top = `${parseFloat(label.style.top) + box.height + 2}px`;
				box = label.getBoundingClientRect();
			}
			placed.push(box);
		}
		for (const { mark, el } of this.#marks) {
			const p = toScreen(mark.at);
			el.style.visibility = p ? '' : 'hidden';
			if (p) {
				el.setAttribute('cx', p.x.toFixed(1));
				el.setAttribute('cy', p.y.toFixed(1));
			}
		}
	}

	setVisible(visible: boolean) {
		this.layer.style.display = visible ? '' : 'none';
	}

	dispose() {
		this.layer.remove();
	}
}
