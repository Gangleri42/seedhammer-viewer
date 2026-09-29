// The whole view lives in the URL hash so a link reproduces it:
//   #/hammer@41?hide=a3,b0&iso=c7&cut=x:12.5!,z:-3&ex=0.6&cam=12.1,-300,250;0,0,80&sel=a3&m=k3x9a1.f12.q7&edges=0&ortho=1
// No version means "latest". Unknown keys are ignored, so old links survive new features.

export type Axis = 'x' | 'y' | 'z';
export type Cut = { axis: Axis; offset: number; flip: boolean };
export type Camera = { position: [number, number, number]; target: [number, number, number]; zoom?: number };

/**
 * One measured item: a face (f), edge (e) or vertex (v) of a body, or the centre (c) or midpoint (m) of an edge, by
 * its number in that version's measurement file. `check` is two characters derived from the item's size: a link whose
 * numbers point at something else after a rebuild drops the item instead of measuring the wrong thing.
 */
export type MeasureKind = 'f' | 'e' | 'v' | 'c' | 'm';
export type MeasureRef = { part: string; kind: MeasureKind; index: number; check?: string };

export type ViewState = {
	model: string;
	version: number | null;
	hidden: string[];
	isolated: string[];
	cuts: Cut[];
	explode: number;
	camera: Camera | null;
	selected: string | null;
	/** At most two; they only mean something for one version, so a route carries them only with its version. */
	measure: MeasureRef[];
	edges: boolean;
	ortho: boolean;
};

export const DEFAULT_MODEL = 'hammer';

export function defaultState(model = DEFAULT_MODEL): ViewState {
	return {
		model,
		version: null,
		hidden: [],
		isolated: [],
		cuts: [],
		explode: 0,
		camera: null,
		selected: null,
		measure: [],
		edges: true,
		ortho: false
	};
}

const MEASURE_REF = /^([0-9a-z]+)\.([fevcm])(0|[1-9]\d{0,5})(?:\.([0-9a-z]{2}))?$/;

export function parseRef(token: string): MeasureRef | null {
	const match = MEASURE_REF.exec(token);
	if (!match) return null;
	const ref: MeasureRef = { part: match[1], kind: match[2] as MeasureKind, index: Number(match[3]) };
	if (match[4]) ref.check = match[4];
	return ref;
}

export const formatRef = (ref: MeasureRef) => `${ref.part}.${ref.kind}${ref.index}${ref.check ? `.${ref.check}` : ''}`;
export const sameRef = (a: MeasureRef, b: MeasureRef) => a.part === b.part && a.kind === b.kind && a.index === b.index;

const round = (v: number, step: number) => Math.round(v / step) * step;
const num = (v: number, step = 0.1) => String(Number(round(v, step).toFixed(3)));
const ID_LIST = /^[0-9a-z]+(,[0-9a-z]+)*$/;

export function encode(state: ViewState): string {
	const params: string[] = [];
	if (state.hidden.length) params.push(`hide=${state.hidden.join(',')}`);
	if (state.isolated.length) params.push(`iso=${state.isolated.join(',')}`);
	if (state.cuts.length) {
		params.push(`cut=${state.cuts.map((c) => `${c.axis}:${num(c.offset)}${c.flip ? '!' : ''}`).join(',')}`);
	}
	if (state.explode > 0) params.push(`ex=${num(state.explode, 0.01)}`);
	if (state.camera) {
		const { position: p, target: t, zoom } = state.camera;
		params.push(`cam=${p.map((v) => num(v)).join(',')};${t.map((v) => num(v)).join(',')}${zoom ? `;${num(zoom, 0.01)}` : ''}`);
	}
	if (state.selected) params.push(`sel=${state.selected}`);
	if (state.measure.length && state.version) params.push(`m=${state.measure.map(formatRef).join(',')}`);
	if (!state.edges) params.push('edges=0');
	if (state.ortho) params.push('ortho=1');
	const head = `#/${state.model}${state.version ? `@${state.version}` : ''}`;
	return params.length ? `${head}?${params.join('&')}` : head;
}

function triple(text: string | undefined): [number, number, number] | null {
	const parts = text?.split(',').map(Number);
	return parts?.length === 3 && parts.every(Number.isFinite) ? (parts as [number, number, number]) : null;
}

const ROUTE = /^#\/([a-z0-9-]+)(?:@(\d+))?(?:\?(.*))?$/i;
const QUERY = /^[\w.,:;!=&%-]*$/;

/** Whether the text has the shape of a route: model, optional version, and a query made of the grammar's characters. */
export function isRoute(hash: string) {
	const match = ROUTE.exec(hash);
	return !!match && (match[3] === undefined || QUERY.test(match[3]));
}

export function decode(hash: string): ViewState {
	const match = ROUTE.exec(hash);
	if (!match) return defaultState();
	const state = defaultState(match[1].toLowerCase());
	state.version = match[2] ? Number(match[2]) : null;
	const params = new URLSearchParams(match[3] ?? '');

	const ids = (key: string) => {
		const value = params.get(key);
		return value && ID_LIST.test(value) ? value.split(',') : [];
	};
	state.hidden = ids('hide');
	state.isolated = ids('iso');

	for (const part of params.get('cut')?.split(',') ?? []) {
		const cut = /^([xyz]):(-?\d+(?:\.\d+)?)(!?)$/.exec(part);
		if (cut && state.cuts.length < 3) state.cuts.push({ axis: cut[1] as Axis, offset: Number(cut[2]), flip: cut[3] === '!' });
	}

	const explode = Number(params.get('ex'));
	if (Number.isFinite(explode)) state.explode = Math.min(1, Math.max(0, explode));

	const [p, t, z] = params.get('cam')?.split(';') ?? [];
	const position = triple(p), target = triple(t);
	if (position && target) {
		state.camera = { position, target };
		if (z && Number(z) > 0) state.camera.zoom = Number(z);
	}

	const selected = params.get('sel');
	if (selected && /^[0-9a-z]+$/.test(selected)) state.selected = selected;

	for (const token of params.get('m')?.split(',') ?? []) {
		const ref = parseRef(token);
		if (ref && state.measure.length < 2 && !state.measure.some((r) => sameRef(r, ref))) state.measure.push(ref);
	}
	// Measurements are taken on the assembled model.
	if (state.measure.length) state.explode = 0;
	state.edges = params.get('edges') !== '0';
	state.ortho = params.get('ortho') === '1';
	return state;
}
