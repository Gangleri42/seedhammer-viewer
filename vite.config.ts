import { execFileSync } from 'node:child_process';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// SvelteKit stamps the build into _app/version.json; the last commit that touched the app, instead of the clock,
// keeps two builds of the same source byte-identical, which is how the Nostr publisher knows nothing changed.
// Commits to the pipeline, the deploy scripts or the docs leave the stamp alone.
const commit = (() => {
	try {
		return execFileSync('git', ['log', '-1', '--format=%h', '--', 'src', 'static', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json'], { encoding: 'utf8' }).trim() || 'dev';
	} catch {
		return 'dev';
	}
})();

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Single static page; all view state lives in the URL hash.
			adapter: adapter({ fallback: undefined }),
			// Served at the root of viewer.seedhammer.space. Set BASE_PATH=/<repo> for a plain /<repo>/ Pages deploy.
			paths: { base: (process.env.BASE_PATH ?? '') as '' | `/${string}` },
			version: { name: commit }
		})
	]
});
