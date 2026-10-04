"""Converts a STEP assembly into the manifest + mesh files that pipeline/build-model.ts reads.

Same format as export/fusion (occurrence tree with world matrices, body instances, shared meshes, appearances),
but in millimetres and built with OpenCascade, so it runs anywhere without Fusion. measure.json adds the exact
geometry of every face, edge and vertex, which the viewer's Measure tool reads.

    python export/step/step_to_manifest.py <model.step> <out dir> --version <n>
"""
import argparse
import array
import json
import math
import os
import time

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher, Sequence_TDF_Label
from OCP.GCPnts import GCPnts_AbscissaPoint, GCPnts_TangentialDeflection
from OCP.GeomAbs import GeomAbs_CurveType, GeomAbs_SurfaceType
from OCP.gp import gp_Circ, gp_Cone, gp_Cylinder, gp_Lin, gp_Pln, gp_Pnt, gp_Sphere, gp_Vec
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_ColorRGBA, Quantity_TypeOfColor
from OCP.ShapeAnalysis import ShapeAnalysis_CanonicalRecognition
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_Tool
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX, TopAbs_WIRE
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool

LINEAR_DEFLECTION = 0.01  # mm; the pipeline simplifies afterwards
ANGULAR_DEFLECTION = 0.3  # rad
COLOR_TYPES = (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen)
# A BSpline face or edge counts as a plane, cylinder, circle... only this close to one (mm). Looser tolerances turn
# slightly curved faces into planes and short arcs into lines.
RECOGNITION_TOLERANCE = 1e-4
# Free-form edges as polylines, mm; the pipeline thins them to the part's simplify error.
POLYLINE_DEFLECTION = 0.005
FREE_FORM_CURVES = (GeomAbs_CurveType.GeomAbs_BSplineCurve, GeomAbs_CurveType.GeomAbs_BezierCurve,
                    GeomAbs_CurveType.GeomAbs_OffsetCurve, GeomAbs_CurveType.GeomAbs_OtherCurve)
# The measurement file keeps an arc's sweep to 6 decimals: below MIN_SWEEP nothing is left of it. Wider arcs also lose
# length (r * 5e-7 mm): --max-radius, which the board pipeline passes for KiCad's vendor models (near-straight curves
# that fit a circle a kilometre wide), keeps arcs at least that wide as lines when straight within tolerance, else as
# curves. Without it every other arc stays as it always was, so measured links into existing models keep their items.
MIN_SWEEP = 5e-7
TWO_PI = 2 * math.pi


def label_name(label):
    attr = TDataStd_Name()
    return attr.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attr) else ''


def row_major(trsf):
    """gp_Trsf as a row-major 4x4 list (mm)."""
    rows = [[trsf.Value(r, c) for c in range(1, 5)] for r in range(1, 4)]
    return [v for row in rows for v in row] + [0.0, 0.0, 0.0, 1.0]


def solids_of(shape):
    """The bodies of a part: its solids, or its shells when it has none (open surface bodies)."""
    for kind in (TopAbs_SOLID, TopAbs_SHELL):
        found = []
        explorer = TopExp_Explorer(shape, kind)
        while explorer.More():
            found.append(explorer.Current())
            explorer.Next()
        if found:
            return found
    return []


def shape_map(shape, kind):
    """The sub-shapes of one kind, numbered in explorer order. A face's index here is its id in m_###.bin and in
    measure.json, so the viewer can go from a triangle to the exact face."""
    found = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, kind, found)
    return found


# -- small vector helpers (lists of three floats) ---------------------------------------------------------------------

def xyz(v):
    return [v.X(), v.Y(), v.Z()]


