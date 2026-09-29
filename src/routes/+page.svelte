<script lang="ts">
	import { base } from '$app/paths';
	import App from '$lib/App.svelte';
	import { createWebHost } from '$lib/host/web';
</script>

<App host={createWebHost(base)} />
