"""Converts a STEP assembly into the manifest + mesh files that pipeline/build-model.ts reads.

Same format as export/fusion (occurrence tree with world matrices, body instances, shared meshes, appearances),
but in millimetres and built with OpenCascade, so it runs anywhere without Fusion.

    python export/step/step_to_manifest.py <model.step> <out dir> --version <n>
"""
import argparse
import array
import json
import os
import time

from OCP.BRep import BRep_Tool
from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.collections import Sequence_TDF_Label
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_ColorRGBA, Quantity_TypeOfColor
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_Tool
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

LINEAR_DEFLECTION = 0.01  # mm; the pipeline simplifies afterwards
ANGULAR_DEFLECTION = 0.3  # rad
COLOR_TYPES = (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen)


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


class Converter:
    def __init__(self, path):
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
        self.remeshed = []  # bodies with a face that only meshed as NURBS
        self.unmeshed = []  # bodies with a face that did not mesh at all (a hole in the viewer)

    # -- colours ------------------------------------------------------------------------------------------------------

    def _label_color(self, label):
        rgba = Quantity_ColorRGBA()
        for kind in COLOR_TYPES:
            if self.colors.GetColor(label, kind, rgba):
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
        """Writes one m_###.bin per mesh with its triangles grouped by face colour. manifest meshes[i]['groups'] lists
        [appearance, triangle count] in file order; appearance None means the body's own colour."""
        triangles = 0
        for index, solid in enumerate(self.solids):
            BRepMesh_IncrementalMesh(solid, LINEAR_DEFLECTION, False, ANGULAR_DEFLECTION, True)
            coords = array.array('f')
            groups = {}  # appearance -> triangle indices (flat)
            explorer = TopExp_Explorer(solid, TopAbs_FACE)
            while explorer.More():
                face = TopoDS.Face(explorer.Current())
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
                    target = groups.setdefault(appearance, array.array('I'))
                    for t in range(1, tri.NbTriangles() + 1):
                        a, b, c = tri.Triangle(t).Get()
                        if reversed_face:
                            b, c = c, b
                        target.extend((base + a - 1, base + b - 1, base + c - 1))
                explorer.Next()
            # The body's own colour first, then face colours in a stable order.
            order = sorted(groups, key=lambda a: (a is not None, a or ''))
            indices = array.array('I')
            for appearance in order:
                indices.extend(groups[appearance])
            self.meshes[index]['groups'] = [[appearance, len(groups[appearance]) // 3] for appearance in order]
            with open(os.path.join(out, 'm_%03d.bin' % index), 'wb') as f:
                array.array('I', [len(coords) // 3, len(indices) // 3]).tofile(f)
                coords.tofile(f)
                indices.tofile(f)
            triangles += len(indices) // 3
        return triangles


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('step')
    parser.add_argument('out')
    parser.add_argument('--version', type=int, required=True)
    args = parser.parse_args()

    start = time.time()
    converter = Converter(args.step)
    converter.convert()
    os.makedirs(args.out, exist_ok=True)
    triangles = converter.write_meshes(args.out)
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
