<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { Part } from '$lib/viewer/parts';

	type Props = {
		roots: Part[];
		hidden: Set<string>;
		isolated: Set<string>;
		selected: string | null;
		onToggle: (ids: string[], visible: boolean) => void;
		onSelect: (part: Part) => void;
		onIsolate: (part: Part) => void;
	};
	let { roots, hidden, isolated, selected, onToggle, onSelect, onIsolate }: Props = $props();

	let query = $state('');
	const expanded = new SvelteSet<string>();

	/** Rows at one level: plain parts, plus loose fasteners folded into one group when there are many. */
	type Group = { group: true; key: string; parts: Part[] };
	function rows(parts: Part[]): (Part | Group)[] {
		const fasteners = parts.filter((p) => p.fastener);
		if (fasteners.length < 4) return parts;
		const key = `f:${parts[0].parent?.id ?? 'root'}`;
		return [...parts.filter((p) => !fasteners.includes(p)), { group: true, key, parts: fasteners }];
	}

	const all = $derived.by(() => {
		const list: Part[] = [];
		const walk = (parts: Part[]) => parts.forEach((p) => (list.push(p), walk(p.children)));
		walk(roots);
		return list;
	});
	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return null;
		return all.filter((p) => p.name.toLowerCase().includes(q) || p.component?.toLowerCase().includes(q)).slice(0, 200);
	});

	const off = (part: Part) => hidden.has(part.id);
	/** Hidden by an ancestor or outside the isolated set. */
	function dimmed(part: Part) {
		for (let p = part.parent; p; p = p.parent) if (hidden.has(p.id)) return true;
		if (!isolated.size) return false;
		const inside = (q: Part | null): boolean => !!q && (isolated.has(q.id) || inside(q.parent));
		const contains = (q: Part): boolean => isolated.has(q.id) || q.children.some(contains);
		return !inside(part) && !contains(part);
	}
	const breadcrumb = (part: Part) => {
		const names: string[] = [];
		for (let p = part.parent; p; p = p.parent) names.unshift(p.name);
		return names.join(' › ');
	};

	// Reveal the selected part: expand its ancestors and scroll it into view.
	$effect(() => {
		if (!selected) return;
		const part = all.find((p) => p.id === selected);
		for (let p = part?.parent; p; p = p.parent) expanded.add(p.id);
		requestAnimationFrame(() => document.getElementById(`row-${selected}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
	});
</script>

{#snippet eye(visible: boolean, onclick: () => void, label: string)}
	<button class="icon eye" class:off={!visible} {onclick} aria-label={label} title={label}>
		{#if visible}
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6Z" /><circle cx="10" cy="10" r="2.6" /></svg>
		{:else}
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3l14 14M8 4.3A8.7 8.7 0 0 1 10 4c5 0 8.5 6 8.5 6a15 15 0 0 1-2.6 3.3M5.2 6.2A15 15 0 0 0 1.5 10S5 16 10 16a8 8 0 0 0 3.6-.9" /></svg>
		{/if}
	</button>
{/snippet}

{#snippet row(part: Part)}
	{@const open = expanded.has(part.id)}
	<li>
		<div
			class="row"
			id="row-{part.id}"
			class:selected={selected === part.id}
			class:dim={off(part) || dimmed(part)}
			style:--depth={part.depth}
		>
			{#if part.children.length}
				<button class="icon caret" class:open onclick={() => (open ? expanded.delete(part.id) : expanded.add(part.id))} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5" /></svg>
				</button>
			{:else}
				<span class="icon spacer"></span>
			{/if}
			{@render eye(!off(part), () => onToggle([part.id], off(part)), off(part) ? `Show ${part.name}` : `Hide ${part.name}`)}
			<button class="name" onclick={() => onSelect(part)} title={part.component ?? part.name}>{part.name}</button>
			<button class="icon isolate" onclick={() => onIsolate(part)} aria-label="Show only {part.name}" title="Show only this">
				<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4" /></svg>
			</button>
		</div>
		{#if open}
			<ul>{@render level(part.children)}</ul>
		{/if}
	</li>
{/snippet}

{#snippet level(parts: Part[])}
	{#each rows(parts) as item ('group' in item ? item.key : item.id)}
		{#if 'group' in item}
			{@const open = expanded.has(item.key)}
			{@const visible = item.parts.some((p) => !off(p))}
			<li>
				<div class="row group" style:--depth={item.parts[0].depth}>
					<button class="icon caret" class:open onclick={() => (open ? expanded.delete(item.key) : expanded.add(item.key))} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
						<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5" /></svg>
					</button>
					{@render eye(visible, () => onToggle(item.parts.map((p) => p.id), !visible), visible ? 'Hide fasteners' : 'Show fasteners')}
					<button class="name" onclick={() => (open ? expanded.delete(item.key) : expanded.add(item.key))}>Fasteners <span class="count">{item.parts.length}</span></button>
				</div>
				{#if open}
					<ul>{#each item.parts as part (part.id)}{@render row(part)}{/each}</ul>
				{/if}
			</li>
		{:else}
			{@render row(item)}
		{/if}
	{/each}
{/snippet}

<div class="tree">
	<input class="search" type="search" placeholder="Search parts" bind:value={query} aria-label="Search parts" />
	{#if matches}
		<ul class="results">
			{#each matches as part (part.id)}
				<li>
					<div class="row" id="row-{part.id}" class:selected={selected === part.id} class:dim={off(part) || dimmed(part)} style:--depth={0}>
						{@render eye(!off(part), () => onToggle([part.id], off(part)), off(part) ? `Show ${part.name}` : `Hide ${part.name}`)}
						<button class="name" onclick={() => onSelect(part)}>
							{part.name}
							{#if part.parent}<small>{breadcrumb(part)}</small>{/if}
						</button>
						<button class="icon isolate" onclick={() => onIsolate(part)} aria-label="Show only {part.name}" title="Show only this">
							<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4" /></svg>
						</button>
					</div>
				</li>
			{:else}
				<li class="empty">No part matches “{query}”.</li>
			{/each}
		</ul>
	{:else}
		<ul class="list">{@render level(roots)}</ul>
	{/if}
</div>

<style>
	.tree {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}
	.search {
		font: inherit;
		color: var(--text);
		background: var(--field);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 7px 10px;
		margin: 0 12px 8px;
		outline: none;
	}
	.search:focus-visible {
		border-color: var(--accent);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.list,
	.results {
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 6px 12px;
		flex: 1;
		min-height: 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 2px;
		padding-left: calc(var(--depth) * 14px);
		border-radius: 6px;
		min-height: 30px;
	}
	.row:hover {
		background: var(--hover);
	}
	.row.selected {
		background: var(--accent-soft);
	}
	.row.selected .name {
		color: var(--accent-text);
	}
	.row.dim .name {
		opacity: 0.45;
	}
	.name {
		flex: 1;
		min-width: 0;
		text-align: left;
		font: inherit;
		color: var(--text);
		background: none;
		border: 0;
		padding: 5px 4px;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.name small {
		display: block;
		color: var(--muted);
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.count {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		margin-left: 4px;
	}
	.icon {
		flex: none;
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		background: none;
		border: 0;
		border-radius: 6px;
		color: var(--muted);
		cursor: pointer;
		padding: 0;
	}
	.icon:hover {
		color: var(--text);
	}
	.icon svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.caret svg {
		transition: transform 0.15s;
	}
	.caret.open svg {
		transform: rotate(90deg);
	}
	.eye.off {
		opacity: 0.6;
	}
	.isolate {
		opacity: 0;
	}
	.row:hover .isolate,
	.isolate:focus-visible {
		opacity: 1;
	}
	@media (hover: none) {
		.isolate {
			opacity: 0.7;
		}
	}
	.spacer {
		cursor: default;
	}
	.empty {
		color: var(--muted);
		padding: 12px;
	}
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
</style>
