// What was published when: event ids, aggregates and the file list of each deploy. Committed, so the next deploy can
// keep the previous build's immutable chunks reachable and anyone can trace a manifest back to a commit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type Published = { id: string; x: string; created_at: number; snapshot?: string };
export type Deploy = {
	at: string;
	commit?: string;
	site?: Published & { files: { path: string; sha256: string; bytes: number }[] };
	napplet?: Published;
	servers: string[];
};
export type Ledger = { deploys: Deploy[] };

export const LEDGER_PATH = 'pipeline/nostr/ledger.json';
const KEEP = 20;

export function readLedger(path = LEDGER_PATH): Ledger {
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { deploys: [] };
}

export function appendDeploy(ledger: Ledger, deploy: Deploy, path = LEDGER_PATH) {
	ledger.deploys = [...ledger.deploys, deploy].slice(-KEEP);
	writeFileSync(path, JSON.stringify(ledger, null, '\t') + '\n');
}

export const lastDeploy = (ledger: Ledger) => ledger.deploys.at(-1) ?? null;

/** A returning browser may hold last deploy's index.html for an hour: its hashed chunks must stay resolvable. */
export function previousImmutable(ledger: Ledger) {
	return lastDeploy(ledger)?.site?.files.filter((f) => f.path.startsWith('/_app/immutable/')) ?? [];
}
