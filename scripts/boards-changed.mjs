#!/usr/bin/env node
// Whether a tracked board changed since the live site was built: for each board in pipeline/boards.json, the newest
// commit on its branch that touched the board or the repository's lib (GitHub's commits API), against board.head in
// the live index.json. Prints changed=true|false for $GITHUB_OUTPUT. Only a real difference builds: anything this
// cannot tell (the site or the API unreachable, a branch gone, an index without boards) is said and left to the
// push, dispatch and daily runs, so a lasting problem never starts a build every ten minutes.
//
//   GH_TOKEN  the workflow's token, for the API's rate limit (optional)
//   node scripts/boards-changed.mjs [index.json URL]   (default: the site named in static/CNAME)
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const boards = JSON.parse(readFileSync('pipeline/boards.json', 'utf8'));
const url = process.argv[2] ?? `https://${readFileSync('static/CNAME', 'utf8').trim()}/models/index.json`;
const headers = { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };

/** The newest commit on `ref` touching `path`: its sha and committer time. */
async function newest(repo, ref, path) {
	const response = await fetch(`https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=1`, { headers });
	if (!response.ok) throw new Error(`${repo} ${ref} ${path}: HTTP ${response.status}`);
	const [commit] = await response.json();
	return commit ? { sha: commit.sha, time: Date.parse(commit.commit.committer.date) } : null;
}

async function check() {
	const response = await fetch(url, { cache: 'no-store' });
	if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`);
	const index = await response.json();
	for (const [key, board] of Object.entries(boards)) {
		const built = index.models?.[key]?.board?.head;
		if (!built) throw new Error(`${key}: the live index has no board`);
		const found = (await Promise.all([newest(board.repo, board.ref, dirname(board.file)), newest(board.repo, board.ref, 'lib')])).filter(Boolean);
		if (!found.length) throw new Error(`${key}: nothing on ${board.repo} ${board.ref}`);
		const last = found.sort((a, b) => b.time - a.time)[0].sha;
		if (!last.startsWith(built)) return `${key}: ${board.repo} ${board.ref} changed at ${last.slice(0, 7)}, the site has ${built}`;
	}
	return null;
}

let changed = false;
try {
	const reason = await check();
	changed = !!reason;
	console.error(reason ? `rebuild: ${reason}` : 'the boards on the site are current');
} catch (err) {
	console.error(`not rebuilding, cannot tell: ${err.message}`);
}
console.log(`changed=${changed}`);
