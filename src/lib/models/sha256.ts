/** Hex sha256 of bytes, or null where WebCrypto is not available (an insecure context). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string | null> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) return null;
	const digest = await subtle.digest('SHA-256', data as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
