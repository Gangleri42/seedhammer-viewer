/** Clipboard write with the legacy fallback for frames that have no clipboard permission. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Still inside the click, so execCommand may be allowed where the async API is not.
	}
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.append(area);
	area.select();
	let done = false;
	try {
		done = document.execCommand('copy');
	} catch {
		done = false;
	}
	area.remove();
	return done;
}
