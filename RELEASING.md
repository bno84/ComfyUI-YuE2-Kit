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
2. Set every template node's `ver` to the version it was released with: this
   pack's new version for its own nodes, and for Audio Visualizer and ABC
   Preview the releases CI tests against (`AUDIOVISUALIZER_REF`,
   `ABCPREVIEW_REF`). ComfyUI only updates `ver` when a node is saved, so it
   falls behind otherwise. `tests/test_template_versions.py` checks this.
   Commit it with the version.
3. Push `main`: `git push origin main`. Wait for CI to pass on that exact
   commit before tagging. If another commit is added, wait for its CI too.
4. Create a signed, annotated tag on the tested commit. Its message becomes
   the Registry changelog:

   ```bash
   git tag -s vX.Y.Z -m "Short summary

   Longer notes for the Registry's Updates section."
   ```

5. Push only the tag: `git push origin vX.Y.Z`. The tag workflow repeats
   the checks and publishes only after they pass.

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
  ComfyUI-Manager is installed. The Song API prompt must supply all required
  AudioVisualizer inputs from the installed dependency schema.

The ComfyUI version tested is `COMFYUI_REF` in the workflow. Keep it equal to
`requires-comfyui` in `pyproject.toml` when raising either.

If a check fails, nothing is published. Fix it, then move the tag
(`git tag -d vX.Y.Z`, `git push origin :refs/tags/vX.Y.Z`) and push again.
Treat a published version as final; release fixes as a new version.
