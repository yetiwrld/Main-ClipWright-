# Contributing

Short version: run the checks, keep the specs and the code in agreement, and do
not let the app claim more than it does.

## Before you open a pull request

```bash
pnpm typecheck
pnpm lint        # design tokens + no-fakes/determinism
pnpm test
```

All three must pass. CI runs exactly these, plus a secret scan and a check that
`THIRD-PARTY-NOTICES.txt` is current (`node scripts/release/make-notices.mjs --check`).

## Rules that are not negotiable

Four things get a pull request rejected regardless of how good the rest of it is:

1. **No unmeasured claims.** If the app shows a number, it comes from a real
   measurement — ffprobe, ebur128, a file on disk. `docs/verification.md` is the
   record of what is proven; a feature whose verification is missing is listed
   there as unverified, not implied to work.
2. **No silent downgrades.** If something cannot be done as asked, say so. An
   export that cannot include audio fails with a message rather than producing a
   silent file. A check that cannot be measured reports "not measured", never
   "pass".
3. **Fail closed on security.** An update that cannot be verified is refused. A
   pack whose checksums do not match is not partially imported. A binary whose
   hash does not match is disabled, not run.
4. **Design tokens only in the renderer.** `pnpm lint` enforces it: no hard-coded
   hex colours, pixel radii or millisecond durations.

## Tests

- Anything that touches a real process gets a test that runs the real process.
  Export tests spawn the bundled ffmpeg; the release script test runs the real
  signing code.
- Generate real fixtures rather than mocking media (`makeMovingSource()`).
- A test that passes because the fixture is empty is worse than no test.

## Commits

Conventional Commits, e.g. `feat(export): mix real audio into the exported file`.
Explain *why* in the body — particularly for a bug fix, say what the failure
looked like before, so the next person recognises it.

## Specs

`specs/` is binding. Code cites sections (`SPEC 14 §5.5`). If you need to deviate,
record it in `docs/decisions.md` with the reason, in the same pull request.

## Documentation

If your change makes a documented behaviour different, the documentation is part
of the change:

| Changed | Update |
|---|---|
| A user-visible behaviour | `docs/` — the page a user would read |
| What is verified | `docs/verification.md` |
| A new limitation | `docs/limitations.md` |
| A release-visible change | `CHANGELOG.md` under `[Unreleased]` |

## Security

Do not open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
