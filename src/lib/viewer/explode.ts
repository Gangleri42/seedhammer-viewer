import * as THREE from 'three';
import type { Part, PartIndex } from './parts';

type Move = { part: Part; base: THREE.Vector3; direction: THREE.Vector3; start: number };

/**
 * Hierarchical explode. Each occurrence moves away from the centre of its parent assembly, in the parent's frame,
 * by its own distance from that centre, so the parent's move carries its children along. Deeper levels start later
 * (top-level sub-assemblies first, their parts next). Fasteners pull straight out along their own axis.
 */
export class Explode {
	#moves: Move[] = [];
	#levels = 1;

	attach(index: PartIndex) {
		this.#moves = [];
		const box = new THREE.Box3();
		const centreOf = (part: Part) => {
			box.makeEmpty();
			for (const mesh of part.meshes) box.expandByObject(mesh);
			return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
		};
		index.roots[0]?.object.parent?.updateMatrixWorld(true);

		const parents = [...index.byId.values()].filter((p) => p.children.length > 1 && !p.fastener);
		const topCentre = new THREE.Box3().setFromObject(index.roots[0]?.object.parent ?? new THREE.Object3D()).getCenter(new THREE.Vector3());
		this.#levels = 1;

		const add = (part: Part, parentCentre: THREE.Vector3, depth: number) => {
			const centre = centreOf(part);
			if (!centre) return;
			const parentObject = part.object.parent!;
			const inverse = parentObject.matrixWorld.clone().invert();
			let direction: THREE.Vector3;
			if (part.fastener) {
				// Along the fastener's local Z, pointing away from the assembly centre, by twice its length.
				const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(part.object.getWorldQuaternion(new THREE.Quaternion()));
				const size = new THREE.Box3();
				for (const mesh of part.meshes) size.expandByObject(mesh);
				const length = size.getSize(new THREE.Vector3()).dot(axis.clone().set(Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)));
				if (axis.dot(centre.clone().sub(parentCentre)) < 0) axis.negate();
				direction = axis.multiplyScalar(Math.max(length, 2) * 2);
			} else {
				direction = centre.clone().sub(parentCentre);
			}
			// World displacement into the parent's frame.
			const local = direction.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(inverse));
			if (local.lengthSq() < 1e-6) return;
			this.#moves.push({ part, base: part.object.position.clone(), direction: local, start: depth });
			this.#levels = Math.max(this.#levels, depth + 1);
		};

		for (const root of index.roots) add(root, topCentre, 0);
		for (const parent of parents) {
			const centre = centreOf(parent);
			if (!centre) continue;
			for (const child of parent.children) add(child, centre, child.depth);
		}
		// Keep levels compact: only depths that actually move count.
		const depths = [...new Set(this.#moves.map((m) => m.start))].sort((a, b) => a - b);
		for (const move of this.#moves) move.start = depths.indexOf(move.start);
		this.#levels = Math.max(1, depths.length);
	}

	/** factor 0..1. Level i eases in over [i * step, i * step + 0.5]; the last level ends at 1. */
	set(factor: number) {
		const step = this.#levels > 1 ? 0.5 / (this.#levels - 1) : 0;
		const width = this.#levels > 1 ? 0.5 : 1;
		for (const move of this.#moves) {
			const t = THREE.MathUtils.clamp((factor - move.start * step) / width, 0, 1);
			const eased = t * t * (3 - 2 * t);
			move.part.object.position.copy(move.base).addScaledVector(move.direction, eased);
		}
	}
}
