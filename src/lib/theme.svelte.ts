/** Light or dark, plus the shell's own colours when it has any. The 3D view reads `dark` to repaint when it flips. */
export type ThemeInfo = { dark: boolean; colors?: { background?: string; text?: string; primary?: string } };

export interface ThemeSource {
	/** Reports the theme now and on every change. Returns the unsubscribe. */
	watch(apply: (theme: ThemeInfo) => void): () => void;
}

const HEX = /^#[0-9a-f]{6}$/i;

class Theme {
	dark = $state(false);

	init(source: ThemeSource) {
		return source.watch((info) => {
			this.dark = info.dark;
			const root = document.documentElement;
			const colors = info.colors ?? {};
			const set = (name: string, value: string | undefined) => {
				if (value && HEX.test(value)) root.style.setProperty(name, value);
				else root.style.removeProperty(name);
			};
			// Without colours the stylesheet's media query decides, so the attribute must not pin a scheme.
			if (info.colors) root.dataset.theme = info.dark ? 'dark' : 'light';
			else delete root.dataset.theme;
			set('--bg', colors.background);
			set('--viewport', colors.background);
			set('--text', colors.text);
			set('--accent', colors.primary);
		});
	}
}

export const theme = new Theme();

/** The system colour scheme, via the media query. */
export const systemTheme: ThemeSource = {
	watch(apply) {
		const query = matchMedia('(prefers-color-scheme: dark)');
		apply({ dark: query.matches });
		const onChange = (e: MediaQueryListEvent) => apply({ dark: e.matches });
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	}
};

/** Relative luminance below the midpoint reads as a dark background. */
export function isDarkColor(hex: string) {
	const n = parseInt(hex.slice(1), 16);
	const channel = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255) < 0.35;
}
