---
name: evenup-release
description: >
  How to version, document, build and ship EvenUp: version and versionCode bumps, CHANGELOG release notes,
  README/docs updates, the GitHub Actions APK + GitHub Release workflow, APK signing (why updates fail with
  "App not installed"), the order of backend deploy vs app release, and server-side data maintenance (dedupe).
  Use when the owner asks to release, bump a version, update release notes or docs, build an APK, deploy the
  backend, or when an update won't install.
---

# Releasing EvenUp

## 1. Version

- `app.json`: `expo.version` (semver shown to users) and `expo.android.versionCode` (integer; **must increase on
  every release**, Android refuses lower or equal codes). Keep `package.json` `version` equal to `expo.version`
  (`npm version X.Y.Z --no-git-tag-version`).
- Semver: patch = fixes only; minor = features/behaviour changes; major = breaking for users or servers.
- Never change `android.package` (`com.splitmate.app`), the iOS bundle id, `scheme` (`splitmate`) or the `slug`.
  A different package is a different app: users can't update and lose their on-device data.

## 2. Release notes and docs

- Add `## X.Y.Z — YYYY-MM-DD` at the top of `CHANGELOG.md`. The workflow copies exactly this section into the
  GitHub Release (heading format matters: `## ` + version as the 2nd word).
- Write for people installing the app: **New / Changed / Fixed / Upgrading**, plain language, what they will notice.
  Put a short "Server operators" paragraph first when a server deploy or migration is required.
- Features and architecture changes also go into the README files (`README.md`, `relay/README.md`,
  `backend/README.md`, `DATABASE_README.md`, `SIGNING.md`); bug fixes stay in the CHANGELOG.
- Update the skills (`.agents/skills/`) when a rule, trap or architecture fact changed.

## 3. Build and publish (GitHub Actions `build-apk.yml`)

| Trigger | Result |
|---|---|
| commit message with `[build]` / `[apk]` / `build:` on main, master or feat/** | APK as a workflow artifact |
| commit with `[release]` / `release:` on those branches, a `v*` tag, or **Actions → Build Android APK → Run workflow** (any branch, "Publish/Update GitHub Release" ticked) | APK `EvenUp-X.Y.Z.apk` attached to GitHub Release `vX.Y.Z` with the CHANGELOG notes |

- Pushing to `dev` builds nothing automatically: use the manual run on `dev`, or merge to `main` with `[release]` in
  the head commit.
- The job runs typecheck + tests first; a failing test stops the release.

## 4. Signing (why an update says "App not installed")

- Android installs an update only if package name, signing certificate and a higher versionCode all match.
- Every release must be signed with the release key, SHA-256 `87:7F:6B:CA:…:5D:22` (full value in `SIGNING.md`).
  The workflow refuses to publish a release without the keystore secrets or with a different certificate, and
  prints the fingerprint in the log and the release notes.
- Check any APK: `node scripts/apk-signer.mjs file.apk`. Builds from EAS (`npm run build:apk`), local debug builds or
  builds without secrets use other keys and can never update a release install (and vice versa). Install only
  release APKs on real users' phones.
- Secrets `SPLITMATE_KEYSTORE_BASE64`, `_PASSWORD`, `SPLITMATE_KEY_ALIAS`, `SPLITMATE_KEY_PASSWORD`: keep the names.

## 5. Deploy order

1. **Server first.** Deploy the backend/relay version the app needs (e.g. 2.2.0 needs the Python backend's
   `{"error","message"}` responses). Run new Postgres migrations (`npm --prefix relay run migrate` with the target
   `DATABASE_URL`) before or together with the server.
2. Verify: `curl https://evenup.ramzankhan.shop/health` and `/health/db`; an unknown group must return
   `{"error":"GROUP_NOT_FOUND",…}` (not `{"detail":…}`).
3. Then publish the app release.

Python backend deployment: Docker behind Nginx Proxy Manager; forward to `172.17.0.1:8080` (host) or the container
name on the shared network, never a container IP; Force SSL on (release APKs only allow https). See
`backend/README.md`.

## 6. Production data and maintenance

- Never start a server with a production `DATABASE_URL` by accident; never run ad-hoc writes on production without
  the owner's explicit approval of the exact rows.
- Read production only inside a READ ONLY transaction; print aggregates, not personal records.
- Transactions uploaded twice: `npm --prefix relay run dedupe` (dry run) → show the owner the list → `-- --apply`
  after approval. It deletes through `/sync/push` so phones get tombstones. Hidden rows must be made visible
  first or their delete won't reach phones.
- Never `DELETE` synchronized rows in SQL and never "remove" by setting `is_display=false`.

## 7. Release checklist

- [ ] `npm test`, typecheck, lint, backend pytest, relay typecheck green
- [ ] `ui-audit.mjs` shows no new findings; `swipe-check.mjs` passes
- [ ] `expo.version`, `versionCode`, `package.json` version bumped
- [ ] `CHANGELOG.md` section for the version; README/skills updated for features/architecture
- [ ] Server deployed and verified (if the release needs it)
- [ ] Commit (owner asked), then manual workflow run or `[release]` on main
- [ ] Release log shows "Signing with your release key." and the expected certificate fingerprint
