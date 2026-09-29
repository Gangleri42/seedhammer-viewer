// Fixtures that would trip the rules are assembled at runtime, so this file passes its own check.
import { describe, expect, it } from 'vitest';
import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey } from 'nostr-tools/pure';
import { findPrivate, privateTerms } from './privacy-rules.mjs';

const rules = (text: string, terms: string[] = []) => findPrivate(text, terms).map((f) => f.rule);
const at = '@';

describe('privacy rules', () => {
	it('finds local paths, including the escaped forms STEP and JSON write', () => {
		expect(rules('/Us' + 'ers/jane/model.f3d')).toEqual(['local path']);
		expect(rules('/ho' + 'me/jane/x')).toEqual(['local path']);
		expect(rules("FILE_NAME('C:" + '\\\\Users\\\\jane' + "')")).toEqual(['local path']);
		expect(rules('C:/' + 'Users/jane')).toEqual(['local path']);
		expect(rules('/private/var/' + 'folders/xy/T/tmp')).toEqual(['local path']);
		expect(rules('~/.config/x and /home')).toEqual([]);
	});

	it('finds Autodesk ids and email addresses, except the allowed ones', () => {
		expect(rules('urn:' + 'adsk.wipprod:fs.file:vf.abc')).toEqual(['Autodesk id']);
		expect(rules(`jane${at}mail.test`)).toEqual(['email address']);
		expect(rules('Co-Authored-By: Claude <noreply@anthropic.com>\nSigned-off-by: grumpyeng <grumpyeng@seedhammer.com>')).toEqual([]);
		expect(rules(`someone${at}example.org, git${at}github.com:owner/repo`)).toEqual([]);
	});

	it('finds Nostr secrets and signer sessions', () => {
		expect(rules(`key ${nip19.nsecEncode(generateSecretKey())}`)).toEqual(['Nostr secret key']);
		expect(rules('ncryptsec1' + 'q'.repeat(40))).toEqual(['Nostr secret key']);
		expect(rules('nbunksec1' + 'q'.repeat(40))).toEqual(['Nostr signer session']);
		expect(rules('bunker://' + 'a'.repeat(64) + '?relay=wss://r.example&secret=abc')).toEqual(['Nostr signer session']);
		expect(rules('npub1zj0q0eseamwn9er4drf3jl3kufc0fddsfrr0v54l2mlfqenah7ysxuy9th')).toEqual([]);
	});

	it('finds Claude session links and trailers', () => {
		expect(rules('see https://claude.ai/code/' + 'session_01ABC')).toEqual(['Claude session link']);
		expect(rules('Fix a thing\n\nClaude-' + 'Session: x')).toEqual(['Claude session link']);
		expect(rules('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')).toEqual([]);
	});

	it('finds IP addresses but not version numbers or loopback', () => {
		expect(rules('http://10.0.0.' + '7:8080/')).toEqual(['IP address']);
		expect(rules('--host 127.0.0.1 and 0.0.0.0')).toEqual([]);
		expect(rules("'Autodesk Translation Framework v15.15.0.0'")).toEqual([]);
		expect(rules('pip install cadquery-ocp==8.0.1.0.0')).toEqual([]);
	});

	it('matches private terms case-insensitively and reports lines, never the text', () => {
		const findings = findPrivate('one\ntwo\nsee Sh.Example.Test here', ['sh.example.test']);
		expect(findings).toEqual([{ rule: 'private term', line: 3 }]);
		expect(Object.keys(findings[0]).sort()).toEqual(['line', 'rule']);
	});

	it('reads private terms from the environment, skipping comments and blanks', () => {
		expect(privateTerms({ PRIVATE_TERMS: 'Alpha\n# a comment\n\n beta \n' })).toEqual(['alpha', 'beta']);
		expect(privateTerms({ PRIVATE_TERMS_FILE: '/nonexistent/private-terms' })).toEqual([]);
	});
});
