// What the Measure tool works on and what it returns. Everything is in world space, in millimetres.
import type { Vector3 } from 'three';

export type Curve =
	| { kind: 'line'; start: Vector3; end: Vector3 }
	// p(ψ) = centre + radius·(cos ψ·ref + sin ψ·(normal × ref)), ψ ∈ [start, start + sweep]; full circle when sweep ≥ 2π − 1e-9
	| { kind: 'arc'; centre: Vector3; normal: Vector3; radius: number; ref: Vector3; start: number; sweep: number }
	| { kind: 'polyline'; points: Vector3[]; deflection: number }; // ellipses and freeform curves: approximate

export type Surface =
	| { kind: 'plane'; origin: Vector3; normal: Vector3 } // outward normal
	| { kind: 'cylinder'; origin: Vector3; axis: Vector3; radius: number }
	| { kind: 'cone'; apex: Vector3; axis: Vector3; halfAngle: number } // axis from the apex into the face's nappe, 0 < halfAngle < π/2
	| { kind: 'sphere'; centre: Vector3; radius: number }
	| { kind: 'torus'; centre: Vector3; axis: Vector3; major: number; minor: number }
	| { kind: 'other' };

export type PointEntity = { type: 'point'; id: string; role: 'vertex' | 'centre' | 'midpoint'; position: Vector3 };
export type EdgeEntity = { type: 'edge'; id: string; curve: Curve; length: number };
export type FaceEntity = {
	type: 'face';
	id: string;
	surface: Surface;
	area: number;
	loopLength: number;
	soup: Float32Array; // world-space triangle soup, 9 floats per triangle (non-indexed)
	tol: number; // two-sided bound between soup and the exact bounded face, mm
	edges: EdgeEntity[]; // the face's exact boundary edges (seams excluded)
};
export type Entity = PointEntity | EdgeEntity | FaceEntity;

export type Unit = 'mm' | 'mm²' | '°';
export type RowKey =
	| 'distance'
	| 'angle'
	| 'centre'
	| 'axisDistance'
	| 'min'
	| 'max'
	| 'dx'
	| 'dy'
	| 'dz'
	| 'perpendicular'
	| 'axisToPlane'
	| 'axisAngle'
	| 'x'
	| 'y'
	| 'z'
	| 'length'
	| 'radius'
	| 'diameter'
	| 'area'
	| 'loopLength'
	| 'centreX'
	| 'centreY'
	| 'centreZ'
	| 'coneAngle';
export type Row = { key: RowKey; label: string; value: number; unit: Unit; exact: boolean };

export type Anchor =
	| { kind: 'segment'; role: 'distance' | 'centre' | 'min' | 'max' | 'perpendicular' | 'dx' | 'dy' | 'dz'; a: Vector3; b: Vector3 }
	| { kind: 'angle'; apex: Vector3; a: Vector3; b: Vector3 }
	| { kind: 'point'; role: 'position' | 'centre'; at: Vector3 }
	| { kind: 'axis'; from: Vector3; to: Vector3 };

export type Measurement = { rows: Row[]; anchors: Anchor[] };
export type Closest = { distance: number; a: Vector3; b: Vector3; exact: boolean };
