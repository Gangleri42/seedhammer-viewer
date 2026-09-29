import { describe, expect, it } from 'vitest';
import { choose, MOUSE, TOUCH, type Candidate, type Pick } from './pick';

const pick = (kind: Pick['kind'], index: number) => ({ kind, ref: { part: 'a', kind: kind === 'face' ? 'f' : kind === 'edge' ? 'e' : 'v', index } }) as unknown as Pick;
const at = (p: Pick, px: number): Candidate => ({ pick: p, px });
const face = pick('face', 1), edge = pick('edge', 2), vertex = pick('point', 3), centre = pick('point', 4);

describe('measure picking priority', () => {
	it('takes a point near the pointer over the edge it sits on', () => {
		expect(choose([at(vertex, 2)], [at(edge, 0)], face, MOUSE, false)).toBe(vertex);
	});

	it('takes the rim when the pointer is on it and the centre is a few pixels away', () => {
		expect(choose([at(centre, 7)], [at(edge, 0.5)], face, MOUSE, false)).toBe(edge);
	});

	it('falls back from points to edges to the face', () => {
		expect(choose([at(vertex, 9)], [at(edge, 4)], face, MOUSE, false)).toBe(edge);
		expect(choose([at(vertex, 9)], [at(edge, 6)], face, MOUSE, false)).toBe(face);
		expect(choose([], [], null, MOUSE, false)).toBeNull();
	});

	it('reaches further on touch', () => {
		expect(choose([at(vertex, 20)], [], face, TOUCH, false)).toBe(vertex);
		expect(choose([], [at(edge, 12)], face, TOUCH, false)).toBe(edge);
	});

	it('only takes points, from further away, with ⌘/Ctrl', () => {
		expect(choose([at(centre, 40)], [at(edge, 0)], face, MOUSE, true)).toBe(centre);
		expect(choose([], [at(edge, 0)], face, MOUSE, true)).toBeNull();
	});

	it('takes the nearest of several points', () => {
		expect(choose([at(vertex, 6), at(centre, 3)], [], face, MOUSE, false)).toBe(centre);
	});
});
