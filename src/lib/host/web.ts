// The viewer on a plain web page: the route lives in location.hash, files are fetched next to the page.
import { webModels } from '$lib/models/web-source';
import type { ModelFile } from '$lib/models/types';
import { systemTheme } from '$lib/theme.svelte';
import { copyText } from './copy';
import type { Host, ShareLink } from './host';

export function createWebHost(base: string): Host {
	return {
		initialRoute: () => location.hash,
		onRoute(listener) {
			const onHash = () => listener(location.hash);
			addEventListener('hashchange', onHash);
			return () => removeEventListener('hashchange', onHash);
		},
		publishRoute(route) {
			// replaceState: moving the camera must not pile up history entries.
			if (location.hash !== route) history.replaceState(history.state, '', route);
		},
		models: webModels(base),
		theme: systemTheme,
		shareLinks(route): ShareLink[] {
			return [{ id: 'web', label: 'Copy link', hint: 'opens this view here', text: `${location.origin}${location.pathname}${route}` }];
		},
		copy: copyText,
		step: (file: ModelFile) => ({ url: `${base}/models/${file.path}`, download: true })
	};
}
