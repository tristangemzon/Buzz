# Code signing

Buzz builds unsigned by default — releases work on all three platforms but Windows users see a SmartScreen warning the first time. To sign the Windows installer, the release pipeline reads two environment variables (also recognised by `electron-builder`):

- `CSC_LINK` — either a `file:///` URL or an HTTPS URL pointing to a `.pfx` certificate, or a base64-encoded `.pfx`. The repository's GitHub Actions release job picks this up automatically as `WIN_CSC_LINK` (mapped via the release workflow).
- `CSC_KEY_PASSWORD` — the password for the `.pfx`. Same mapping (`WIN_CSC_KEY_PASSWORD`).

If you have an EV token instead of a `.pfx`, set `signtoolOptions.certificateSubjectName` in `electron-builder.yml` and clear the env vars — `electron-builder` will then call `signtool` against the local cert store.

macOS signing is already wired via Xcode hardened runtime + entitlements (`build/entitlements.mac.plist`). Set `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` in the release environment to enable notarization.

Crash dumps are written to `<userData>/crashes/` and are **never uploaded** — Buzz's `crashReporter` starts with `uploadToServer: false`.
