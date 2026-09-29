<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { Host, ShareLink, StepAction } from '$lib/host/host';
	import type { ModelIndex } from '$lib/models/types';
	import { decode, defaultState, encode, DEFAULT_MODEL, type Axis, type Cut, type ViewState } from '$lib/state/hash';
	import { theme } from '$lib/theme.svelte';
	import PartTree from '$lib/ui/PartTree.svelte';
	import SectionPanel from '$lib/ui/SectionPanel.svelte';
	import type { Part, PartIndex } from '$lib/viewer/parts';
	import { applyVisibility } from '$lib/viewer/parts';
	import type { NamedView, Viewer } from '$lib/viewer/scene';

	let { host }: { host: Host } = $props();

	let canvas: HTMLCanvasElement;
	let viewer = $state.raw<Viewer>();
	let index = $state.raw<ModelIndex>();
	let parts = $state.raw<PartIndex | null>(null);
	let view = $state<ViewState>(defaultState());
	let loaded = $state<string | null>(null);
	let progress = $state<number | null>(0);
	let error = $state('');
	let notice = $state('');
	let panelOpen = $state(true);
	let sectionOpen = $state(false);
	let shareOpen = $state(false);
	let pin = $state(false);
	let copied = $state<string | null>(null);
	let fallback = $state<{ label: string; text: string } | null>(null);
	let narrow = $state(false);
	/** Whether the meshopt decoder works here; null until the viewer module is in. */
	let wasm: boolean | null = null;

	const entry = $derived(index ? (index.models[view.model] ?? index.models[DEFAULT_MODEL]) : null);
	const current = $derived(entry ? (entry.versions.find((v) => v.version === view.version) ?? entry.versions[0]) : null);
	const key = $derived(current ? `${view.model}@${current.version}` : null);
	const hidden = $derived(new Set(view.hidden));
	const isolated = $derived(new Set(view.isolated));
	const selectedPart = $derived(view.selected ? (parts?.byId.get(view.selected) ?? null) : null);
	const range = $derived.by((): Record<Axis, [number, number]> => {
		const b = viewer && parts ? viewer.bounds : null;
		return b ? { x: [b.min.x, b.max.x], y: [b.min.y, b.max.y], z: [b.min.z, b.max.z] } : { x: [-100, 100], y: [-100, 100], z: [-100, 100] };
	});

	const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
	let homeCamera = '';
	const cameraKey = (camera: ViewState['camera']) => encode({ ...defaultState(), camera });

	onMount(() => {
		const stopTheme = theme.init(host.theme);
		view = decode(host.initialRoute());
		const query = matchMedia('(max-width: 760px)');
		narrow = query.matches;
		panelOpen = !narrow;
		query.addEventListener('change', (e) => (narrow = e.matches));

		let disposed = false;
		let instance: Viewer | undefined;
		import('$lib/viewer/scene')
			.then(async ({ Viewer, meshoptAvailable }) => {
				wasm = await meshoptAvailable();
				if (disposed) return;
				instance = new Viewer(canvas);
				instance.onCameraChange = () => {
					if (progress !== null) return;
					const camera = instance!.getCamera();
					// The view a model opens with stays out of the link.
					view.camera = cameraKey(camera) === homeCamera ? null : camera;
				};
				instance.onPick = (part) => select(part);
				viewer = instance;
				if (import.meta.env.DEV) Object.assign(window, { viewer: instance });
			})
			.catch((err: Error) => {
				progress = null;
				error = `Could not start the 3D view: ${err.message}`;
			});
		host.models
			.index()
			.then((data) => (index = data))
			.catch((err: Error) => (error = `Could not load the model list: ${err.message}`));

		const stopRoutes = host.onRoute((route) => {
			if (route === encode(view)) return;
			const next = decode(route);
			const sameModel = next.model === view.model && next.version === view.version;
			view = next;
			if (sameModel && next.camera) viewer?.setCamera(next.camera);
		});
		return () => {
			disposed = true;
			stopRoutes();
			stopTheme();
			instance?.dispose();
		};
	});

	// Load the model whenever the model or version changes. Only the newest request may touch the scene: a load that a
	// quick switch overtook is dropped when its bytes or its parse arrive, and switching back to the model on screen
	// simply drops whatever was loading.
	let request = 0;
	$effect(() => {
		if (!viewer || !current || !key) return;
		const ticket = ++request;
		const live = () => ticket === request;
		if (key === loaded) {
			progress = null;
			error = '';
			parts = viewer.parts;
			return;
		}
		const target = key;
		const version = current.version;
		const title = entry?.title ?? 'the model';
		// Read once and untracked: the camera and the sliders change the view all the time and must not restart the load.
		const wanted = untrack(() => $state.snapshot(view));
		progress = 0;
		error = '';
		parts = null;
		const file = wasm === false ? current.plain : current.glb;
		if (!file) {
			progress = null;
			error = `This host blocks WebAssembly, which the compressed model needs, and v${version} has no uncompressed copy.`;
			return;
		}
		host.models
			.bytes(file, (f) => {
				if (live()) progress = f ?? 0;
			})
			.then((buffer) => (live() ? viewer!.loadBuffer(buffer, live) : null))
			.then((index) => {
				if (!index || !live()) return;
				parts = index;
				loaded = target;
				const stale = [...wanted.hidden, ...wanted.isolated, ...(wanted.selected ? [wanted.selected] : [])].filter((id) => !index.byId.has(id));
				if (stale.length) {
					notice = `${stale.length} part${stale.length > 1 ? 's' : ''} from this link ${stale.length > 1 ? 'are' : 'is'} not in v${version}.`;
					view.hidden = view.hidden.filter((id) => index.byId.has(id));
					view.isolated = view.isolated.filter((id) => index.byId.has(id));
					if (view.selected && !index.byId.has(view.selected)) view.selected = null;
				}
				homeCamera = cameraKey(viewer!.getCamera());
				if (wanted.camera) viewer!.setCamera(wanted.camera);
				progress = null;
				if (!wanted.camera) view.camera = null;
			})
			.catch((err: Error) => {
				if (!live()) return;
				progress = null;
				error = `Could not load ${title}: ${err.message}`;
			});
	});

	// Push view state into the scene.
	$effect(() => {
		if (!viewer || !parts) return;
		applyVisibility(parts, hidden, isolated);
		viewer.requestRender();
	});
	$effect(() => {
		if (viewer && parts) viewer.setCuts($state.snapshot(view.cuts) as Cut[]);
	});
	$effect(() => {
		if (viewer && parts) viewer.setExplode(view.explode);
	});
	$effect(() => {
		if (viewer && parts) viewer.setEdges(view.edges);
	});
	$effect(() => {
		if (viewer && parts) viewer.setOrtho(view.ortho);
	});
	$effect(() => {
		if (viewer && parts) viewer.highlight(selectedPart);
	});
	$effect(() => {
		// The desktop panel is 300 px wide plus a 12 px margin.
		viewer?.setInset(panelOpen && !narrow ? 312 : 0);
	});
	$effect(() => {
		void theme.dark;
		if (!viewer) return;
		const css = getComputedStyle(document.documentElement);
		const token = (name: string) => css.getPropertyValue(name).trim();
		viewer.setPalette({ background: token('--viewport'), edges: token('--edges'), accent: token('--accent'), ground: token('--ground'), measure: token('--measure') });
	});

	// Mirror the view into the route (the URL hash on the web) without adding history entries.
	let routeTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const route = encode(view);
		clearTimeout(routeTimer);
		routeTimer = setTimeout(() => host.publishRoute(route), 250);
	});

	/** A new plane removes the half that faces the camera, so the cut face is in view. */
	function flipFor(axis: Axis) {
		if (!viewer) return false;
		const i = { x: 0, y: 1, z: 2 }[axis];
		const camera = viewer.getCamera();
		return camera.position[i] < camera.target[i];
	}

	function select(part: Part | null) {
		view.selected = part?.id ?? null;
		if (part && narrow) panelOpen = true;
	}
	function toggle(ids: string[], visible: boolean) {
		const set = new Set(view.hidden);
		for (const id of ids) {
			if (visible) set.delete(id);
			else set.add(id);
		}
		view.hidden = [...set];
	}
	function isolate(part: Part) {
		view.isolated = view.isolated.length === 1 && view.isolated[0] === part.id ? [] : [part.id];
		view.hidden = view.hidden.filter((id) => id !== part.id);
	}
	function showAll() {
		view.hidden = [];
		view.isolated = [];
	}
	function switchModel(model: string) {
		if (model === view.model && view.version === null) return;
		view = { ...defaultState(model), edges: view.edges, ortho: view.ortho };
		notice = '';
	}
	/** The share menu's route: pinned to the version on screen, or following the latest. */
	function shareRoute() {
		return encode({ ...view, version: pin ? (current?.version ?? null) : null });
	}
	async function share(link: ShareLink) {
		fallback = null;
		if (await host.copy(link.text)) {
			copied = link.id;
			setTimeout(() => (copied = null), 1600);
		} else {
			fallback = { label: link.label, text: link.text };
		}
	}
	async function openStep(step: StepAction) {
		if (step.open && (await step.open())) return;
		fallback = { label: 'STEP download', text: step.url };
		shareOpen = true;
		sectionOpen = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
		if (e.key === 'Escape') {
			view.selected = null;
			sectionOpen = shareOpen = false;
		}
		if (e.key === 'f') viewer?.fit();
	}
