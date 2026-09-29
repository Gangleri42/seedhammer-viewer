<script lang="ts">
	import type { Axis, Cut } from '$lib/state/hash';

	type Props = {
		cuts: Cut[];
		/** Model extent per axis, mm. */
		range: Record<Axis, [number, number]>;
		/** Whether the camera looks from the negative side of an axis: then the plane keeps the positive half. */
		flipFor: (axis: Axis) => boolean;
		onChange: (cuts: Cut[]) => void;
	};
	let { cuts, range, flipFor, onChange }: Props = $props();

	const AXES: Axis[] = ['x', 'y', 'z'];
	const round = (v: number) => Math.round(v * 10) / 10;
	const centre = (axis: Axis) => round((range[axis][0] + range[axis][1]) / 2);

	function update(i: number, patch: Partial<Cut>) {
		onChange(cuts.map((c, j) => (j === i ? { ...c, ...patch } : c)));
	}
	function add() {
		const axis = AXES.find((a) => !cuts.some((c) => c.axis === a)) ?? 'x';
		onChange([...cuts, { axis, offset: centre(axis), flip: flipFor(axis) }]);
	}
</script>

<div class="section">
	{#each cuts as cut, i (i)}
		<div class="plane">
			<div class="head">
				<div class="axes" role="radiogroup" aria-label="Plane {i + 1} axis">
					{#each AXES as axis (axis)}
						<button
							role="radio"
							aria-checked={cut.axis === axis}
							class:on={cut.axis === axis}
							onclick={() => cut.axis !== axis && update(i, { axis, offset: centre(axis), flip: flipFor(axis) })}
						>{axis.toUpperCase()}</button>
					{/each}
				</div>
				<label class="value">
					<input
						type="number"
						step="0.1"
						value={cut.offset}
						onchange={(e) => update(i, { offset: round(Number(e.currentTarget.value) || 0) })}
						aria-label="Plane {i + 1} position in millimetres"
					/>
					<span>mm</span>
				</label>
				<button class="text" class:on={cut.flip} onclick={() => update(i, { flip: !cut.flip })} title="Keep the other side" aria-pressed={cut.flip}>
					Flip
				</button>
				<button class="text remove" onclick={() => onChange(cuts.filter((_, j) => j !== i))} aria-label="Remove plane {i + 1}" title="Remove">
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
				</button>
			</div>
			<input
				class="slider"
				type="range"
				min={Math.floor(range[cut.axis][0]) - 1}
				max={Math.ceil(range[cut.axis][1]) + 1}
				step="0.1"
				value={cut.offset}
				oninput={(e) => update(i, { offset: round(Number(e.currentTarget.value)) })}
				aria-label="Plane {i + 1} position"
			/>
		</div>
	{/each}
	{#if cuts.length < 3}
		<button class="add" onclick={add}>{cuts.length ? 'Add plane' : 'Add section plane'}</button>
	{/if}
</div>

<style>
	.section {
		display: grid;
		gap: 10px;
	}
	.plane {
		display: grid;
		gap: 6px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.axes {
		display: flex;
		background: var(--field);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 2px;
	}
	.axes button {
		font: inherit;
		font-weight: 600;
		font-size: 12px;
		width: 28px;
		height: 24px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.axes button.on {
		background: var(--accent);
		color: #fff;
	}
	.value {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--muted);
		font-size: 12px;
		margin-left: auto;
	}
	.value input {
		font: inherit;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		width: 64px;
		text-align: right;
		color: var(--text);
		background: var(--field);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 4px 6px;
	}
	.text {
		font: inherit;
		font-size: 12px;
		height: 28px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--field);
		color: var(--text);
		cursor: pointer;
	}
	.text.on {
		border-color: var(--accent);
		color: var(--accent-text);
	}
	.remove {
		width: 28px;
		padding: 0;
		display: grid;
		place-items: center;
	}
	.remove svg {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}
	.slider {
		width: 100%;
		accent-color: var(--accent);
	}
	.add {
		font: inherit;
		padding: 8px;
		border: 1px dashed var(--line-strong);
		border-radius: 8px;
		background: none;
		color: var(--text);
		cursor: pointer;
	}
	.add:hover {
		border-color: var(--accent);
	}
	button:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
