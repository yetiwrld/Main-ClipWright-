# Changelog

All notable changes to Clipwright Studio are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).
Release notes on GitHub are generated from the matching section of this file, so
what a user reads on the release page is what was reviewed in the pull request.

## [1.0.0] — 2026-11-07

The first release.

### Added

- **Export engine.** Renders the timeline to MP4/WebM with hardware encoding
  where it works and a verified software fallback, a real audio mix, and 18
  validation checks measured against the produced file rather than assumed.
- **Updates.** Checks GitHub Releases, verifies every release against a signed
  manifest, and installs only what it can verify and only when asked.
- **Packaging.** A per-user NSIS installer and a portable executable, both x64.

### Known issues

- Frame blending is not implemented; frame-rate conversion uses nearest-time
  selection.
- Text, effects, transitions and keyframed transforms are not yet rendered by
  the export path (see `docs/limitations.md`).

[Unreleased]: https://github.com/yetiwrld/Main-ClipWright-/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yetiwrld/Main-ClipWright-/releases/tag/v1.0.0
