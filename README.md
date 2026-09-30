# SeedHammer viewer

A web viewer for the Seed controller and the Hammer and II engraving machines. It shows the latest CAD version of each
in 3D: section cuts, per-part visibility, exploded views, measuring, and a STEP download. Every view is encoded in the
URL hash, so a link opens exactly what you were looking at.

## Develop

```sh
npm install
npm run dev              # http://localhost:5173
npm test                 # hash grammar, intent payloads, manifests, privacy rules, the built models and napplet
npm run check            # svelte-check
npm run build            # static site in build/
npm run models           # converts the STEP files of a full sh-hardware clone into static/models
npm run build:napplet    # the napplet, one file in dist-napplet/ (after npm run models)
```

`npm run models` reads the clone from `HARDWARE_DIR` and runs the converter with `CONVERT`, a Python that has
`cadquery-ocp` installed. `.github/workflows/pages.yml` does all of this and deploys to GitHub Pages at
<https://viewer.seedhammer.space/>. For a deploy under `/<repo>/` instead, build with `BASE_PATH=/<repo>`.

## Using the viewer

- Light and dark follow the system setting.
- Drag to orbit, right-drag or two fingers to pan, scroll or pinch to zoom. `F` fits the view, `Esc` clears the
  selection.
- Click a part to select it. The parts panel shows it in the Fusion tree, with "Show only" and "Hide".
- Section: up to three planes along X, Y or Z (Fusion's axes, millimetres). A new plane removes the half facing the
  camera; "Flip" keeps the other half. Cut faces are hatched in the part's colour.
- Explode: sub-assemblies move apart first, then their parts. Fasteners pull out along their own axis.
- Measure (`I`), as in Fusion: click two faces, edges or points and read the shortest distance between them, the
  angle, and for two circles or holes the centre distance with its minimum and maximum. One item alone shows its
  length, area, radius, diameter or position. Hold ⌘/Ctrl to pick circle centres, midpoints and ends; Shift hides
  them; on a touch screen, a circle's Centre button does the same. Values come from the exact CAD geometry; a value
  marked ≈ is measured on the displayed mesh instead, within a few hundredths of a millimetre (free-form surfaces).
  Measuring always uses the assembled model, so the explode goes back to 0 while Measure is open. `Esc` clears the
  measurement, a second `Esc` closes the tool.

## Share links

```
#/seed                                         latest version, default view
#/hammer@41?hide=k3x9a1&cut=x:12.5&ex=0.6      pinned to v41, a part hidden, section at x = 12.5 mm, 60 % exploded
#/seed?iso=0f2kq7&cut=y:-66.1!&cam=60,-130,70;100,-66,0&ortho=1
#/seed@15?m=k3x9a1.f12.q7,0f2kq7.c40.3b        a measurement on v15: a face and a circle's centre
```

| key     | value                                                                 |
| ------- | --------------------------------------------------------------------- |
| `@v`    | pinned version; without it the link follows the latest                |
| `hide`  | part ids to hide                                                      |
| `iso`   | show only these parts                                                 |
| `cut`   | `axis:offset` in mm, `!` keeps the positive side; up to three          |
| `ex`    | explode, 0 to 1                                                       |
| `cam`   | camera position; target; orthographic zoom                            |
| `sel`   | selected part                                                         |
| `m`     | up to two measured items; a route with them always names its version  |
| `edges` | `0` hides edge lines                                                  |
| `ortho` | `1` for orthographic                                                  |

Part ids are a short hash of the part's place in the assembly (`frame:1+side_plates:1`), so a part keeps its id across
versions as long as it keeps its name and parent; ids of parts that no longer exist are dropped with a notice.

A measured item is `<body id>.<kind><number>.<check>`, the kind being `f` face, `e` edge, `v` vertex, `c` centre of a
circle or `m` midpoint of an edge. The numbers hold within one version's geometry, which is why the version comes
along; the two check characters, taken from the item's size, drop an item that no longer matches instead of measuring
something else.

## Where the models come from

The models live in [Gangleri42/sh-hardware](https://github.com/Gangleri42/sh-hardware) as STEP files, one per model
version: `seed/Seed-v<n>.step`, `hammer/Hammer-v<n>.step` and `II/II-v<n>.step`. Every version in the history stays
available, frozen at the commit that added its file, so a pinned link shows the same model forever. A later change to
a published file is left out with a warning; a new export gets a new version number. A push to sh-hardware that
touches a model triggers a rebuild here; a daily build is the fallback.

1. `export/step/step_to_manifest.py` reads a STEP with OpenCascade (`cadquery-ocp`) and writes the assembly tree,
   colours and meshes, each triangle with the id of its CAD face, and the exact geometry of every face, edge and
   vertex (planes, cylinders, cones, spheres, tori, lines, arcs).
2. `pipeline/build-model.ts` simplifies the meshes (`pipeline/models.json` sets the tolerance per model and per
   component) without letting a triangle straddle two faces, splits normals at 30° creases, draws feature edges and
   writes a GLB whose `_FACEID` vertex attribute names each triangle's face. `pipeline/measure.ts` writes the exact
   geometry, with each solid's measured mesh tolerance, as `v<n>.measure.json.gz` (see `src/lib/measure/format.ts`),
   which the Measure tool loads when it opens.
3. `pipeline/build-all.ts` does this for every version it finds, caches each result by the STEP file's git blob, zips
   the STEP for download and writes `static/models/index.json`.

Nothing built is committed: the site is assembled in CI. The pipeline checks every STEP and GLB against
`scripts/privacy-rules.mjs` and refuses one that carries private data.

STEP carries colours but no materials. Face colours come through as they are (a chip's black body, its silver pins);
metal and glass come from `materials` in `pipeline/models.json`, taken from the Fusion appearances. Metal applies to
faces in the body's own colour, glass to the whole body, with opacity following the tint.

## On Nostr

The same build is also published on Nostr, signed by one identity: as an nsite (NIP-5A), as a napplet (NIP-5D), with
every file on several Blossom servers, and with the source on ngit (NIP-34). GitHub Pages stays as a mirror.
`.nsite/config.json` holds the identity, the site id, the relays and the servers.

| What                          | Event                                        | Where                                          |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Files (`build/`)              | Blossom blobs, by sha256                     | the servers in `.nsite/config.json`            |
| Site manifest                 | kind 35128, `d=sh-viewer`, one snapshot 5128 | the relays in `.nsite/config.json`             |
| Napplet manifest              | kind 35129, `d=sh-viewer`, one snapshot 5129 | the same relays                                |
| Relay list and server list    | kinds 10002 and 10063                        | the same relays plus the lookup relays gateways use |
| Repository                    | kinds 30617 and 30618                        | the GRASP relays                               |

The site is served by any nsite gateway at `https://<pubkey in base36><site id>.<gateway>/`. `npm run publish:nostr`
is the maintainer's publisher and refuses to run outside its publishing environment.

### Open the napplet

The napplet's address follows the latest version:

```
naddr1qvzqqqyf8ypzq9y7qlnpnmkaxtj826xnr9lrdcns7j6mqjxx7eft74h7jpn8m0ufqyt8wumn8ghj7un9d3shjtn4dee82eeww3jkx6qqp9eksttkd9jhwetjm3azc8
```

Paste it into a napplet host, such as [Kehto Paja](https://kehto.github.io/web/paja/) in a browser or
[Myco](https://github.com/Origami74/myco) on Android.

### Verify, without any key

```sh
npm run verify:nostr            # HEAD every file on every server
npm run verify:nostr -- --full  # download and hash them
```

With [nak](https://github.com/fiatjaf/nak), using a relay and a server from `.nsite/config.json`: fetch the manifest,
check the signature and recompute the aggregate.

```sh
nak req -k 35128 -a <hex pubkey> -d sh-viewer <relay> | nak verify
nak req -k 35128 -a <hex pubkey> -d sh-viewer <relay> \
  | jq -r '.tags[] | select(.[0]=="path") | "\(.[2]) \(.[1])"' | sort | sha256sum   # equals the x tag
curl -s <server>/<sha256> | sha256sum                                              # equals the path tag
```

### Deep links

On the web the route stays in the URL hash: `https://viewer.seedhammer.space/#/hammer@41?cut=x:12.5!`. A gateway never
sees the fragment, so it works on every nsite host. In a napplet shell there is no URL; the same route travels as an
intent, `napplet:cad-viewer/open?route=%2Fhammer%4041%3Fcut%3Dx%3A12.5!`, whose query becomes the payload `{ route }`
on the INC topic `napplet:cad-viewer/open` (or `cad-viewer:open`, after the viewer emits `cad-viewer:ready`, the way
stlstr delivers). `{ model, version }` is accepted as a weaker payload. The share menu offers all three link kinds.

The napplet is one file, `dist-napplet/index.html`, built with `npm run build:napplet`: the latest model of each kind
and its measurement file are inlined (a model marked `"napplet": false` in `pipeline/models.json` is left out of the
napplet, so the file stays under its size limit), older versions are fetched through the shell's `resource`
capability by hash, the STEP opens through `link`, colours follow `theme`. `npm run test:conformance` runs the NAP conformance suite,
`npm run paja` opens it in the Paja workshop, and `npm run dev:shell` serves a small shell at
<http://127.0.0.1:4180/> that delivers intents, flips the theme and logs every envelope.

## Privacy check

`scripts/privacy-rules.mjs` lists what must never be published: local paths, email addresses, Autodesk ids, IP
addresses, Nostr secrets and signer sessions, Claude session links. The git hooks in `.githooks` apply it to staged
files, commit messages and pushed commits, and refuse commits whose dates are not UTC (commit with `TZ=UTC`). CI and
the publisher run the same check over the whole tree and history. Terms that are private in themselves cannot be listed
in a public file; they go in `~/.config/seedhammer/private-terms`, one per line, or in the `PRIVATE_TERMS` secret for
CI. Enable the hooks once per clone:

```sh
git config core.hooksPath .githooks
```

## License

Public domain, see [LICENSE](LICENSE). Same as the other SeedHammer repositories.
