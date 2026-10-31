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
 * Profiles are self-contained launch presets: each one owns its RAM, resolution,
 * JVM flags and — importantly — its own mod set. Switching profiles never pulls
 * in a mod the user did not add to that profile.
 *
 * mods.voidFps    : load the bundled VOID FPS (it ships inside the client)
 * mods.extraJar   : per-profile mods folder, gameDir/profiles/<id>/mods
 * mods.inheritShared : also load gameDir/mods (mods the user installed globally)
 *
 * Default is inheritShared:false everywhere, because the user asked for profiles
 * that start with NOTHING but what they put there.
 */
const DEFAULT_PROFILES = {
  vanilla: {
    id: 'vanilla',
    name: 'Vanilla',
    description: 'Clean 1.21.x — only VOID FPS, no extra mods.',
    ram: 2048,
    width: 1280,
    height: 720,
    jvmArgs: [],
    mods: { voidFps: true, inheritShared: false, extraJar: true },
    icon: '◇',
  },
  auto: {
    id: 'auto',
    name: 'Auto',
    description: 'Tuned automatically for this PC on first launch.',
    ram: 0,                      // 0 = use hardware.tuned value
    width: 0,
    height: 0,
    jvmArgs: [],                 // empty = use hardware.tuned jvmArgs
    mods: { voidFps: true, inheritShared: false, extraJar: true },
    adaptive: true,
    icon: '✦',
  },
  pvp: {
    id: 'pvp',
    name: 'PvP',
    description: 'Low latency, high frame priority. Add your own combat mods.',
    ram: 3072,
    width: 1280,
    height: 720,
    jvmArgs: [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=20',
      '-XX:+DisableExplicitGC',
      '-XX:G1NewSizePercent=30',
      '-XX:G1HeapRegionSize=8M',
    ],
    mods: { voidFps: true, inheritShared: false, extraJar: true },
    icon: '⚔',
  },
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    description: 'Vanilla-feel settings with VOID FPS enabled.',
    ram: 4096,
    width: 1280,
    height: 720,
    jvmArgs: ['-XX:+UseG1GC', '-XX:+UnlockExperimentalVMOptions', '-XX:G1NewSizePercent=20', '-XX:MaxGCPauseMillis=50'],
    mods: { voidFps: true, inheritShared: false, extraJar: true },
    icon: '◐',
  },
  fps: {
    id: 'fps',
    name: 'FPS Boost',
    description: 'Aggressive GC tuning and a small render window for weak GPUs.',
    ram: 2048,
    width: 960,
    height: 540,
    jvmArgs: [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-XX:G1NewSizePercent=40',
      '-XX:G1HeapRegionSize=4M',
      '-XX:G1ReservePercent=20',
    ],
    mods: { voidFps: true, inheritShared: false, extraJar: true },
    icon: '⚡',
  },
};

function defaultSettings() {
  const home = os.homedir();
  const sep = path.sep;
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const defaultRoot = path.join(appData, '.voidclient');
  return {
    version: 1,
    mcVersion: '1.21.11',
    curseforgeApiKey: '',
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
    profile: 'auto',
    ram: 4096,
    width: 1280,
    height: 720,
    extraJvmArgs: '',
    closeLauncherOnLaunch: true,
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
   * Resolve the active profile. Adaptive profiles carry 0/empty placeholders
   * which are filled from the hardware probe, so the same profile id produces
   * a 2 GB / 854x480 setup on a netbook and 8 GB / 1600x900 on a gaming PC.
   */
  activeProfile() {
    const d = this.get();
    const p = { ...(d.profiles[d.profile] || d.profiles.balanced) };
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
    const key = d.profiles[d.profile] ? d.profile : 'balanced';
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
      resolvedProfile: { id: d.profile, name: p.name, ram: p.ram, width: p.width, height: p.height },
    };
  }
}

module.exports = { Store, defaultSettings, DEFAULT_PROFILES };
