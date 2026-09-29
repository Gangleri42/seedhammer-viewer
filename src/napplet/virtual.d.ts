// Build-time data the napplet Vite config generates (see vite.napplet.config.ts).
declare module 'virtual:seedhammer-models' {
	import type { ModelIndex } from '$lib/models/types';
	export const index: ModelIndex;
	/** The latest GLB and measurement file of each model, base64, by sha256. */
	export const inline: Record<string, string>;
	export const servers: string[];
	export const shareOrigin: string;
	export const nsiteOrigin: string | null;
}
