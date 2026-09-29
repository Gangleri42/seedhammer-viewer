// Hovered and selected faces and edges, tinted in the Measure colour. Each highlight is a child of the mesh or body it
// marks, so it moves, hides and is cut with it; its geometry is its own, so it can be thrown away at any time.
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Part } from '../parts';
import type { Section } from '../section';
import { faceGeometry } from './faces';

export type Style = 'hover' | 'selected';
export type Highlight =
	| { style: Style; kind: 'face'; mesh: THREE.Mesh; face: number }
	| { style: Style; kind: 'edge'; body: Part; points: THREE.Vector3[] };

export class Highlights {
	#objects: THREE.Object3D[] = [];
	#faces: Record<Style, THREE.MeshBasicMaterial>;
	#lines: Record<Style, LineMaterial>;

	constructor(section: Section) {
		// The planes array is the section's own, so highlights follow every cut.
		const face = (opacity: number) =>
			new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, clippingPlanes: section.planes });
		this.#faces = { hover: face(0.22), selected: face(0.4) };
		const line = (linewidth: number) => new LineMaterial({ linewidth, clippingPlanes: section.planes });
		this.#lines = { hover: line(2), selected: line(3) };
	}

	setColor(color: string) {
		for (const material of [...Object.values(this.#faces), ...Object.values(this.#lines)]) material.color.set(color);
	}

	/** Replaces every highlight with these. */
	show(items: Highlight[]) {
		this.clear();
		for (const item of items) {
			if (item.kind === 'face') {
				const geometry = faceGeometry(item.mesh, item.face);
				if (!geometry) continue;
				const overlay = new THREE.Mesh(geometry, this.#faces[item.style]);
				// The model's surfaces sit a hair behind (polygon offset), so the tint wins without flicker.
				overlay.renderOrder = 2;
				overlay.raycast = () => {};
				item.mesh.add(overlay);
				this.#objects.push(overlay);
			} else if (item.points.length > 1) {
				const node = item.body.object;
				node.updateWorldMatrix(true, false);
				const positions = item.points.flatMap((p) => node.worldToLocal(p.clone()).toArray());
				const line = new Line2(new LineGeometry().setPositions(positions), this.#lines[item.style]);
				line.renderOrder = 3;
				line.raycast = () => {};
				node.add(line);
				this.#objects.push(line);
			}
		}
	}

	clear() {
		for (const object of this.#objects) {
			object.removeFromParent();
			(object as THREE.Mesh).geometry.dispose();
		}
		this.#objects = [];
	}

	dispose() {
		this.clear();
		for (const material of [...Object.values(this.#faces), ...Object.values(this.#lines)]) material.dispose();
	}
}
