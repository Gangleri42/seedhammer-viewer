// What a NIP-5D shell injects as window.napplet. The runtime's prelude installs one object per capability domain the
// manifest declares and the shell grants; a domain the shell lacks is simply absent, so everything is feature-detected.
// The viewer never posts envelopes itself and never sends the readiness signal: the prelude does both.

export type Handle = { close(): void } | (() => void) | void;

export type IncEvent = { topic: string; sender?: string; payload?: unknown };

export type ShellTheme = { colors?: { background?: string; text?: string; primary?: string } };

export type IntentDelivery = { convention?: string; archetype?: string; action?: string; payload?: unknown };

export interface NappletApi {
	shell?: { ready?(): Promise<unknown>; supports?(domain: string): boolean };
	inc?: {
		on(topic: string, handler: (event: IncEvent | unknown) => void): Handle;
		emit(topic: string, payload?: Record<string, string>): unknown;
	};
	intent?: { onDelivery?(handler: (delivery: IntentDelivery) => void): Handle };
	resource?: { bytes(url: string, options?: { servers?: string[]; signal?: AbortSignal }): Promise<Blob> };
	theme?: { get(): Promise<ShellTheme>; onChanged(handler: (theme: ShellTheme) => void): Handle };
	link?: { open(url: string, options?: { label?: string }): Promise<{ status?: string; error?: string } | undefined> };
}

export const napplet = (): NappletApi | null => (globalThis as { napplet?: NappletApi }).napplet ?? null;

/** The domain object when the shell injected it with these methods, else null. */
export function has<K extends keyof NappletApi>(domain: K, ...methods: string[]): NonNullable<NappletApi[K]> | null {
	const api = napplet()?.[domain] as Record<string, unknown> | undefined;
	if (!api || typeof api !== 'object') return null;
	return methods.every((m) => typeof api[m] === 'function') ? (api as NonNullable<NappletApi[K]>) : null;
}

export function close(handle: Handle) {
	if (typeof handle === 'function') handle();
	else handle?.close?.();
}

/** Waits for the shell's init handshake where the prelude exposes it; never longer than the timeout. */
export async function shellReady(timeoutMs = 3000) {
	const ready = napplet()?.shell?.ready;
	if (typeof ready !== 'function') return;
	await Promise.race([ready.call(napplet()!.shell).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
