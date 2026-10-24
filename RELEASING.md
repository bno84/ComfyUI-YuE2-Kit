# Releasing

Releases are tag-driven. `.github/workflows/ci.yml` runs the checks on every
push and pull request. A pushed `v*` tag also publishes to the
[Comfy Registry](https://registry.comfy.org/publishers/bno84), after the checks
pass.

## One-time setup

Create a personal access token on the Registry publisher page. Add it to this
repository as an Actions secret named `REGISTRY_ACCESS_TOKEN` (Settings →
Secrets and variables → Actions).

## Release

1. Set the new version in `pyproject.toml` (`X.Y.Z`, semantic versioning).
   Commit it, e.g. `build: releases X.Y.Z`.
2. Create a signed, annotated tag. Its message becomes the Registry changelog:

   ```bash
   git tag -s vX.Y.Z -m "Short summary

   Longer notes for the Registry's Updates section."
   ```

3. Push the commit and the tag: `git push origin main vX.Y.Z`.

## What CI checks before publishing

- The tag matches the `pyproject.toml` version.
- `comfy node validate`: Registry metadata and comfy-cli's security scan.
  The scan's rules (`exec`, `eval`, one-line multi-statements) fail here,
  although comfy-cli itself only warns for now.
- Python and frontend unit tests.
- ComfyUI loads the pack on CPU: no import failure, all node types register,
  and the pack's routes answer. Example workflows may only use node types
  that this ComfyUI and pack provide; nodes from other packs are skipped. Every
  backend node needs a pack entry (`cnr_id`): ComfyUI only adds them when
  ComfyUI-Manager is installed.

The ComfyUI version tested is `COMFYUI_REF` in the workflow. Keep it equal to
`requires-comfyui` in `pyproject.toml` when raising either.

If a check fails, nothing is published. Fix it, then move the tag
(`git tag -d vX.Y.Z`, `git push origin :refs/tags/vX.Y.Z`) and push again.
Treat a published version as final; release fixes as a new version.
