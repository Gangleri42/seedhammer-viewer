// Deep links reach a napplet as intents, delivered out of band on an INC topic. The runtime may post the event as
// soon as the frame exists, so this subscribes at module load, before the UI or three.js are in, and keeps the last
// route for whoever mounts later.
import { ARCHETYPE, CONVENTION, OPEN_TOPICS, READY_TOPIC, routeFromPayload } from '$lib/state/route';
import { close, has, type Handle, type IncEvent } from './napplet-runtime';

let latest: string | null = null;
let opened = false;
const listeners = new Set<(route: string) => void>();
const handles: Handle[] = [];

/** An `inc.event` envelope carries the payload inside; some runtimes hand over the payload itself. */
function payloadOf(event: unknown) {
	if (event && typeof event === 'object' && 'topic' in event && ('payload' in event || 'sender' in event)) return (event as IncEvent).payload;
	return event;
}

function deliver(payload: unknown) {
	const route = routeFromPayload(payload);
	if (!route) return;
	latest = route;
	for (const listener of listeners) listener(route);
}

export function openInbox() {
	if (opened) return;
	opened = true;
	const inc = has('inc', 'on', 'emit');
	if (inc) {
		for (const topic of OPEN_TOPICS) {
			try {
				handles.push(inc.on(topic, (event) => deliver(payloadOf(event))));
			} catch {
				// A runtime that rejects one topic form still gets the other.
			}
		}
		try {
			// stlstr-style shells hold the intent until the napplet says it listens.
			inc.emit(READY_TOPIC);
		} catch {
			// Not every runtime accepts a payload-less emit; nothing depends on it.
		}
	}
	const intent = has('intent', 'onDelivery');
	if (intent?.onDelivery) {
		handles.push(
			intent.onDelivery((delivery) => {
				const ours = !delivery.convention || delivery.convention === CONVENTION || delivery.archetype === ARCHETYPE;
				if (ours) deliver(delivery.payload);
			})
		);
	}
	addEventListener('pagehide', closeInbox, { once: true });
}

export function closeInbox() {
	for (const handle of handles.splice(0)) close(handle);
}

export const inbox = {
	get latest() {
		return latest;
	},
	subscribe(listener: (route: string) => void) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}
};
