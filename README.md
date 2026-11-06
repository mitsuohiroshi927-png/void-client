# VOID Client

A fast, lightweight Minecraft Java launcher — with the performance client already inside it.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20%7C%20Linux-3b82f6)
![Minecraft](https://img.shields.io/badge/Minecraft-1.21.x-3b82f6)
![Version](https://img.shields.io/badge/version-1.2.8-3b82f6)

## Download

**[Latest release](https://github.com/mitsuohiroshi927-png/void-client/releases/latest)** — Windows 10/11 (64-bit) installer, or the Linux AppImage / tar.gz.

> Windows may show **"Windows protected your PC"** when you run the installer. That is
> SmartScreen flagging an unsigned app — **not** a virus. Click **More info → Run anyway**.
> This repository is public precisely so you can read what you are running.

Verify your download (the sha256 for every release is in `launcher.json` next to it):

```
Get-FileHash .\VOID-Client-<version>-Setup.exe -Algorithm SHA256
sha256sum VOID-Client-<version>-x86_64.AppImage
```

## Features

- Every Minecraft **1.21.x** version, Fabric Loader preinstalled
- **VOID Client** (the mod, id `voidfps`) bundled and loaded via `-Dfabric.addMods` — never
  dropped into `mods/`, so it can never collide with a copy you installed yourself
- **Modrinth** mod browser built in, mods isolated per profile
- Per-profile **Minecraft version, loader, RAM, resolution and JVM flags**
- **Crosshair Studio**: design the crosshair on a large live preview
- In-game menu in dark gray and blue, with motion that follows real frame time and can be off
- Several Microsoft accounts side by side, with the player's head in the top-right chip
- Automatic **Java 21** provisioning (Temurin, SHA-256 verified)
- **Auto-update**: checks, downloads, verifies the hash and installs once the game is closed
- Lightweight by design: Electron + plain Node, **no runtime dependencies beyond Electron**

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (64-bit) or a Linux desktop (x86_64) |
| RAM | 4 GB minimum, 8 GB recommended |
| GPU | OpenGL 3.2 |
| Java | Not required — provisioned automatically |

## How it works

The launcher is Electron with plain Node in the main process. It resolves a Minecraft version
manifest, installs Fabric, provisions a Java runtime, builds the JVM argument list and spawns
the game. The bundled mod is passed through `-Dfabric.addMods` so it loads without ever entering
the profile's `mods/` directory, and whether it may attach at all is decided from the range the
jar declares for itself (`src/main/mcver.js`) rather than a hardcoded table.

## Layout

```
src/main/        Electron main process (launcher core)
src/renderer/    UI (plain HTML/CSS/JS, no framework)
src/main/version.js   the only place the version is written down
site/            the download site served by Cloudflare Pages
docs/            the GitHub Pages copy — also the launcher's PRIMARY update feed
scripts/         release.sh (build, publish, deploy) · update-site.js (the ONLY writer of
                 site/, docs/ and the four manifests)
vendor/          the bundled mod jar
legacy/          the pre-Electron web version, kept for reference — not built or loaded
```

## Verification

```bash
node verify_launcher.js          # 130+ assertions: feeds, pages, launch args, update path
```

The mod lives in its own repository and carries its own headless load test
(`gradle build` then `tools/verify-client.sh`: `GAME_LOADED=yes`, `MIXIN_ERRORS=0`).

## Releasing

One command, and the mod version must equal the launcher version:

```bash
bash scripts/release.sh 1.2.8 "what changed"      # needs GH_TOKEN + CLOUDFLARE_API_TOKEN
```

It builds the Windows installer **and** the Linux AppImage/tar.gz, refreshes every feed and both
copies of the pages, publishes the GitHub release, deploys Cloudflare Pages, and pushes `docs/`
so the primary feed goes live. It refuses to publish if the bundled mod jar is a different
version from the release.

## Updates

The launcher polls its primary feed first, then the release asset as a fallback:

```
https://mitsuohiroshi927-png.github.io/void-client/launcher.json
https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/launcher.json
```

Keep the `sha256` in both manifests in sync with the artifacts or the update is rejected — that
check exists so a corrupted or swapped download can never be run.

## Disclaimer

VOID Client is an independent project, not affiliated with Mojang or Microsoft.
Minecraft is a trademark of Mojang Synergies AB.
