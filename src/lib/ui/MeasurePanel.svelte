<script lang="ts">
	import type { Row } from '$lib/measure/types';
	import { formatRow } from '$lib/measure/units';
	import type { MeasureRef } from '$lib/state/hash';
	import type { MeasureStatus, Outcome } from '$lib/viewer/measure/tool';

	type Props = {
		outcome: Outcome | null;
		status: MeasureStatus;
		/** 0..1 while the measurement file loads; null when the size is unknown. */
		progress: number | null;
		error: string;
		version: number | null;
		snapping: boolean;
		precision: number;
		touch: boolean;
		onSnapping: (on: boolean) => void;
		onPrecision: (decimals: number) => void;
		onRemove: (ref: MeasureRef) => void;
		onSwap: (from: MeasureRef, to: MeasureRef) => void;
		onClear: () => void;
		onClose: () => void;
		onRetry: () => void;
		onFocus: (key: string | null) => void;
		onCopy: (text: string) => Promise<boolean>;
	};
	let { outcome, status, progress, error, version, snapping, precision, touch, onSnapping, onPrecision, onRemove, onSwap, onClear, onClose, onRetry, onFocus, onCopy }: Props = $props();

	const PRECISIONS = [1, 2, 3, 4];
	let copied = $state<string | null>(null);
	const selections = $derived(outcome?.selections ?? []);
	const approx = $derived([...(outcome?.rows ?? []), ...selections.flatMap((s) => s.rows)].some((r) => !r.exact));

	async function copy(id: string, row: Row) {
		if (!(await onCopy(formatRow(row, precision).replace(/^≈ /, '')))) return;
		copied = id;
		setTimeout(() => {
			if (copied === id) copied = null;
		}, 1400);
	}
</script>

