'use strict';
/**
 * Settings + profiles store.
 *
 * Launcher state lives in <appData>/launcher.json — completely separate from the
 * mod's own config/voidfps.properties, so changing launcher settings can never
 * touch VOID FPS in-game settings.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

/**
 * One user-controlled profile. There are no preset cards any more: the user
 * picks their own RAM, resolution and mod set, the way a Modrinth-style launcher
 * works. `ram`/`width`/`height` at 0 means "use the hardware recommendation" —
 * the probe fills it in on first paint, and any explicit value the user types
 * wins from then on.
 *
 * mods.voidFps    : load the bundled VOID FPS (it ships inside the client)
 * mods.extraJar   : mods folder for this profile, gameDir/profiles/<id>/mods
 * mods.inheritShared : also load gameDir/mods (mods installed globally)
 *
 * inheritShared stays false so switching profiles never drags in a mod the user
 * did not add to that profile.
 */
const DEFAULT_PROFILES = {
  default: {
    id: 'default',
    name: 'My Profile',
    description: 'Your own RAM, resolution and mods.',
    ram: 0,          // 0 = use the hardware recommendation
    width: 0,
    height: 0,
    jvmArgs: [],
    mods: { voidFps: true, inheritShared: false, extraJar: true },
    icon: '◆',
  },
};

/**
 * Where the launcher keeps its data. Windows path is unchanged; Linux and macOS use their own
 * conventions rather than a fabricated AppData tree.
 */
function configRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.voidclient');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'void-client');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'void-client');
}

function defaultSettings() {
  const home = os.homedir();
  const sep = path.sep;
  const defaultRoot = configRoot();
  return {
    version: 1,
    mcVersion: '1.21.11',
    curseforgeApiKey: '',
  // Community stats endpoint — server-side JSON (see src/main/stats.js for the contract).
  // Empty = show honest local numbers only ('local only · no endpoint').
  statsUrl: '',
  // The LAUNCHER's own manifest, deliberately NOT the mod's update.json.
  // Both readers parse the top-level `version`, so one shared file cannot describe
  // two different products: bumping it for the installer would tell the in-game mod
  // that 1.0.0 is a new jar and it would fetch the .exe over itself.
  updateUrl: 'https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/launcher.json',
  // Check on launch, but never install without a click: an unattended
  // installer run mid-session would kill the game the user is playing.
  autoUpdate: true,
  // Rich Presence on by default: it is what makes the client feel like a real
  // launcher, and it offends nobody. Never blocks anything if Discord is absent.
  discordRpc: true,
  // Public Discord application id for VOID Client. Baked in so RPC works on a
  // fresh install; the Settings field overrides it for anyone using a fork.
  discordClientId: '1565711043705970778',
    useFabric: true,
    fabricLoader: '',            // empty = resolve newest stable from Fabric meta
    root: defaultRoot,
    gameDir: path.join(defaultRoot, 'game'),
    javaPath: '',                // empty = auto-resolved runtime, else explicit path
    javaRuntime: 'auto',         // auto | managed | system | custom
    autoTune: true,              // adapt RAM/resolution to detected hardware
    hardware: null,              // last probe result (cached for instant UI paint)
    allowSoftwareGpu: true,      // permit booting on llvmpipe/SwiftShader
    safetyMode: false,           // disables experimental JVM flags
    boostFlags: true,            // aggressive GC/startup JVM flags (user toggle)
    profile: 'default',
    ram: 4096,
    width: 1280,
    height: 720,
    extraJvmArgs: '',
    // Keep the launcher alive after Minecraft exits. ON = it stays open,
    // OFF = the launcher closes along with the game.
    keepLauncherOpen: true,
    autoUpdateMod: true,
    voidFpsJarSource: '',        // optional explicit path to a VOID FPS build
    profiles: DEFAULT_PROFILES,
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const base = defaultSettings();
      this.data = {
        ...base,
        ...parsed,
        profiles: { ...base.profiles, ...(parsed.profiles || {}) },
      };
    } catch {
      this.data = defaultSettings();
      await this.save();
    }
    return this.data;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2));
    return true;
  }

  get() {
    return this.data || defaultSettings();
  }

  patch(partial) {
    this.data = { ...this.get(), ...partial };
    return this.save().then(() => this.data);
  }

  /**
   * Resolve the active profile. Any profile left at 0/empty inherits the
   * hardware tuning, so the hardware probe still drives RAM/resolution for the
   * profile the user picked — there is no separate "Auto" entry in the UI.
   */
  activeProfile() {
    const d = this.get();
    const p = { ...(d.profiles[d.profile] || d.profiles.default) };
    const tuned = (d.hardware && d.hardware.tuned) || null;
    if (tuned) {
      if (!p.ram) p.ram = tuned.ramMB;
      if (!p.width) p.width = tuned.width;
      if (!p.height) p.height = tuned.height;
      if (!p.jvmArgs || !p.jvmArgs.length) p.jvmArgs = tuned.jvmArgs.slice();
    }
    if (d.safetyMode) {
      // Strip anything experimental; keep only the heap and encoding flags.
      p.jvmArgs = (p.jvmArgs || []).filter((a) =>
        !/AlwaysPreTouch|DisableExplicitGC|G1.*Percent|HeapRegionSize/.test(a)
      );
    }
    if (!p.ram) p.ram = 4096;
    if (!p.width) p.width = 1280;
    if (!p.height) p.height = 720;
    return p;
  }

  /**
   * Write RAM/resolution into the ACTIVE profile.
   *
   * The adaptive profile must stay adaptive: if the user leaves the value at the
   * hardware-recommended number, we keep the placeholder (0/empty) instead of
   * freezing today's tuning. A value that differs from the recommendation is an
   * explicit override and gets stored verbatim.
   */
  async setProfileValues({ ram, width, height, maxFps }) {
    const d = this.get();
    const key = d.profiles[d.profile] ? d.profile : 'default';
    const p = { ...d.profiles[key] };
    const tuned = (d.hardware && d.hardware.tuned) || null;
    const adaptive = !!p.adaptive;

    const keep = (val, rec) => (adaptive && tuned && val === rec ? 0 : val);

    if (ram != null) p.ram = keep(Number(ram), tuned ? tuned.ramMB : 0);
    if (width != null) p.width = keep(Number(width), tuned ? tuned.width : 0);
    if (height != null) p.height = keep(Number(height), tuned ? tuned.height : 0);
    if (maxFps != null) p.maxFps = Number(maxFps) || 0;

    d.profiles[key] = p;
    return this.save().then(() => this.data);
  }

  /**
   * Settings with the active profile already merged in. The renderer's summary
   * bar reads ram/width/height from here, so it can never disagree with the
   * selected profile card.
   */
  resolved() {
    const d = this.get();
    const p = this.activeProfile();
    return {
      ...d,
      ram: p.ram,
      width: p.width,
      height: p.height,
      maxFps: p.maxFps,
      jvmArgs: p.jvmArgs,
      // The panel needs the user's stored values, not just the resolved ones, so
      // it can tell "you chose 6 GB" apart from "the probe recommended 4 GB".
      storedProfile: {
        id: d.profile,
        ram: (d.profiles[d.profile] || {}).ram || 0,
        width: (d.profiles[d.profile] || {}).width || 0,
        height: (d.profiles[d.profile] || {}).height || 0,
      },
      resolvedProfile: { id: d.profile, name: p.name, ram: p.ram, width: p.width, height: p.height },
    };
  }
}

module.exports = { Store, defaultSettings, DEFAULT_PROFILES };