</script>

<svelte:window onkeydown={onKey} />
<svelte:head>
	<title>{entry ? `${entry.title} v${current?.version}` : 'SeedHammer'} · 3D viewer</title>
</svelte:head>

<main class:panel-open={panelOpen}>
	<canvas bind:this={canvas}></canvas>

	<header>
		<div class="brand">
			<span class="mark" aria-hidden="true"></span>
			<nav class="models" aria-label="Model">
				{#each Object.entries(index?.models ?? {}) as [id, model] (id)}
					<button class:on={view.model === id} aria-pressed={view.model === id} onclick={() => switchModel(id)}>{model.title}</button>
				{/each}
			</nav>
			{#if entry && entry.versions.length > 0}
				<select
					class="version"
					aria-label="Version"
					value={view.version ?? 'latest'}
					onchange={(e) => (view.version = e.currentTarget.value === 'latest' ? null : Number(e.currentTarget.value))}
				>
					<option value="latest">v{entry.latest}{narrow ? '' : ' · latest'}</option>
					{#each entry.versions as v (v.version)}
						<option value={v.version}>v{v.version} · {v.built}</option>
					{/each}
				</select>
			{/if}
		</div>
		<div class="actions">
			<div class="pop">
				<button class="pill" onclick={() => ((shareOpen = !shareOpen), (sectionOpen = false), (fallback = null))} aria-expanded={shareOpen}>
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M11.5 8.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" /></svg>
					<span class="label">Share</span>
				</button>
				{#if shareOpen}
					{@const links = host.shareLinks(shareRoute())}
					<div class="menu" role="menu">
						<p>The link keeps parts, cuts, explode and camera.</p>
						{#if current}
							<label class="pin"><input type="checkbox" bind:checked={pin} /> Pin to v{current.version} <small>otherwise always the latest</small></label>
						{/if}
						{#each links as link (link.id)}
							<button role="menuitem" onclick={() => share(link)}>{copied === link.id ? 'Copied' : link.label} <small>{link.hint}</small></button>
						{/each}
						{#if fallback}
							<label class="fallback">
								<small>Copying is not allowed here. {fallback.label}:</small>
								<input type="text" readonly value={fallback.text} onfocus={(e) => e.currentTarget.select()} />
							</label>
						{/if}
					</div>
				{/if}
			</div>
			{#if current}
				{@const step = host.step(current.step)}
				{#if step.download}
					<a class="pill" href={step.url} download title="STEP, {mb(current.step.bytes)} zipped">
						<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16.5h12" /></svg>
						<span class="label">STEP</span>
					</a>
				{:else}
					<button class="pill" onclick={() => openStep(step)} title="STEP, {mb(current.step.bytes)} zipped">
						<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16.5h12" /></svg>
						<span class="label">STEP</span>
					</button>
				{/if}
			{/if}
		</div>
	</header>

	{#if panelOpen}
		<aside class="panel" aria-label="Parts">
			<div class="panel-head">
				<h2>Parts</h2>
				{#if view.hidden.length || view.isolated.length}
					<button class="link" onclick={showAll}>Show all</button>
				{/if}
				{#if narrow}
					<button class="link" onclick={() => (panelOpen = false)}>Close</button>
				{/if}
			</div>
			{#if selectedPart}
				<div class="selection">
					<div class="sel-name">{selectedPart.name}</div>
					{#if selectedPart.component && selectedPart.component !== selectedPart.name}
						<div class="sel-meta">{selectedPart.component}</div>
					{/if}
					<div class="sel-actions">
						<button onclick={() => isolate(selectedPart!)}>{view.isolated.includes(selectedPart.id) ? 'Show everything' : 'Show only'}</button>
						<button onclick={() => toggle([selectedPart!.id], hidden.has(selectedPart!.id))}>{hidden.has(selectedPart.id) ? 'Show' : 'Hide'}</button>
						<button onclick={() => (view.selected = null)}>Deselect</button>
					</div>
				</div>
			{/if}
			{#if parts}
				<PartTree roots={parts.roots} {hidden} {isolated} selected={view.selected} onToggle={toggle} onSelect={select} onIsolate={isolate} />
			{/if}
		</aside>
	{/if}

	<div class="dock">
		{#if sectionOpen}
			<div class="card">
				<SectionPanel cuts={view.cuts} {range} {flipFor} onChange={(cuts) => (view.cuts = cuts)} />
			</div>
		{/if}
		<div class="toolbar" role="toolbar" aria-label="View">
			<button class="tool" class:on={panelOpen} onclick={() => (panelOpen = !panelOpen)} aria-pressed={panelOpen} title="Parts">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h11M9 15h8" /></svg>
				<span>Parts</span>
			</button>
			<span class="sep"></span>
			<button class="tool" onclick={() => viewer?.fit()} title="Fit (F)">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /></svg>
				<span>Fit</span>
			</button>
			<div class="views">
				{#each [['iso', 'Iso'], ['front', 'Front'], ['top', 'Top'], ['right', 'Right']] as [name, label] (name)}
					<button class="tool small" onclick={() => viewer?.fit(name as NamedView)}>{label}</button>
				{/each}
			</div>
			<button class="tool small" class:on={view.ortho} onclick={() => (view.ortho = !view.ortho)} aria-pressed={view.ortho} title="Orthographic">Ortho</button>
			<button class="tool small" class:on={view.edges} onclick={() => (view.edges = !view.edges)} aria-pressed={view.edges} title="Edge lines">Edges</button>
			<span class="sep"></span>
			<button class="tool" class:on={sectionOpen || view.cuts.length > 0} onclick={() => ((sectionOpen = !sectionOpen), (shareOpen = false))} aria-expanded={sectionOpen} title="Section">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5Z" /><path d="M3 10h14" stroke-dasharray="2 2" /></svg>
				<span>Section{view.cuts.length ? ` ${view.cuts.length}` : ''}</span>
			</button>
			<label class="explode" title="Explode">
				<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7.5" y="7.5" width="5" height="5" rx="1" /><path d="M4 4l2 2M16 4l-2 2M4 16l2-2M16 16l-2-2" /></svg>
				<input type="range" min="0" max="1" step="0.01" bind:value={view.explode} aria-label="Explode" />
			</label>
		</div>
	</div>

	{#if progress !== null && !error}
		<div class="loading" role="status">
			<div class="bar"><div style:width="{Math.round((progress ?? 0) * 100)}%"></div></div>
			<span>Loading {entry?.title ?? ''}{current ? ` v${current.version} · ${mb(current.glb.bytes)}` : ''}</span>
		</div>
	{/if}
	{#if error}
		<p class="toast error" role="alert">{error}</p>
	{:else if notice}
		<p class="toast" role="status">{notice} <button class="link" onclick={() => (notice = '')}>OK</button></p>
	{/if}
</main>

<style>
	main {
		position: fixed;
		inset: 0;
		overflow: hidden;
	}
	canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
		outline: none;
	}
	button,
	select,
	a.pill {
		font: inherit;
		color: var(--text);
	}
	button:focus-visible,
	select:focus-visible,
	a:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		flex: none;
	}
	.brand,
	.pill,
	.panel,
	.toolbar,
	.card,
	.menu,
	.toast,
	.loading {
		background: var(--surface);
		border: 1px solid var(--line);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		box-shadow: var(--shadow);
	}

	/* header */
	header {
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 12px);
		left: max(12px, env(safe-area-inset-left, 0px));
		right: max(12px, env(safe-area-inset-right, 0px));
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 8px;
		pointer-events: none;
		z-index: 3;
	}
	header > * {
		pointer-events: auto;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 6px;
		border-radius: 12px;
		padding: 4px;
		min-width: 0;
	}
	.mark {
		width: 22px;
		height: 22px;
		margin: 0 4px 0 6px;
		border-radius: 6px;
		background: linear-gradient(135deg, #f5a623, var(--accent) 55%, #d0321b);
		flex: none;
	}
	.models {
		display: flex;
		gap: 2px;
	}
	.models button {
		border: 0;
		background: none;
		padding: 6px 10px;
		border-radius: 8px;
		font-weight: 600;
		font-size: 13px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
		cursor: pointer;
		white-space: nowrap;
	}
	.models button.on {
		color: var(--text);
		background: var(--hover);
	}
	.version {
		border: 0;
		background: none;
		color: var(--muted);
		padding: 6px 4px;
		border-radius: 8px;
		cursor: pointer;
		font-variant-numeric: tabular-nums;
		min-width: 0;
		max-width: 150px;
	}
	.actions {
		display: flex;
		gap: 6px;
		flex: none;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 38px;
		padding: 0 12px;
		border-radius: 12px;
		cursor: pointer;
		text-decoration: none;
	}
	.pop {
		position: relative;
	}
	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		width: 280px;
		border-radius: 12px;
		padding: 6px;
		display: grid;
		gap: 2px;
	}
	.menu p {
		margin: 6px 8px 8px;
		color: var(--muted);
		font-size: 12px;
	}
	.menu button {
		text-align: left;
		border: 0;
		background: none;
		border-radius: 8px;
		padding: 8px;
		cursor: pointer;
		font-weight: 500;
	}
	.menu button:hover {
		background: var(--hover);
	}
	.menu small {
		display: block;
		color: var(--muted);
		font-weight: 400;
	}
	.pin {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 8px;
		align-items: center;
		padding: 6px 8px;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 500;
	}
	.pin input {
		grid-row: span 2;
		accent-color: var(--accent);
		margin: 0;
	}
	.fallback {
		display: grid;
		gap: 4px;
		padding: 6px 8px 8px;
	}
	.fallback input {
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--field);
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		padding: 6px 8px;
		width: 100%;
		box-sizing: border-box;
	}

	/* parts panel */
	.panel {
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 64px);
		left: max(12px, env(safe-area-inset-left, 0px));
		bottom: calc(env(safe-area-inset-bottom, 0px) + 76px);
		width: 300px;
		border-radius: 14px;
		display: flex;
		flex-direction: column;
		z-index: 2;
		overflow: hidden;
	}
	.panel-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px 8px;
	}
	h2 {
		font-size: 13px;
		font-weight: 600;
		margin: 0 auto 0 0;
		letter-spacing: 0.02em;
	}
	.link {
		border: 0;
		background: none;
		color: var(--accent-text);
		cursor: pointer;
		padding: 2px 4px;
		font-size: 13px;
	}
	.selection {
		margin: 0 12px 10px;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--accent-soft);
	}
	.sel-name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.sel-meta {
		color: var(--muted);
		font-size: 12px;
		margin-top: 2px;
		overflow-wrap: anywhere;
	}
	.sel-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.sel-actions button {
		border: 1px solid var(--line);
		background: var(--surface-solid);
		border-radius: 8px;
		padding: 4px 10px;
		font-size: 12px;
		cursor: pointer;
	}

	/* bottom dock */
	.dock {
		position: absolute;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		max-width: calc(100% - 24px);
		z-index: 3;
	}
	main.panel-open .dock {
		left: calc(50% + 156px);
		max-width: calc(100% - 336px);
	}
	.card {
		border-radius: 14px;
		padding: 12px;
		width: min(380px, calc(100vw - 24px));
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px;
		border-radius: 14px;
		max-width: 100%;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tool {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 36px;
		padding: 0 10px;
		border: 0;
		border-radius: 10px;
		background: none;
		cursor: pointer;
		white-space: nowrap;
		flex: none;
	}
	.tool:hover {
		background: var(--hover);
	}
	.tool.on {
		color: var(--accent-text);
		background: var(--accent-soft);
	}
	.tool.small {
		padding: 0 8px;
		font-size: 13px;
	}
	.views {
		display: flex;
		gap: 2px;
	}
	.sep {
		width: 1px;
		height: 22px;
		background: var(--line);
		margin: 0 4px;
		flex: none;
	}
	.explode {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px 0 8px;
		color: var(--text);
		flex: none;
	}
	.explode input {
		width: 110px;
		accent-color: var(--accent);
	}

	/* status */
	.loading {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		border-radius: 12px;
		padding: 14px 18px;
		display: grid;
		gap: 10px;
		justify-items: center;
		color: var(--muted);
		z-index: 4;
	}
	.bar {
		width: 200px;
		height: 3px;
		border-radius: 2px;
		background: var(--line);
		overflow: hidden;
	}
	.bar div {
		height: 100%;
		background: var(--accent);
		transition: width 0.15s;
	}
	.toast {
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 64px);
		left: 50%;
		transform: translateX(-50%);
		margin: 0;
		border-radius: 10px;
		padding: 8px 12px;
		z-index: 4;
		max-width: calc(100% - 24px);
	}
	.toast.error {
		color: #d0321b;
	}

	/* phones: the parts panel becomes a bottom sheet above the dock */
	@media (max-width: 760px) {
		.label,
		.views,
		.tool span {
			display: none;
		}
		.pill {
			width: 38px;
			padding: 0;
			justify-content: center;
		}
		.panel {
			top: auto;
			left: 8px;
			right: 8px;
			bottom: calc(env(safe-area-inset-bottom, 0px) + 68px);
			width: auto;
			height: 55dvh;
		}
		main.panel-open .dock {
			left: 50%;
			max-width: calc(100% - 16px);
		}
		.explode input {
			width: 90px;
		}
	}
	@media (max-width: 480px) {
		.mark {
			display: none;
		}
		.brand {
			gap: 2px;
		}
		.models button {
			padding: 6px 7px;
		}
		.version {
			max-width: 64px;
		}
		.actions {
			gap: 4px;
		}
		.pill {
			width: 34px;
			height: 34px;
		}
		.explode input {
			width: 64px;
		}
		.tool {
			padding: 0 8px;
		}
	}
</style>
