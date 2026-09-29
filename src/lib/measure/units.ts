// How measured values read. Kept apart from the math so the panel can format without loading three.js.
import type { Row, Unit } from './types';

/** "12.35 mm", "314.16 mm²", "135.00°"; "≈ 0.12 mm" when the value is only as good as the displayed mesh. */
export function formatValue(value: number, unit: Unit, decimals: number, exact = true) {
	// Anything that rounds to zero shows as zero, never as "-0.00".
	const shown = Math.abs(value) < 10 ** -decimals / 2 ? 0 : value;
	const text = `${shown.toFixed(decimals)}${unit === '°' ? '°' : ` ${unit}`}`;
	return exact ? text : `≈ ${text}`;
}

export const formatRow = (row: Row, decimals: number) => formatValue(row.value, row.unit, decimals, row.exact);
