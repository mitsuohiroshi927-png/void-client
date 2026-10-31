# VOID Client

A fast, lightweight Minecraft Java launcher for Windows.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-3b82f6)
![Minecraft](https://img.shields.io/badge/Minecraft-1.21.x-3b82f6)

## Download

**[Download the latest installer](https://github.com/mitsuohiroshi927-png/void-client/releases/latest)** (Windows 10/11, 64-bit)

> Windows may show **"Windows protected your PC"** when you run the installer. That is
> SmartScreen flagging an unsigned app — **not** a virus. Click **More info → Run anyway**.
> This repository is public precisely so you can read what you are running.

Verify your download:

```
Get-FileHash .\VOID-Client-1.0.0-Setup.exe -Algorithm SHA256
```

## Features

- Every Minecraft **1.21.x** version, Fabric Loader 0.20.1 preinstalled
- **VOID FPS** bundled and loaded via `-Dfabric.addMods` — never dropped into `mods/`
- **Modrinth** mod browser built in, content isolated per profile
- Resolution **Auto** (follows your hardware) or **Custom**
- Automatic **Java 21** provisioning (Temurin, SHA-256 verified)
- Auto RAM allocation and anti-stutter JVM flags
- Discord Rich Presence, community stats, toast notifications
- Lightweight by design: Electron + plain Node, **no runtime dependencies beyond Electron**

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11, 64-bit |
| RAM | 4 GB minimum, 8 GB recommended |
| GPU | OpenGL 3.2 |
| Java | Not required — provisioned automatically |

## How it works

The launcher is Electron with plain Node in the main process. It resolves a Minecraft
version manifest, installs Fabric, provisions a Java runtime, builds the JVM argument list,
and spawns the game. The bundled VOID FPS mod is passed through `-Dfabric.addMods` so it
loads without ever entering the profile's `mods/` directory.

## Layout

```
src/main/       Electron main process (launcher core)
src/renderer/   UI (plain HTML/CSS/JS, no framework)
build/          Icons and packaging assets
```

## Updates

The launcher polls:

```
https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/launcher.json
```

Publishing an update means attaching a new installer plus an updated `launcher.json` to a
release. Keep the `sha256` in the manifest in sync with the installer or the update will be
rejected — that check exists so a corrupted download can never be run.

## Disclaimer

VoID Client is an independent project, not affiliated with Mojang or Microsoft.
Minecraft is a trademark of Mojang Synergies AB.
