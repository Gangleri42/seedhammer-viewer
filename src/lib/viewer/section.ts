import * as THREE from 'three';
import type { Axis, Cut } from '$lib/state/hash';

const NORMALS: Record<Axis, THREE.Vector3> = {
	x: new THREE.Vector3(-1, 0, 0),
	y: new THREE.Vector3(0, -1, 0),
	z: new THREE.Vector3(0, 0, -1)
};

/**
 * Section planes. A cut removes the material on the positive side of its axis (the negative side when flipped).
 * The cut faces are the solids' back faces seen through the opening, drawn flat in the part's colour with a
 * screen-space hatch: one extra draw per body, any number of planes, and every part keeps its own colour.
 */
export class Section {
	readonly planes: THREE.Plane[] = [];
	#caps: THREE.Mesh[] = [];
	#capMaterials = new Map<THREE.Material, THREE.ShaderMaterial>();
	#materials: THREE.Material[] = [];

	/** Registers every surface and edge material, and adds a cap mesh next to each body. */
	attach(model: THREE.Object3D) {
		// The previous model's cap materials go with it; keeping them would keep every model ever loaded alive.
		for (const material of this.#capMaterials.values()) material.dispose();
		this.#capMaterials.clear();
		this.#caps = [];
		this.#materials = [];
		const seen = new Set<THREE.Material>();
		model.traverse((object) => {
			const material = (object as THREE.Mesh | THREE.LineSegments).material as THREE.Material | undefined;
			if (!material || seen.has(material)) return;
			seen.add(material);
			this.#materials.push(material);
		});
		model.traverse((object) => {
			const mesh = object as THREE.Mesh;
			if (!mesh.isMesh || mesh.userData.cap || (mesh.material as THREE.Material).transparent) return;
			const cap = new THREE.Mesh(mesh.geometry, this.#capMaterial(mesh.material as THREE.MeshStandardMaterial));
			cap.userData.cap = true;
			cap.raycast = () => {};
			cap.visible = false;
			cap.renderOrder = -1;
			mesh.add(cap);
			this.#caps.push(cap);
		});
	}

	set(cuts: Cut[]) {
		this.planes.length = 0;
		for (const cut of cuts) {
			const normal = NORMALS[cut.axis].clone();
			if (cut.flip) normal.negate();
			// Plane keeps points where normal·p + constant >= 0.
			this.planes.push(new THREE.Plane(normal, cut.flip ? -cut.offset : cut.offset));
		}
		const planes = this.planes.length ? this.planes : null;
		for (const material of this.#materials) {
			material.clippingPlanes = planes;
			material.clipShadows = true;
		}
		for (const material of this.#capMaterials.values()) material.clippingPlanes = planes;
		for (const cap of this.#caps) cap.visible = !!planes;
	}

	/** Whether a world point survives every cut (for picking). */
	keeps(point: THREE.Vector3) {
		return this.planes.every((plane) => plane.distanceToPoint(point) >= 0);
	}

	setHatch(color: THREE.ColorRepresentation) {
		for (const material of this.#capMaterials.values()) material.uniforms.hatch.value.set(color);
	}

	#capMaterial(source: THREE.MeshStandardMaterial) {
		let material = this.#capMaterials.get(source);
		if (material) return material;
		const base = source.color?.clone() ?? new THREE.Color(0.5, 0.5, 0.5);
		material = new THREE.ShaderMaterial({
			uniforms: { color: { value: base }, hatch: { value: new THREE.Color(0x000000) } },
			vertexShader: /* glsl */ `
				#include <clipping_planes_pars_vertex>
				void main() {
					#include <begin_vertex>
					#include <project_vertex>
					#include <clipping_planes_vertex>
				}`,
			fragmentShader: /* glsl */ `
				uniform vec3 color;
				uniform vec3 hatch;
				#include <clipping_planes_pars_fragment>
				void main() {
					#include <clipping_planes_fragment>
					float line = step(0.82, fract((gl_FragCoord.x + gl_FragCoord.y) / (7.0 * ${Math.min(globalThis.devicePixelRatio ?? 1, 2).toFixed(1)})));
					gl_FragColor = vec4(mix(color * 0.85 + 0.05, hatch, line * 0.35), 1.0);
					#include <colorspace_fragment>
				}`,
			side: THREE.BackSide,
			clipping: true
		});
		this.#capMaterials.set(source, material);
		return material;
	}
}
