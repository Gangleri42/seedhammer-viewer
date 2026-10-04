// Relay I/O with per-relay answers: a publish is only as good as the OKs it got, and a replaceable event is fetched
// from every relay separately so a stale copy somewhere shows up.
import './ws.ts';
import type { Event } from 'nostr-tools/core';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import { verifyEvent } from 'nostr-tools/pure';

export { reachable } from './ws.ts';

export type PublishReport = Record<string, { ok: boolean; reason: string }>;

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string) =>
	Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);

export class Relays {
	#pool = new SimplePool();

	async publish(relays: string[], event: Event, timeoutMs = 15_000): Promise<PublishReport> {
		const report: PublishReport = {};
		const attempts = this.#pool.publish(relays, event);
		await Promise.all(
			attempts.map(async (attempt, i) => {
				try {
					const reason = await withTimeout(attempt, timeoutMs, `publish to ${relays[i]}`);
					report[relays[i]] = { ok: true, reason: reason || 'ok' };
				} catch (err) {
					report[relays[i]] = { ok: false, reason: err instanceof Error ? err.message : String(err) };
				}
			})
		);
		return report;
	}

	/** The newest valid event matching the filter, and which relays returned which id. */
	async latest(relays: string[], filter: Filter, timeoutMs = 10_000): Promise<{ event: Event | null; seen: Record<string, string | null> }> {
		const seen: Record<string, string | null> = {};
		let newest: Event | null = null;
		await Promise.all(
			relays.map(async (relay) => {
				try {
					const events = await withTimeout(this.#pool.querySync([relay], { ...filter, limit: filter.limit ?? 5 }, { maxWait: timeoutMs }), timeoutMs + 2000, `query ${relay}`);
					// A relay can answer with anything signed, so the filter is checked again: another key's manifest is not ours.
					const valid = events.filter((e) => verifyEvent(e) && matchFilter(filter, e)).sort((a, b) => b.created_at - a.created_at);
					seen[relay] = valid[0]?.id ?? null;
					if (valid[0] && (!newest || valid[0].created_at > newest.created_at)) newest = valid[0];
				} catch {
					seen[relay] = null;
				}
			})
		);
		return { event: newest, seen };
	}

	destroy() {
		this.#pool.destroy();
	}
}
