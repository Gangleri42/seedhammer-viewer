// A tiny NIP-5D shell for trying the built napplet locally: serves the shell page and the artefact with the Kehto
// runtime prelude injected, the way stlstr and Paja mount it.
// Usage: node scripts/dev-shell/serve.mjs   (after npm run build:napplet), then open http://127.0.0.1:4180/
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { injectNappletNamespacePrelude } from '@kehto/shell';

const port = Number(process.env.PORT ?? 4180);
const domains = ['inc', 'resource', 'theme', 'link'];
const shell = new URL('./index.html', import.meta.url);
const artefact = 'dist-napplet/index.html';
const types = { glb: 'model/gltf-binary', zip: 'application/zip', json: 'application/json' };

createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	if (url.pathname === '/napplet.html') {
		if (!existsSync(artefact)) {
			res.writeHead(404).end('run npm run build:napplet first');
			return;
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(injectNappletNamespacePrelude(readFileSync(artefact, 'utf8'), { domains }));
		return;
	}
	if (url.pathname.startsWith('/models/')) {
		const file = `static${url.pathname}`;
		if (!existsSync(file)) {
			res.writeHead(404).end();
			return;
		}
		res.setHeader('content-type', types[url.pathname.split('.').pop()] ?? 'application/octet-stream');
		res.end(readFileSync(file));
		return;
	}
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.end(readFileSync(shell));
}).listen(port, '127.0.0.1', () => console.log(`dev shell at http://127.0.0.1:${port}/ (domains: ${domains.join(', ')})`));
