// What the viewer needs from wherever it runs. A plain web page (GitHub Pages, an nsite gateway) has a URL, same-origin
// files and a clipboard; a napplet sandbox has none of those and talks to its shell instead. Everything environment-
// specific goes through this seam so the app itself stays one component tree.
import type { ModelFile, ModelIndex } from '$lib/models/types';
import type { ThemeSource } from '$lib/theme.svelte';

export interface ModelSource {
	index(): Promise<ModelIndex>;
	/** A model file's bytes, verified where the transport does not do it. `onProgress(null)` means the total is unknown. */
	bytes(file: ModelFile, onProgress?: (fraction: number | null) => void): Promise<ArrayBuffer>;
}

export type ShareLink = {
	id: 'web' | 'nsite' | 'intent';
	label: string;
	/** What the link is for, shown small under the label. */
	hint: string;
	text: string;
};

/** How to get the zipped STEP: a plain download link, or an action the environment performs. */
export type StepAction = { url: string; download: boolean; open?: () => Promise<boolean> };

export interface Host {
	/** The route to open with, in the hash grammar: "#/hammer@41?cut=x:12.5". Empty for the default view. */
	initialRoute(): string;
	/** Routes that arrive later (a hash change, an intent from the shell). Returns the unsubscribe. */
	onRoute(listener: (route: string) => void): () => void;
	/** The view changed; the environment may mirror it, for example into the URL hash. */
	publishRoute(route: string): void;
	models: ModelSource;
	theme: ThemeSource;
	shareLinks(route: string): ShareLink[];
	/** Puts text on the clipboard. False when the environment does not allow it. */
	copy(text: string): Promise<boolean>;
	step(file: ModelFile): StepAction;
}
