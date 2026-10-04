#!/usr/bin/env sh
# kicad-cli from KiCad's own image, pinned by digest (KiCad 10.0.6 with its 3D library), for CI:
# KICAD_CLI=scripts/kicad-docker.sh. The working directory is mounted at its own path, so the paths the pipeline passes
# mean the same inside; the container has no network and runs as the calling user, so its files stay writable.
set -eu
exec docker run --rm --network none --platform linux/amd64 --user "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$PWD:$PWD" -w "$PWD" \
	kicad/kicad@sha256:e36e29b5f4a638a1a7238eba3d2fcbc8e061ffed1e99a8f39cb722706c94a58e kicad-cli "$@"
