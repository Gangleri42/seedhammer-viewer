# SeedHammer viewer

3D viewer for the Seed controller and the Hammer and II engraving machines: section cuts, part visibility, exploded
views, measuring and STEP download. Every view is a shareable link.

- Web: <https://viewer.seedhammer.space>
- Napplet (Nostr): `naddr1qvzqqqyf8ypzq9y7qlnpnmkaxtj826xnr9lrdcns7j6mqjxx7eft74h7jpn8m0ufqyt8wumn8ghj7un9d3shjtn4dee82eeww3jkx6qqp9eksttkd9jhwetjm3azc8`
- Models: [Gangleri42/sh-hardware](https://github.com/Gangleri42/sh-hardware)

## Develop

```sh
npm install
npm run models   # HARDWARE_DIR: full sh-hardware clone (default ../sh-hardware); CONVERT: Python with cadquery-ocp
npm run dev
npm test
npm run build
```

## License

Public domain, see [LICENSE](LICENSE).
