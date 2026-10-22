// The model pipeline's side of scripts/privacy-rules.mjs: a STEP or GLB that matches any rule is refused, and the
// error names the rule, never the match, since a log may be shared.
import { findPrivate, privateTerms } from '../scripts/privacy-rules.mjs';

const terms = privateTerms();

/** Throws when the text carries anything private. */
export function assertPublic(what: string, text: string) {
	const findings = findPrivate(text, terms);
	if (findings.length) throw new Error(`${what} contains private data: ${findings.map((f) => `${f.rule} (line ${f.line})`).join(', ')}`);
}

/** A commit subject as the catalogue may carry it: one the rules catch is left out. */
export function publicSubject(subject: string) {
	try {
		assertPublic('commit subject', subject);
		return subject;
	} catch {
		return '';
	}
}
