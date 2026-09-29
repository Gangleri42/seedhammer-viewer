// The viewer inside a NIP-5D shell. There is no URL: routes come in as intents and go out as share links; files come
// from the artefact or from the shell; the shell opens external links and reports its theme.
import { blobUrl } from '$lib/models/blossom';
import { nappletModels, type NappletModelOptions } from '$lib/models/napplet-source';
import type { ModelFile } from '$lib/models/types';
import { conventionUri } from '$lib/state/route';
import { isDarkColor, systemTheme, type ThemeInfo, type ThemeSource } from '$lib/theme.svelte';
import { copyText } from './copy';
import type { Host, ShareLink } from './host';
import { inbox } from './napplet-inbox';
import { close, has, type ShellTheme } from './napplet-runtime';

const HEX = /^#[0-9a-f]{6}$/i;

/** The shell's colours when it has them, the system scheme meanwhile and otherwise. */
export const shellTheme: ThemeSource = {
	watch(apply) {
		const stopSystem = systemTheme.watch(apply);
		const shell = has('theme', 'get', 'onChanged');
		if (!shell) return stopSystem;
		const fromShell = (theme: ShellTheme | undefined) => {
			const colors = theme?.colors;
			if (!colors?.background || !HEX.test(colors.background)) return;
			const info: ThemeInfo = { dark: isDarkColor(colors.background), colors };
			apply(info);
		};
		shell.get().then(fromShell, () => undefined);
		const handle = shell.onChanged(fromShell);
		return () => {
			stopSystem();
			close(handle);
		};
	}
};

export type NappletHostOptions = NappletModelOptions & {
	/** Where the web viewer lives; share links point there. */
	shareOrigin: string;
	/** The site on a Nostr gateway, when the identity that publishes it is known at build time. */
	nsiteOrigin?: string | null;
};

export function createNappletHost(options: NappletHostOptions): Host {
	const { shareOrigin, nsiteOrigin, servers } = options;
	return {
		initialRoute: () => inbox.latest ?? '',
		onRoute: (listener) => inbox.subscribe(listener),
		// The shell owns the address bar; the route only leaves through share links and intents.
		publishRoute() {},
		models: nappletModels(options),
		theme: shellTheme,
		shareLinks(route): ShareLink[] {
			const links: ShareLink[] = [{ id: 'web', label: 'Copy link', hint: 'the web viewer', text: `${shareOrigin}/${route}` }];
			if (nsiteOrigin) links.push({ id: 'nsite', label: 'Copy nsite link', hint: 'the same site on a Nostr gateway', text: `${nsiteOrigin}/${route}` });
			links.push({ id: 'intent', label: 'Copy intent', hint: 'opens this view in a napplet shell', text: conventionUri(route) });
			return links;
		},
		copy: copyText,
		step(file: ModelFile) {
			const url = blobUrl(servers[0], file.sha256, 'zip');
			return {
				url,
				download: false,
				async open() {
					const link = has('link', 'open');
					if (!link) return false;
					try {
						const result = await link.open(url, { label: 'Download the STEP file' });
						return result?.status !== 'denied';
					} catch {
						return false;
					}
				}
			};
		}
	};
}
