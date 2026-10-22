# SeedHammer 3D viewer

3D viewer for the Seed controller and the Hammer and II engraving machines: section cuts, part visibility, exploded
views, measuring and STEP download. Every view is a shareable link.

- Web: <https://viewer.seedhammer.space>
- Napplet (Nostr): `naddr1qvzqqqyf8ypzq9y7qlnpnmkaxtj826xnr9lrdcns7j6mqjxx7eft74h7jpn8m0ufqyt8wumn8ghj7un9d3shjtn4dee82eeww3jkx6qqp9eksttkd9jhwetjm3azc8`
- Models: [Gangleri42/sh-hardware](https://github.com/Gangleri42/sh-hardware)
- Boards: [seedhammer/hardware](https://github.com/seedhammer/hardware), the KiCad sources, fitted into each model

The viewer is [stepstr](https://github.com/Gangleri42/stepstr), a STEP viewer for the browser and for Nostr, built
for this site with its models. This repository holds what makes it the SeedHammer viewer: the site's settings
(`.nsite/config.json`), the catalogue of models and boards, and stepstr itself as a submodule (`stepstr/`).

## Versions

Every commit that changed a model's STEP file is a version, named by that commit's short hash. A link to a version
reads `#/hammer@119c2ba`; `#/hammer` opens the newest and then shows which one it is, and Share offers a link that
always opens the latest. A link naming a version the viewer does not list opens the latest and says so. The STEP
menu downloads the file from the hardware repository at that commit.

Each version comes converted ahead, so it opens in seconds: the files are on Blossom servers, named by their sha256,
and the viewer checks every byte it gets. A file opened from this device, or a link to any other STEP file, is
converted in the browser as stepstr does everywhere.

## Boards

The Seed, the Hammer and the II each have a board in [seedhammer/hardware](https://github.com/seedhammer/hardware). Each
revision of a board whose 3D shape changed is exported with KiCad and listed beside the model, the newest twenty of
each. Where a version's CAD board lines up with KiCad's, the viewer shows the chosen revision in its place (`b=` in a
link names it); otherwise the version shows its board as in CAD.

## Develop

```sh
git submodule update --init
(cd stepstr && npm ci && npm run converter:fetch)
npm ci
npm test
npm run catalogue   # converts every version and board revision into catalogue.json and catalogue-files/
npm run build       # the web page, into build/
npm run build:napplet   # the napplet, into dist-napplet/
npm run test:napplet    # stepstr's checks of the napplet: what a shell's sandbox forbids, the manifest
```

`npm run catalogue` reads a full clone of the hardware repository (`HARDWARE_DIR`, default `../sh-hardware`) and of
the board repository (`UPSTREAM_DIR`, default `../seedhammer-hardware`), and runs KiCad 10's `kicad-cli` (`KICAD_CLI`,
default the Mac app). Conversions are cached in `.cache/`, so a second run converts only what is new.

## License

Public domain, see [LICENSE](LICENSE).