{#snippet rows(list: Row[], prefix: string)}
	<dl class="rows">
		{#each list as row, i (`${prefix}${row.key}${i}`)}
			{@const id = `${prefix}${row.key}${i}`}
			<div class="row">
				<dt>{row.label}</dt>
				<dd>
					<button
						class="value"
						class:approx={!row.exact}
						onclick={() => copy(id, row)}
						onmouseenter={() => onFocus(row.key)}
						onmouseleave={() => onFocus(null)}
						onfocus={() => onFocus(row.key)}
						onblur={() => onFocus(null)}
						title="Copy"
					>{copied === id ? 'Copied' : formatRow(row, precision)}</button>
				</dd>
			</div>
		{/each}
	</dl>
{/snippet}

<section class="measure" aria-label="Measure">
	<div class="head">
		<h2>Measure</h2>
		<label class="snap" title="Snap to centres, midpoints and ends">
			<input type="checkbox" checked={snapping} onchange={(e) => onSnapping(e.currentTarget.checked)} />
			Snap
		</label>
		<select aria-label="Precision" value={precision} onchange={(e) => onPrecision(Number(e.currentTarget.value))}>
			{#each PRECISIONS as decimals (decimals)}
				<option value={decimals}>{(0.1234).toFixed(decimals)}</option>
			{/each}
		</select>
		<button class="link" onclick={onClear} disabled={!selections.length}>Clear</button>
		<button class="close" onclick={onClose} aria-label="Close Measure" title="Close (Esc)">
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
		</button>
	</div>

	{#if status === 'loading'}
		<div class="status" role="status">
			<div class="bar"><div style:width="{Math.round((progress ?? 0) * 100)}%"></div></div>
			Loading the exact geometry…
		</div>
	{:else if status === 'error'}
		<p class="status error" role="alert">{error} <button class="link" onclick={onRetry}>Retry</button></p>
	{:else if status === 'unavailable'}
		<p class="status">Measuring is not available for v{version}.</p>
	{/if}

	<div aria-live="polite">
		{#each selections as selection, i (`${selection.ref.part}.${selection.ref.kind}${selection.ref.index}`)}
			<div class="selection">
				<div class="title">
					<span class="badge">{i + 1}</span>
					<div class="names">
						<strong>{selection.title}</strong>
						<small>{selection.part}{selection.hidden ? ' · hidden' : ''}</small>
					</div>
					{#if selection.alternate}
						{@const to = selection.alternate}
						<button class="swap" onclick={() => onSwap(selection.ref, to)} title={to.kind === 'c' ? 'Measure from its centre' : 'Measure the circle itself'}>
							{to.kind === 'c' ? 'Centre' : 'Circle'}
						</button>
					{/if}
					<button class="close" onclick={() => onRemove(selection.ref)} aria-label="Remove selection {i + 1}">
						<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
					</button>
				</div>
				{#if selection.rows.length}{@render rows(selection.rows, `s${i}`)}{/if}
			</div>
		{/each}

		{#if outcome?.rows.length}
			<div class="results">{@render rows(outcome.rows, 'r')}</div>
		{/if}
	</div>

	{#if selections.length < 2 && status !== 'unavailable'}
		<p class="hint">
			{#if touch}
				Tap a face, an edge or a point{selections.length ? ' to measure to' : ''}. A circle's Centre button measures from its centre.
			{:else}
				Click a face, an edge or a point{selections.length ? ' to measure to' : ''}. Hold ⌘/Ctrl for centres, midpoints and ends; Shift hides them.
			{/if}
		</p>
	{/if}
	{#if approx}
		<p class="hint">≈ is measured on the displayed mesh, within a few hundredths of a millimetre.</p>
	{/if}
</section>

<style>
	.measure {
		display: grid;
		gap: 10px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	h2 {
		font-size: 13px;
		font-weight: 600;
		margin: 0 auto 0 0;
		letter-spacing: 0.02em;
	}
	.snap {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--muted);
		cursor: pointer;
	}
	.snap input {
		margin: 0;
		accent-color: var(--measure);
	}
	select {
		font: inherit;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		background: var(--field);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 2px 4px;
	}
	.link {
		font: inherit;
		font-size: 12px;
		border: 0;
		background: none;
		color: var(--measure-text);
		cursor: pointer;
		padding: 2px 4px;
	}
	.link:disabled {
		color: var(--muted);
		cursor: default;
	}
	.close {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--muted);
		cursor: pointer;
		flex: none;
	}
	.close:hover {
		background: var(--hover);
		color: var(--text);
	}
	.close svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}
	.status {
		display: grid;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.status.error {
		display: block;
		color: #d0321b;
	}
	.bar {
		height: 3px;
		border-radius: 2px;
		background: var(--line);
		overflow: hidden;
	}
	.bar div {
		height: 100%;
		background: var(--measure);
		transition: width 0.15s;
	}
	.selection {
		display: grid;
		gap: 4px;
		padding: 8px 10px;
		margin-bottom: 8px;
		border-radius: 10px;
		background: var(--measure-soft);
	}
	.title {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.badge {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		flex: none;
		font-size: 11px;
		font-weight: 700;
		color: #fff;
		background: var(--measure);
	}
	.names {
		display: grid;
		min-width: 0;
		margin-right: auto;
	}
	.names strong {
		font-weight: 600;
		font-size: 13px;
	}
	.names small {
		color: var(--muted);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.swap {
		font: inherit;
		font-size: 12px;
		padding: 2px 8px;
		border: 1px solid var(--measure);
		border-radius: 999px;
		background: var(--surface-solid);
		color: var(--measure-text);
		cursor: pointer;
		flex: none;
	}
	.rows {
		display: grid;
		gap: 0;
		margin: 0;
	}
	.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		font-size: 13px;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
	}
	.value {
		font: inherit;
		font-variant-numeric: tabular-nums;
		border: 0;
		background: none;
		color: var(--text);
		padding: 1px 4px;
		border-radius: 4px;
		cursor: copy;
	}
	.value:hover {
		background: var(--hover);
	}
	.value.approx {
		color: var(--muted);
	}
	.results {
		padding: 6px 10px;
		border: 1px solid var(--measure);
		border-radius: 10px;
	}
	.results .row {
		font-size: 14px;
	}
	.results .value {
		font-weight: 600;
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	button:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--measure);
		outline-offset: 1px;
	}
</style>
