// Entry of the napplet artefact: one HTML file with everything inlined, mounted inside a shell's sandboxed frame.
import '$lib/styles/tokens.css';
import { mount } from 'svelte';
import App from '$lib/App.svelte';
import { createNappletHost } from '$lib/host/napplet';
import { openInbox } from '$lib/host/napplet-inbox';
import { index, inline, nsiteOrigin, servers, shareOrigin } from 'virtual:seedhammer-models';

// Subscribe before anything heavy runs: the shell may deliver the opening intent right away.
openInbox();

mount(App, {
	target: document.getElementById('app')!,
	props: { host: createNappletHost({ index, inline, servers, shareOrigin, nsiteOrigin }) }
});
