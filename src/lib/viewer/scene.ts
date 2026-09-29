import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { Camera, Cut } from '$lib/state/hash';
import { Explode } from './explode';
import { indexParts, isShown, type Part, type PartIndex } from './parts';
import { Section } from './section';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// The world frame is Fusion's: millimetres, Z up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

// The models are meshopt-compressed, which needs WebAssembly. A host whose content-security policy blocks it makes
// the decoder's ready promise reject; catching that here keeps it from surfacing as an unhandled rejection.
const decoderReady: Promise<boolean> = MeshoptDecoder.supported
	? Promise.resolve(MeshoptDecoder.ready).then(
			() => true,
			() => false
		)
	: Promise.resolve(false);
export const meshoptAvailable = () => decoderReady;

export type Palette = { background: string; edges: string; accent: string; ground: string };
export type NamedView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

const VIEWS: Record<NamedView, [number, number, number]> = {
	iso: [1, -1, 0.75],
	front: [0, -1, 0],
	back: [0, 1, 0],
	left: [-1, 0, 0],
	right: [1, 0, 0],
	top: [0, 0, 1],
	bottom: [0, 0, -1]
};

function upFor(direction: THREE.Vector3) {
	return Math.abs(direction.z) > 0.99 ? new THREE.Vector3(0, direction.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
}

export class Viewer {
	readonly renderer: THREE.WebGLRenderer;
	readonly scene = new THREE.Scene();
	readonly perspective = new THREE.PerspectiveCamera(30, 1, 1, 10000);
	readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
	camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
	readonly controls: OrbitControls;
	readonly section = new Section();
	readonly explode = new Explode();
	parts: PartIndex | null = null;
	model: THREE.Object3D | null = null;
	/** Radius of the model's bounding sphere at load, mm. */
	radius = 100;
	bounds = new THREE.Box3();

	/** Called when the user finishes moving the camera. */
	onCameraChange: () => void = () => {};
	onPick: (part: Part | null) => void = () => {};

	#dirty = true;
	#loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
	#resize: ResizeObserver;
	#light = new THREE.DirectionalLight(0xffffff, 1.2);
	#ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
	#edges: THREE.LineBasicMaterial[] = [];
	#highlight = new Map<THREE.Material, THREE.MeshStandardMaterial>();
	#highlighted: { mesh: THREE.Mesh; material: THREE.Material }[] = [];
	#accent = new THREE.Color('#e2561b');
	#pointerDown: { x: number; y: number } | null = null;
	#inset = 0;

	constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.toneMapping = THREE.NeutralToneMapping;
		this.renderer.localClippingEnabled = true;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

		const pmrem = new THREE.PMREMGenerator(this.renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();

		this.#light.castShadow = true;
		this.#light.shadow.mapSize.set(2048, 2048);
		this.#light.shadow.radius = 6;
		this.#light.shadow.bias = -0.0005;
		this.scene.add(this.#light, this.#light.target);

		this.#ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.18 }));
		this.#ground.receiveShadow = true;
		this.#ground.raycast = () => {};
		this.scene.add(this.#ground);

		this.perspective.position.set(300, -300, 250);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.12;
		this.controls.screenSpacePanning = true;
		// The camera is reported once it has been still for 300 ms (damping included).
		let settle: ReturnType<typeof setTimeout>;
		this.controls.addEventListener('change', () => {
			this.requestRender();
			clearTimeout(settle);
			settle = setTimeout(() => this.onCameraChange(), 300);
		});
		// Also on release, in case damping takes long to settle (slow GPUs).
		this.controls.addEventListener('end', () => this.onCameraChange());

		// A click (not a drag) picks a part.
		canvas.addEventListener('pointerdown', (e) => (this.#pointerDown = { x: e.clientX, y: e.clientY }));
		canvas.addEventListener('pointerup', (e) => {
			const down = this.#pointerDown;
			this.#pointerDown = null;
			if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.onPick(this.pick(e.clientX, e.clientY));
		});

		this.#resize = new ResizeObserver(() => this.#fitCanvas());
		this.#resize.observe(canvas);
		this.#fitCanvas();

		// Render on demand: damping keeps controls.update() returning true until the motion settles.
		this.renderer.setAnimationLoop(() => {
			const moving = this.controls.update();
			if (!moving && !this.#dirty) return;
			this.#dirty = false;
			this.renderer.render(this.scene, this.camera);
		});
	}

	requestRender() {
		this.#dirty = true;
	}

	setPalette(palette: Palette) {
		this.scene.background = new THREE.Color(palette.background);
		this.#accent.set(palette.accent);
		for (const material of this.#highlight.values()) material.emissive.copy(this.#accent);
		for (const material of this.#edges) material.color.set(palette.edges);
		this.section.setHatch(palette.edges);
		this.#ground.material.color.set(palette.ground);
		this.requestRender();
	}

	/** Replaces the model with a GLB's bytes and returns its part index. */
	async loadBuffer(buffer: ArrayBuffer) {
		const gltf = await this.#loader.parseAsync(buffer, '');
		if (this.model) {
			this.scene.remove(this.model);
			this.model.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
		}
		// The GLB root carries glTF's metres and Y-up; drop it so node coordinates are Fusion's again.
		const root = gltf.scene.children[0];
		root.position.set(0, 0, 0);
		root.quaternion.identity();
		root.scale.set(1, 1, 1);
		this.model = gltf.scene;

		this.#edges = [];
		this.#highlight.clear();
		this.#highlighted = [];
		const edgeMaterials = new Map<THREE.Material, THREE.LineBasicMaterial>();
		this.model.traverse((object) => {
			const line = object as THREE.LineSegments;
			if (line.isLineSegments) {
				let material = edgeMaterials.get(line.material as THREE.Material);
				if (!material) {
					material = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false });
					edgeMaterials.set(line.material as THREE.Material, material);
					this.#edges.push(material);
				}
				line.material = material;
				line.raycast = () => {};
				line.renderOrder = 1;
				return;
			}
			const mesh = object as THREE.Mesh;
			if (!mesh.isMesh) return;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.geometry.computeBoundsTree();
			// Surfaces sit a hair behind their edge lines so the lines never flicker.
			const material = mesh.material as THREE.MeshStandardMaterial;
			material.polygonOffset = true;
			material.polygonOffsetFactor = 1;
			material.polygonOffsetUnits = 1;
		});
		this.scene.add(this.model);
		this.model.updateMatrixWorld(true);

		this.parts = indexParts(root);
		this.section.attach(root);
		this.explode.attach(this.parts);

		this.bounds.setFromObject(root);
		this.radius = this.bounds.getBoundingSphere(new THREE.Sphere()).radius;
		this.#placeGroundAndLight();
		this.fit('iso');
		return this.parts;
	}

	#placeGroundAndLight() {
		const centre = this.bounds.getCenter(new THREE.Vector3());
		this.#ground.position.set(centre.x, centre.y, this.bounds.min.z - 0.01);
		this.#ground.scale.set(this.radius * 8, this.radius * 8, 1);
		this.#light.position.copy(centre).add(new THREE.Vector3(0.35, -0.5, 1.6).multiplyScalar(this.radius * 2));
		this.#light.target.position.copy(centre);
		const shadow = this.#light.shadow.camera;
		shadow.left = shadow.bottom = -this.radius * 1.6;
		shadow.right = shadow.top = this.radius * 1.6;
		shadow.near = this.radius * 0.5;
		shadow.far = this.radius * 6;
		shadow.updateProjectionMatrix();
	}

	/** Bounds of what is shown right now: hidden parts left out, explode included. */
	#visibleBounds() {
		const box = new THREE.Box3();
		this.model?.updateMatrixWorld(true);
		for (const part of this.parts?.byId.values() ?? []) {
			if (part.children.length || !isShown(part)) continue;
			for (const mesh of part.meshes) box.expandByObject(mesh);
		}
		return box.isEmpty() ? this.bounds.clone() : box;
	}

	/** Fits what is shown into the free part of the canvas, from a named direction or the current one. */
	fit(view?: NamedView) {
		if (!this.model) return;
		const sphere = this.#visibleBounds().getBoundingSphere(new THREE.Sphere());
		const direction = view
			? new THREE.Vector3(...VIEWS[view]).normalize()
			: this.camera.position.clone().sub(this.controls.target).normalize();
		const canvas = this.renderer.domElement;
		const aspect = Math.max(0.2, (canvas.clientWidth - this.#inset) / Math.max(1, canvas.clientHeight));
		const halfV = THREE.MathUtils.degToRad(this.perspective.fov / 2);
		const halfH = Math.atan(Math.tan(halfV) * aspect);
		const distance = sphere.radius / Math.sin(Math.min(halfV, halfH));
		for (const camera of [this.perspective, this.orthographic]) {
			camera.up.copy(upFor(direction));
			camera.position.copy(sphere.center).addScaledVector(direction, distance * 1.02);
		}
		this.orthographic.zoom = Math.min(1, aspect) * (this.radius * 1.05) / (sphere.radius * 1.05);
		this.#frustum(this.radius * 1.05);
		this.controls.target.copy(sphere.center);
		this.controls.update();
		this.requestRender();
		this.onCameraChange();
	}

	/** Pixels on the left covered by a panel: the view centre moves right by half of it. */
	setInset(pixels: number) {
		if (pixels === this.#inset) return;
		this.#inset = pixels;
		this.#fitCanvas();
	}

	setOrtho(ortho: boolean) {
		const next = ortho ? this.orthographic : this.perspective;
		if (next === this.camera) return;
		next.position.copy(this.camera.position);
		next.up.copy(this.camera.up);
		if (ortho) {
			// Keep the scale at the orbit target the same.
			const distance = this.camera.position.distanceTo(this.controls.target);
			const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
			this.orthographic.zoom = (this.orthographic.top - this.orthographic.bottom) / 2 / halfHeight;
			this.orthographic.updateProjectionMatrix();
		}
		this.camera = next;
		this.controls.object = next;
		this.controls.update();
		this.requestRender();
	}

	getCamera(): Camera {
		const p = this.camera.position, t = this.controls.target;
		const camera: Camera = { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
		if (this.camera === this.orthographic) camera.zoom = this.orthographic.zoom;
		return camera;
	}

	setCamera(camera: Camera) {
		const position = new THREE.Vector3(...camera.position), target = new THREE.Vector3(...camera.target);
		const up = upFor(position.clone().sub(target).normalize());
		for (const c of [this.perspective, this.orthographic]) {
			c.position.copy(position);
			c.up.copy(up);
		}
		if (camera.zoom) this.orthographic.zoom = camera.zoom;
		this.orthographic.updateProjectionMatrix();
		this.controls.target.copy(target);
		this.controls.update();
		this.requestRender();
	}

	setEdges(visible: boolean) {
		for (const material of this.#edges) material.visible = visible;
		this.requestRender();
	}

	setCuts(cuts: Cut[]) {
		this.section.set(cuts);
		for (const [source, tinted] of this.#highlight) tinted.clippingPlanes = source.clippingPlanes;
		this.requestRender();
	}

	setExplode(factor: number) {
		this.explode.set(factor);
		this.requestRender();
	}

	/** Tints every mesh of the part with the accent colour. */
	highlight(part: Part | null) {
		for (const { mesh, material } of this.#highlighted) mesh.material = material;
		this.#highlighted = [];
		for (const mesh of part?.meshes ?? []) {
			const source = mesh.material as THREE.MeshStandardMaterial;
			let tinted = this.#highlight.get(source);
			if (!tinted) {
				tinted = source.clone();
				tinted.emissive = this.#accent.clone();
				tinted.emissiveIntensity = 0.4;
				this.#highlight.set(source, tinted);
			}
			tinted.clippingPlanes = source.clippingPlanes;
			this.#highlighted.push({ mesh, material: source });
			mesh.material = tinted;
		}
		this.requestRender();
	}

	/** The visible, uncut part under a screen point: the occurrence that owns the body. */
	pick(clientX: number, clientY: number): Part | null {
		if (!this.model || !this.parts) return null;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(pointer, this.camera);
		for (const hit of raycaster.intersectObject(this.model, true)) {
			if (hit.object.userData.cap) continue;
			const part = this.parts.byObject.get(hit.object);
			if (!part || !isShown(part) || !this.section.keeps(hit.point)) continue;
			return part.body && part.parent ? part.parent : part;
		}
		return null;
	}

	#frustum(halfHeight?: number) {
		const canvas = this.renderer.domElement;
		const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
		const h = halfHeight ?? (this.orthographic.top - this.orthographic.bottom) / 2;
		Object.assign(this.orthographic, { left: -h * aspect, right: h * aspect, top: h, bottom: -h });
		this.orthographic.updateProjectionMatrix();
		this.perspective.near = Math.max(0.1, this.radius / 200);
		this.perspective.far = this.radius * 40;
		this.perspective.updateProjectionMatrix();
		const width = canvas.clientWidth, height = canvas.clientHeight;
		for (const camera of [this.perspective, this.orthographic]) {
			if (this.#inset && width && height) camera.setViewOffset(width, height, -this.#inset / 2, 0, width, height);
			else camera.clearViewOffset();
		}
	}

	#fitCanvas() {
		const canvas = this.renderer.domElement;
		const { clientWidth: width, clientHeight: height } = canvas;
		if (!width || !height) return;
		this.renderer.setSize(width, height, false);
		this.perspective.aspect = width / height;
		this.#frustum();
		this.requestRender();
	}

	dispose() {
		this.#resize.disconnect();
		this.renderer.setAnimationLoop(null);
		this.controls.dispose();
		this.renderer.dispose();
	}
}
