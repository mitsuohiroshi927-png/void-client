# Releasing VOID Client

One command cuts a release: build the installer, verify it, refresh the update
feed and the download site, publish to GitHub Releases, deploy to Cloudflare
Pages.

```bash
VOIDFPS_FEEDBACK_URL='https://discord.com/api/webhooks/<id>/<token>' \
  scripts/release.sh 1.2.3 "Short headline for the release notes"
```

## Prerequisites

- `gh auth login` with `repo` scope (for `gh release create`)
- `npx wrangler login`, or a `CLOUDFLARE_API_TOKEN` that can deploy Pages

Neither credential belongs in this repo. Do not commit a token, and do not paste
one into a chat: rotate anything that has been shared.

## Why the webhook is passed as an env var

`launch.js` is bundled into the installer's `app.asar`. Anything written into
that file is readable by whoever downloads the `.exe`, via `asar extract`. A
webhook URL is a write-only credential, but it still lets a stranger post into
the feedback channel, so it is never a literal in the source.

The launch engine resolves it at runtime, first hit wins:

1. `VOIDFPS_FEEDBACK_URL` env var (build time — this is what `release.sh` uses)
2. `<userData>/voidfps-feedback.url` (operator-side, no rebuild needed)
3. nothing → seeding is skipped and feedback stays local-only

It is then copied into the Minecraft config dir as `config/voidfps-feedback.url`,
and **only if that file does not already exist** — a file the user created wins,
always. See `config/README-voidfps-feedback.txt`.

## What lives where

- `site/` — the public download site. Committed, because this is source.
- `dist/` — build output. Gitignored: `electron-builder` wipes it.
- `scripts/release.sh` — the release pipeline.
- `scripts/update-site.js` — rewrites the version, size and sha256 that the
  download pages display, plus `site/_redirects`.

## Two things that break releases quietly

**A truncated installer.** Packaging can die and leave a ~296 KB NSIS stub where
the ~120 MB installer should be. `release.sh` refuses to publish anything under
50 MB, because a dead file in the feed breaks auto-update for every user.

**A stale asset name in `/latest`.** GitHub resolves
`releases/latest/download/<file>` by *filename inside the newest release*, not by
following a symlink. So the `/latest/VOID-Client-Setup.exe` alias must name the
current asset, or it 404s even though "latest" itself resolves correctly.
`update-site.js` repoints it on every release and asserts exactly one
`/latest/` rule survives.

`site/index.html` and `site/download.html` print the sha256 by hand. A stale hash
tells users their good installer is corrupt, which is why `update-site.js`
rewrites them rather than leaving it to a manual edit.

## The installer is not served by Pages

It is ~117 MB, far over the Cloudflare Pages 25 MiB per-file cap. Every installer
path is redirected by `site/_redirects` to GitHub Releases. Without a rule the
Pages SPA fallback answers missing files with **HTTP 200 and the homepage**, so a
broken download link looks like a successful one.

## Verify after deploying

```bash
curl -s https://mitsuohiroshi927-png.github.io/void-client/launcher.json | head -5
curl -sI https://mitsuohiroshi927-png.github.io/void-client/VOID-Client-1.2.4-Setup.exe | head -3  # expect 200
```

That host needs a proxy for outbound HTTPS on this machine
(`HTTPS_PROXY=http://127.0.0.1:28118`), and so does `electron-builder` when it
fetches its toolchain.