def add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def scale(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def unit(a):
    length = math.sqrt(dot(a, a))
    return scale(a, 1 / length) if length > 0 else a


def radial(p, origin, axis):
    """The part of p − origin perpendicular to the axis."""
    v = sub(p, origin)
    return sub(v, scale(axis, dot(v, axis)))


def sign(value):
    return 1 if value >= 0 else -1


def chains(ids, ends):
    """Splits a wire's edges into chains that share vertices: a cylinder's wire without its seam is two circles."""
    parent = {i: i for i in ids}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    first = {}
    for i in ids:
        for v in ends[i]:
            if v < 0:
                continue
            if v in first:
                parent[find(i)] = find(first[v])
            else:
                first[v] = i
    groups = {}
    for i in ids:
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


class Converter:
    def __init__(self, path, max_radius=None):
        self.max_radius = max_radius
        Interface_Static.SetCVal_s('xstep.cascade.unit', 'MM')
        self.doc = TDocStd_Document(TCollection_ExtendedString('XmlOcaf'))
        reader = STEPCAFControl_Reader()
        reader.SetColorMode(True)
        reader.SetNameMode(True)
        if reader.ReadFile(path) != IFSelect_RetDone:
            raise SystemExit(f'cannot read {path}')
        reader.Transfer(self.doc)
        self.shapes = XCAFDoc_DocumentTool.ShapeTool_s(self.doc.Main())
        self.colors = XCAFDoc_DocumentTool.ColorTool_s(self.doc.Main())
        self.occurrences, self.bodies, self.meshes, self.appearances = [], [], [], {}
        self.mesh_index = {}  # (prototype entry, solid index) -> mesh index
        self.solids = []  # mesh index -> shape, in prototype space
        self.maps = {}  # mesh index -> (faces, edges, vertices) maps
        self.remeshed = []  # bodies with a face that only meshed as NURBS
        self.unmeshed = []  # bodies with a face that did not mesh at all (a hole in the viewer)

    # -- colours ------------------------------------------------------------------------------------------------------

    def _label_color(self, label):
        # The label lookup is static in OCCT 7.8+ (OCP's _s suffix); KiCad colours some parts only by label.
        rgba = Quantity_ColorRGBA()
        for kind in COLOR_TYPES:
            if XCAFDoc_ColorTool.GetColor_s(label, kind, rgba):
                return rgba
        return None

    def _shape_color(self, shape):
        rgba = Quantity_ColorRGBA()
        for kind in COLOR_TYPES:
            if self.colors.GetColor(shape, kind, rgba):
                return rgba
        return None

    def _body_color(self, solid, prototype, instance):
        color = self._shape_color(solid) or self._label_color(prototype) or self._label_color(instance)
        if color:
            return color
        # Fusion often colours faces rather than bodies: take the first coloured face.
        explorer = TopExp_Explorer(solid, TopAbs_FACE)
        while explorer.More():
            color = self._shape_color(explorer.Current())
            if color:
                return color
            explorer.Next()
        return None

    def _appearance(self, rgba):
        if rgba is None:
            return None
        rgb = rgba.GetRGB()
        # Quantity_Color stores linear RGB; the manifest, like Fusion's, stores sRGB bytes.
        r, g, b = (round(c * 255) for c in rgb.Values(Quantity_TypeOfColor.Quantity_TOC_sRGB))
        alpha = rgba.Alpha()
        name = f'rgb({r},{g},{b})' if alpha >= 0.999 else f'rgba({r},{g},{b},{alpha:.2f})'
        if name not in self.appearances:
            if alpha < 0.999:
                props = [['interior_model', 'integer', 3], ['transparent_color', 'color', [r, g, b, 255]],
                         ['surface_roughness', 'float', 0.05]]
            else:
                props = [['interior_model', 'integer', 0], ['opaque_albedo', 'color', [r, g, b, 255]],
                         ['surface_roughness', 'float', 0.45]]
            self.appearances[name] = props
        return name

    # -- tree ---------------------------------------------------------------------------------------------------------

    def _mesh_for(self, prototype, index, solid):
        entry = TCollection_AsciiString()
        TDF_Tool.Entry_s(prototype, entry)
        key = (entry.ToCString(), index)
        if key not in self.mesh_index:
            self.mesh_index[key] = len(self.meshes)
            self.meshes.append({'component': label_name(prototype), 'body': f'body{index + 1}'})
            self.solids.append(solid)
        return self.mesh_index[key]

    def _add_bodies(self, prototype, instance, occ_path):
        shape = self.shapes.GetShape_s(prototype)
        solids = solids_of(shape)
        component = label_name(prototype)
        for index, solid in enumerate(solids):
            mesh = self._mesh_for(prototype, index, solid)
            name = component if len(solids) == 1 else f'{component} ({index + 1})'
            self.meshes[mesh]['body'] = name
            color = self._body_color(solid, prototype, instance)
            self.bodies.append({'occ': occ_path, 'body': name, 'mesh': mesh, 'appearance': self._appearance(color)})

    def _walk(self, assembly, parent_path, parent_trsf):
        components = Sequence_TDF_Label()
        self.shapes.GetComponents_s(assembly, components)
        for i in range(1, components.Length() + 1):
            instance = components.Value(i)
            prototype = TDF_Label()
            self.shapes.GetReferredShape_s(instance, prototype)
            name = label_name(instance) or f'{label_name(prototype)}:{i}'
            path = f'{parent_path}+{name}' if parent_path else name
            trsf = parent_trsf.Multiplied(self.shapes.GetLocation_s(instance).Transformation())
            self.occurrences.append({'path': path, 'parent': parent_path, 'name': name, 'component': label_name(prototype),
                                     'linked': False, 'visible': True, 'matrix': row_major(trsf)})
            if self.shapes.IsAssembly_s(prototype):
                self._walk(prototype, path, trsf)
            else:
                self._add_bodies(prototype, instance, path)

    def convert(self):
        free = Sequence_TDF_Label()
        self.shapes.GetFreeShapes(free)
        root = free.Value(1)
        self.root_name = label_name(root)
        identity = TopLoc_Location().Transformation()
        if self.shapes.IsAssembly_s(root):
            self._walk(root, None, identity)
        else:
            self._add_bodies(root, root, None)

    def _maps(self, index):
        if index not in self.maps:
            solid = self.solids[index]
            self.maps[index] = tuple(shape_map(solid, kind) for kind in (TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX))
        return self.maps[index]

    # -- meshes -------------------------------------------------------------------------------------------------------

    @staticmethod
    def _remesh_as_nurbs(face):
        """BRepMesh gives up on some analytic faces (a cone whose parameter range reaches its apex); the same face as
        a NURBS surface meshes fine."""
        nurbs = TopoDS.Face(BRepBuilderAPI_NurbsConvert(face, True).Shape())
        BRepMesh_IncrementalMesh(nurbs, LINEAR_DEFLECTION, False, ANGULAR_DEFLECTION, True)
        location = TopLoc_Location()
        return nurbs, BRep_Tool.Triangulation_s(nurbs, location), location

    def write_meshes(self, out):
        """Writes one m_###.bin per mesh with its triangles grouped by face colour, then each triangle's face id.
        manifest meshes[i]['groups'] lists [appearance, triangle count] in file order; appearance None means the
        body's own colour."""
        triangles = 0
        for index, solid in enumerate(self.solids):
            BRepMesh_IncrementalMesh(solid, LINEAR_DEFLECTION, False, ANGULAR_DEFLECTION, True)
            faces = self._maps(index)[0]
            coords = array.array('f')
            groups = {}  # appearance -> (triangle indices (flat), face id per triangle)
            explorer = TopExp_Explorer(solid, TopAbs_FACE)
            while explorer.More():
                face = TopoDS.Face(explorer.Current())
                face_id = faces.FindIndex(face) - 1
                appearance = self._appearance(self._shape_color(face))
                location = TopLoc_Location()
                tri = BRep_Tool.Triangulation_s(face, location)
                if tri is None:
                    face, tri, location = self._remesh_as_nurbs(face)
                    (self.remeshed if tri is not None else self.unmeshed).append(self.meshes[index]['body'])
                if tri is not None:
                    trsf = location.Transformation()
                    base = len(coords) // 3
                    for n in range(1, tri.NbNodes() + 1):
                        p = tri.Node(n).Transformed(trsf)
                        coords.extend((p.X(), p.Y(), p.Z()))
                    reversed_face = face.Orientation() == TopAbs_REVERSED
                    target, ids = groups.setdefault(appearance, (array.array('I'), array.array('I')))
                    for t in range(1, tri.NbTriangles() + 1):
                        a, b, c = tri.Triangle(t).Get()
                        if reversed_face:
                            b, c = c, b
                        target.extend((base + a - 1, base + b - 1, base + c - 1))
                    ids.extend([face_id] * tri.NbTriangles())
                explorer.Next()
            # The body's own colour first, then face colours in a stable order.
            order = sorted(groups, key=lambda a: (a is not None, a or ''))
            indices, face_ids = array.array('I'), array.array('I')
            for appearance in order:
                indices.extend(groups[appearance][0])
                face_ids.extend(groups[appearance][1])
            self.meshes[index]['groups'] = [[appearance, len(groups[appearance][0]) // 3] for appearance in order]
            with open(os.path.join(out, 'm_%03d.bin' % index), 'wb') as f:
                array.array('I', [len(coords) // 3, len(indices) // 3]).tofile(f)
                coords.tofile(f)
                indices.tofile(f)
                face_ids.tofile(f)
            triangles += len(indices) // 3
        return triangles

    # -- exact geometry for measuring ---------------------------------------------------------------------------------

    def write_measure(self, out):
        """Writes measure.json: per mesh, its vertices, edges and faces in the mesh's frame (mm), numbered like the
        face ids in m_###.bin. pipeline/measure.ts adds the tolerances and writes the file the viewer loads."""
        solids = [self._measure_solid(index) for index in range(len(self.solids))]
        with open(os.path.join(out, 'measure.json'), 'w') as f:
            json.dump({'v': 1, 'solids': solids}, f)

    def _measure_solid(self, index):
        faces, edges, vertices = self._maps(index)
        points = []
        for i in range(1, vertices.Size() + 1):
            points.extend(xyz(BRep_Tool.Pnt_s(TopoDS.Vertex(vertices.FindKey(i)))))
        # A seam (where a closed surface meets itself) or a degenerated edge is nothing anyone can pick.
        hidden = set()
        for i in range(1, faces.Size() + 1):
            face = TopoDS.Face(faces.FindKey(i))
            explorer = TopExp_Explorer(face, TopAbs_EDGE)
            while explorer.More():
                edge = TopoDS.Edge(explorer.Current())
                if BRep_Tool.IsClosed_s(edge, face) or BRep_Tool.Degenerated_s(edge):
                    hidden.add(edges.FindIndex(edge) - 1)
                explorer.Next()
        edge_list = [None if i in hidden else self._edge(TopoDS.Edge(edges.FindKey(i + 1)), vertices, points)
                     for i in range(edges.Size())]
        ends = [(e[1], e[2]) if e else (-1, -1) for e in edge_list]
        face_list = [self._face(TopoDS.Face(faces.FindKey(i + 1)), edges, hidden, ends) for i in range(faces.Size())]
        return {'p': points, 'e': edge_list, 'f': face_list}

    # Edges: [0, a, b] line from vertex a to b; [1, a, b, centre, normal, ref, radius, sweep] arc starting at
    # centre + radius·ref (vertex a), turning about the normal by sweep; [2, a, b, length, middle, polyline] other.

    def _edge(self, edge, vertices, points):
        curve = BRepAdaptor_Curve(edge)
        u1, u2 = curve.FirstParameter(), curve.LastParameter()
        start, end = xyz(curve.Value(u1)), xyz(curve.Value(u2))
        a = vertices.FindIndex(TopExp.FirstVertex_s(edge)) - 1
        b = vertices.FindIndex(TopExp.LastVertex_s(edge)) - 1

        def gap(v, p):
            return math.dist(points[3 * v:3 * v + 3], p)

        # Vertex a sits at the curve's first parameter, whatever the edge's orientation.
        if a >= 0 and b >= 0 and a != b and gap(a, start) + gap(b, end) > gap(b, start) + gap(a, end):
            a, b = b, a
        kind = curve.GetType()
        if kind == GeomAbs_CurveType.GeomAbs_Line and a >= 0 and b >= 0:
            return [0, a, b]
        if kind == GeomAbs_CurveType.GeomAbs_Circle:
            circle = curve.Circle()
            x, y = xyz(circle.XAxis().Direction()), xyz(circle.YAxis().Direction())
            ref = add(scale(x, math.cos(u1)), scale(y, math.sin(u1)))
            arc = [1, a, b, *xyz(circle.Location()), *xyz(circle.Axis().Direction()), *ref, circle.Radius(),
                   min(u2 - u1, TWO_PI)]
            return self._kept(arc, curve, u1, u2, a, b)
        if kind in FREE_FORM_CURVES:
            found = self._recognise_curve(edge)
            if isinstance(found, gp_Lin) and a >= 0 and b >= 0:
                return [0, a, b]
            if isinstance(found, gp_Circ):
                arc = self._arc_through(found, start, xyz(curve.Value((u1 + u2) / 2)), end, a, b)
                return self._kept(arc, curve, u1, u2, a, b)
        return self._curve(curve, u1, u2, a, b)

    def _kept(self, arc, curve, u1, u2, a, b):
        """The arc as the measurement file can hold it, else the line (straight within tolerance) or curve it is."""
        radius, sweep = arc[12], arc[13]
        if sweep >= MIN_SWEEP and (self.max_radius is None or radius < self.max_radius):
            return arc
        sagitta = radius * (1 - math.cos(min(sweep, math.pi) / 2))
        if sagitta < RECOGNITION_TOLERANCE and a >= 0 and b >= 0:
            return [0, a, b]
        return self._curve(curve, u1, u2, a, b)

    @staticmethod
    def _recognise_curve(edge):
        """The line or circle a free-form edge really is, if any: the candidate with the smallest gap."""
        recognition = ShapeAnalysis_CanonicalRecognition(edge)
        best = None
        for shape, test in ((gp_Lin(), recognition.IsLine), (gp_Circ(), recognition.IsCircle)):
            if test(RECOGNITION_TOLERANCE, shape) and (best is None or recognition.GetGap() < best[0]):
                best = (recognition.GetGap(), shape)
            recognition.ClearStatus()
        return best[1] if best else None

    @staticmethod
    def _arc_through(circle, start, middle, end, a, b):
        """A recognised circle comes with an arbitrary frame: orient it so the arc runs from start through middle."""
        centre, x = xyz(circle.Location()), xyz(circle.XAxis().Direction())
        closed = math.dist(start, end) < 1e-6
        for normal in (xyz(circle.Axis().Direction()), scale(xyz(circle.Axis().Direction()), -1)):
            y = cross(normal, x)

            def angle(p):
                v = sub(p, centre)
                return math.atan2(dot(v, y), dot(v, x))

            first = angle(start)
            sweep = TWO_PI if closed else (angle(end) - first) % TWO_PI
            if closed or 0 < (angle(middle) - first) % TWO_PI < sweep:
                break
        ref = add(scale(x, math.cos(first)), scale(y, math.sin(first)))
        return [1, a, b, *centre, *normal, *ref, circle.Radius(), sweep]

    @staticmethod
    def _curve(curve, u1, u2, a, b):
        length = GCPnts_AbscissaPoint.Length_s(curve)
        middle = xyz(curve.Value(GCPnts_AbscissaPoint(curve, length / 2, u1).Parameter()))
        polyline = GCPnts_TangentialDeflection(curve, u1, u2, 0.1, POLYLINE_DEFLECTION)
        points = [c for i in range(1, polyline.NbPoints() + 1) for c in xyz(polyline.Value(i))]
        return [2, a, b, length, *middle, points]

    # Faces: [kind, area, loops, ...] with loops as edge-id lists, outer first. Kinds: 0 plane (outward normal, d with
    # normal·p = d); 1 cylinder (axis start, axis, length, radius, s); 2 cone (apex, axis into the face, half-angle, s);
    # 3 sphere (centre, radius, s); 4 torus (centre, axis, major, minor, s); 5 anything else. s is +1 where the
    # material lies inside the surface (a boss), -1 where it lies outside (a hole).

    def _face(self, face, edges, hidden, ends):
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        head = [props.Mass(), self._loops(face, edges, hidden, ends)]
        surface = BRepAdaptor_Surface(face, True)
        point, normal = self._outward(surface, face)
        kind = surface.GetType()
        if kind == GeomAbs_SurfaceType.GeomAbs_Plane:
            found = self._plane(surface.Plane(), normal)
        elif kind == GeomAbs_SurfaceType.GeomAbs_Cylinder:
            cylinder = surface.Cylinder()
            axis = xyz(cylinder.Axis().Direction())
            origin = add(xyz(cylinder.Axis().Location()), scale(axis, surface.FirstVParameter()))
            length = surface.LastVParameter() - surface.FirstVParameter()
            found = self._cylinder(cylinder, origin, length, point, normal)
        elif kind == GeomAbs_SurfaceType.GeomAbs_Cone:
            found = self._cone(surface.Cone(), point, normal)
        elif kind == GeomAbs_SurfaceType.GeomAbs_Sphere:
            found = self._sphere(surface.Sphere(), point, normal)
        elif kind == GeomAbs_SurfaceType.GeomAbs_Torus:
            found = self._torus(surface.Torus(), point, normal)
        else:
            found = self._recognise_surface(face, surface, point, normal)
        return [*found[:1], *head, *found[1:]] if found else [5, *head]

    @staticmethod
    def _outward(surface, face):
        """A point on the face's surface and the normal there pointing out of the material."""
        u1, u2 = surface.FirstUParameter(), surface.LastUParameter()
        v1, v2 = surface.FirstVParameter(), surface.LastVParameter()
        for fu, fv in ((0.5, 0.5), (0.3, 0.6), (0.7, 0.4)):
            p, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
            surface.D1(u1 + fu * (u2 - u1), v1 + fv * (v2 - v1), p, du, dv)
            n = du.Crossed(dv)
            if n.Magnitude() > 1e-12:
                break
        normal = unit(xyz(n))
        return xyz(p), scale(normal, -1) if face.Orientation() == TopAbs_REVERSED else normal

    @staticmethod
    def _plane(plane, normal):
        n = xyz(plane.Axis().Direction())
        if dot(n, normal) < 0:
            n = scale(n, -1)
        return [0, *n, dot(n, xyz(plane.Location()))]

    @staticmethod
    def _cylinder(cylinder, origin, length, point, normal):
        axis = xyz(cylinder.Axis().Direction())
        side = sign(dot(normal, radial(point, origin, axis)))
        return [1, *origin, *axis, length, cylinder.Radius(), side]

    @staticmethod
    def _cone(cone, point, normal):
        apex, axis = xyz(cone.Apex()), xyz(cone.Axis().Direction())
        if dot(sub(point, apex), axis) < 0:
            axis = scale(axis, -1)
        return [2, *apex, *axis, abs(cone.SemiAngle()), sign(dot(normal, radial(point, apex, axis)))]

    @staticmethod
    def _sphere(sphere, point, normal):
        centre = xyz(sphere.Location())
        return [3, *centre, sphere.Radius(), sign(dot(normal, sub(point, centre)))]

    @staticmethod
    def _torus(torus, point, normal):
        centre, axis = xyz(torus.Location()), xyz(torus.Axis().Direction())
        major, minor = torus.MajorRadius(), torus.MinorRadius()
        if major <= minor:
            return None
        spine = add(centre, scale(unit(radial(point, centre, axis)), major))
        return [4, *centre, *axis, major, minor, sign(dot(normal, sub(point, spine)))]

    def _recognise_surface(self, face, surface, point, normal):
        """A free-form face that really is a plane, cylinder, cone or sphere: the candidate with the smallest gap."""
        recognition = ShapeAnalysis_CanonicalRecognition(face)
        best = None
        for shape, test in ((gp_Pln(), recognition.IsPlane), (gp_Cylinder(), recognition.IsCylinder),
                            (gp_Cone(), recognition.IsCone), (gp_Sphere(), recognition.IsSphere)):
            if test(RECOGNITION_TOLERANCE, shape) and (best is None or recognition.GetGap() < best[0]):
                best = (recognition.GetGap(), shape)
            recognition.ClearStatus()
        if best is None:
            return None
        shape = best[1]
        if isinstance(shape, gp_Pln):
            return self._plane(shape, normal)
        if isinstance(shape, gp_Cylinder):
            # The axis extent from points spread over the face's parameter box.
            axis, base = xyz(shape.Axis().Direction()), xyz(shape.Axis().Location())
            u1, u2 = surface.FirstUParameter(), surface.LastUParameter()
            v1, v2 = surface.FirstVParameter(), surface.LastVParameter()
            heights = [dot(sub(xyz(surface.Value(u1 + i / 4 * (u2 - u1), v1 + j / 4 * (v2 - v1))), base), axis)
                       for i in range(5) for j in range(5)]
            return self._cylinder(shape, add(base, scale(axis, min(heights))), max(heights) - min(heights), point, normal)
        if isinstance(shape, gp_Cone):
            return self._cone(shape, point, normal)
        return self._sphere(shape, point, normal)

    @staticmethod
    def _loops(face, edges, hidden, ends):
        """Edge ids per loop, outer loop first, without seams; a loop is a chain of edges that share vertices."""
        outer = BRepTools.OuterWire_s(face)
        wires = []
        explorer = TopExp_Explorer(face, TopAbs_WIRE)
        while explorer.More():
            wires.append(explorer.Current())
            explorer.Next()
        if not outer.IsNull():
            wires.sort(key=lambda wire: not wire.IsSame(outer))
        loops = []
        for wire in wires:
            ids = []
            walk = TopExp_Explorer(wire, TopAbs_EDGE)
            while walk.More():
                i = edges.FindIndex(walk.Current()) - 1
                if i not in hidden and i not in ids:
                    ids.append(i)
                walk.Next()
            loops.extend(chains(ids, ends))
        return loops


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('step')
    parser.add_argument('out')
    parser.add_argument('--version', type=int, required=True)
    parser.add_argument('--max-radius', type=float, help='arcs at least this wide (mm) become lines or curves')
    args = parser.parse_args()

    start = time.time()
    converter = Converter(args.step, args.max_radius)
    converter.convert()
    os.makedirs(args.out, exist_ok=True)
    triangles = converter.write_meshes(args.out)
    converter.write_measure(args.out)
    manifest = {'doc': converter.root_name, 'version': args.version, 'units': 'mm',
                'occurrences': converter.occurrences, 'bodies': converter.bodies, 'meshes': converter.meshes,
                'appearances': converter.appearances, 'fastener_partners': {}, 'sliders': {}, 'params': {}}
    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f)
    print(f'{converter.root_name} v{args.version}: {len(converter.occurrences)} occurrences, {len(converter.bodies)} bodies, '
          f'{len(converter.meshes)} meshes, {len(converter.appearances)} colours, {triangles:,} triangles, '
          f'{time.time() - start:.1f} s')
    if converter.remeshed:
        print(f'  meshed as NURBS after BRepMesh failed: {len(converter.remeshed)} face(s) in {", ".join(sorted(set(converter.remeshed)))}')
    if converter.unmeshed:
        print(f'  WARNING: {len(converter.unmeshed)} face(s) could not be meshed, they are missing in '
              f'{", ".join(sorted(set(converter.unmeshed)))}')


if __name__ == '__main__':
    main()
