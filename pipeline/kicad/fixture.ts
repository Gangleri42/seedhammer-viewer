// A small board in KiCad 10's format for the tests: parts on and off the board, a connector whose origin lies past the
// edge while its courtyard overlaps, a model in the engineer's own checkout, a hidden model, a part without one, and
// the copper the 3D export ignores.
export const BOARD = `(kicad_pcb
	(version 20260206)
	(generator "pcbnew")
	(net 0 "")
	(footprint "Resistor_SMD:R_0402_1005Metric"
		(layer "F.Cu")
		(uuid "11111111-1111-1111-1111-111111111111")
		(at 10 20 90)
		(property "Reference" "R1"
			(at 0 0 0)
		)
		(model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step"
			(offset
				(xyz 0 0 0)
			)
			(scale
				(xyz 1 1 1)
			)
			(rotate
				(xyz 0 0 0)
			)
		)
	)
	(footprint "mainboard:TS3USB221"
		(at 30 25)
		(property "Reference" "U13")
		(model "/opt/work/hardware/lib/RSE0010A.stp"
			(scale
				(xyz 1 1 1)
			)
		)
		(model "\${KICAD10_3DMODEL_DIR}/Package_DFN_QFN.3dshapes/Texas_UQFN-10_1.5x2mm_P0.5mm.step"
			(hide yes)
		)
	)
	(footprint "Inductor_SMD:L_0805_2012Metric"
		(at 40 30)
		(property "Reference" "L6")
		(model "\${KICAD10_3DMODEL_DIR}/Inductor_SMD.3dshapes/L_0805_2012Metric.step"
			(scale
				(xyz 1 1 1)
			)
		)
	)
	(footprint "Resistor_SMD:R_0402_1005Metric"
		(at 200 20)
		(property "Reference" "R99")
		(model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step")
	)
	(footprint "TestPoint:TestPoint_Pad_1.5x1.5mm"
		(at 15 15)
		(property "Reference" "TP1")
	)
	(footprint "mainboard:USB_C_Receptacle_MidMnt"
		(at 101.5 25 90)
		(property "Reference" "J9")
		(fp_rect (start -3 -2) (end 3 2) (layer "F.CrtYd") (width 0.05))
		(model "\${KICAD10_3DMODEL_DIR}/Connector_USB.3dshapes/USB_C_Receptacle.step")
	)
	(gr_line (start 0 0) (end 100 0) (layer "Edge.Cuts") (uuid "aaaaaaaa-0000-0000-0000-000000000001"))
	(gr_line (start 100 0) (end 100 50) (layer "Edge.Cuts"))
	(gr_line (start 100 50) (end 0 50) (layer "Edge.Cuts"))
	(gr_line (start 0 50) (end 0 0) (layer "Edge.Cuts"))
	(gr_text "a (tricky) \\"string\\" (" (at 5 5) (layer "F.SilkS"))
	(segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 0) (uuid "22222222-2222-2222-2222-222222222222"))
	(arc (start 1 1) (mid 1.5 1.2) (end 2 1) (width 0.2) (layer "F.Cu") (net 0))
	(via (at 3 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0))
	(zone (net 0) (layer "F.Cu") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
)
`;
