// What must never be published: local paths, account ids, addresses, Nostr secrets, session links. One rule set for
// the git hooks, CI, the forge and the model pipeline. A term that is private in itself (a hostname, a name) cannot
// be listed here, since this file is public: it goes in the private terms file, one term per line, which lives
// outside the repository (see privateTerms).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/** Addresses that may appear: commit trailers and documentation placeholders. */
const ALLOWED_EMAILS = new Set(['noreply@anthropic.com', 'grumpyeng@seedhammer.com', 'git@github.com']);
const ALLOWED_EMAIL_DOMAINS = /@example\.(com|org|net)$/i;
const ALLOWED_IPS = new Set(['127.0.0.1', '0.0.0.0']);

/** @type {{ name: string, re: RegExp, allow?: (match: string) => boolean }[]} */
export const RULES = [
	// Windows paths also in their escaped forms, as STEP and JSON write them.
	{ name: 'local path', re: /\/Users\/[^/\s'"]|\/home\/[a-z]|\/private\/var\/folders\/|\/Volumes\/[^/\s'"]|[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)/g },
	// Bracketed so this file does not match itself.
	{ name: 'Autodesk id', re: /urn:ads[k]/gi },
	{ name: 'email address', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, allow: (/** @type {string} */ m) => ALLOWED_EMAILS.has(m.toLowerCase()) || ALLOWED_EMAIL_DOMAINS.test(m) },
	{ name: 'Nostr secret key', re: /nsec1[02-9ac-hj-np-z]{58}|ncryptsec1[02-9ac-hj-np-z]{20,}/g },
	{ name: 'Nostr signer session', re: /nbunksec1[02-9ac-hj-np-z]{20,}|(?:bunker|nostrconnect):\/\/[0-9a-f]{64}\?\S*secret=/g },
	{ name: 'Claude session link', re: /claude\.ai\/code\/session_|^Claude-Session:/gm },
	// Four octets standing alone, so version numbers (v15.15.0.0, 8.0.1.0.0) do not count.
	{ name: 'IP address', re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g, allow: (/** @type {string} */ m) => ALLOWED_IPS.has(m) }
];

/**
 * Private terms, matched case-insensitively as plain text: the PRIVATE_TERMS variable (newline-separated, how CI
 * gets them from a secret), else the file named by PRIVATE_TERMS_FILE, else ~/.config/seedhammer/private-terms.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function privateTerms(env = process.env) {
	let text = env.PRIVATE_TERMS ?? '';
	if (!text) {
		const file = env.PRIVATE_TERMS_FILE || `${homedir()}/.config/seedhammer/private-terms`;
		if (existsSync(file)) text = readFileSync(file, 'utf8');
	}
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
		.map((line) => line.toLowerCase());
}

/**
 * Every finding in the text, by rule name and line. Never returns the matched text: the reports end up in public CI
 * logs, and the match may be the very secret.
 * @param {string} text
 * @param {string[]} [terms]
 * @returns {{ rule: string, line: number }[]}
 */
export function findPrivate(text, terms = []) {
	/** @type {Map<string, { rule: string, line: number }>} */
	const found = new Map();
	const add = (/** @type {string} */ rule, /** @type {number} */ index) => {
		const line = text.slice(0, index).split('\n').length;
		found.set(`${line}\0${rule}`, { rule, line });
	};
	for (const rule of RULES) {
		for (const match of text.matchAll(rule.re)) if (!rule.allow?.(match[0])) add(rule.name, match.index ?? 0);
	}
	if (terms.length) {
		const lower = text.toLowerCase();
		for (const term of terms) {
			for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) add('private term', at);
		}
	}
	return [...found.values()].sort((a, b) => a.line - b.line);
}
