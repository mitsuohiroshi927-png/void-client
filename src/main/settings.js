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
    name: 'Performance',
    description: 'Sodium, Lithium, FerriteCore and the VOID Client bundle.',
    ram: 0,          // 0 = use the hardware recommendation
    width: 0,
    height: 0,
    jvmArgs: [],
    // ships WITH the performance set: this is the profile that makes the client fast.
    mods: { voidFps: true, inheritShared: false, extraJar: true },
    icon: '◆',
    seeded: true,    // the one profile pre-loaded with performance mods
    hidden: true,    // never shown in the UI: it is the "Performance mods" template
  },
};

/**
 * The id of the first profile the user can actually see.
 *
 * `default` is a hidden TEMPLATE (the performance mod set that new profiles copy
 * from), so it must not be what we fall back to for "the active profile". On a
 * fresh install there may be no visible profile at all yet, in which case this
 * returns null and the caller should ask the user to create one.
 */
function firstVisibleProfile(profiles) {
  const all = profiles || {};
  for (const [id, p] of Object.entries(all)) {
    if (p && !p.hidden) return id;
  }
  return null;
}

/** Resolve the active profile id: the stored one if visible, else the first visible. */
function activeProfileId(profiles, wanted) {
  const all = profiles || {};
  if (wanted && all[wanted] && !all[wanted].hidden) return wanted;
  return firstVisibleProfile(all);
}

/**
 * Where the launcher keeps its data.
 *
 * Windows keeps `%APPDATA%\.voidclient` exactly as before, so nothing moves for anyone already
 * using the app. Linux and macOS get the directory each platform expects instead of inheriting a
 * Windows path that only worked because it was made up on the fly.
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
  // Primary manifest on the project site, GitHub Releases as the automatic fallback.
  updateUrl: 'https://voidclient.my.id/launcher.json',
  updateUrlFallback: 'https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/launcher.json',
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
    profile: null,   // null = none chosen yet; the user creates the first profile
    ram: 4096,
    width: 1280,
    height: 720,
    extraJvmArgs: '',
    // Keep the launcher alive after Minecraft exits. ON = it stays open,
    // OFF = the launcher closes along with the game.
    keepLauncherOpen: true,
    autoUpdateMod: true,
    // Anonymous online counter: a one-way, day-salted hash of a random install
    // id — no usernames, no accounts. The Settings row turns it off entirely.
    onlineOptOut: false,
    autoInstall: true,
    // Optional outbound HTTP proxy (e.g. http://127.0.0.1:8080) for networks
    // where Modrinth/CurseForge are blocked. Empty = connect directly.
    proxyUrl: '',
    voidFpsJarSource: '',        // optional explicit path to a VOID FPS build
    profiles: DEFAULT_PROFILES,
    // UI language (i18n.js dictionaries). English is the default and the
    // fallback for any missing key in another language.
    lang: 'en',
    // First-run onboarding (pick a language, sign in) shows once, then never
    // again; flipping it false re-runs the wizard on the next start.
    onboarded: false,
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
      // Legacy profiles stored the "attach my own mods folder" flag as `extras`,
      // which the launcher never read — installed mods silently never loaded.
      // Rename it in place so existing installs start working without the user
      // having to recreate profiles.
      for (const [id, p] of Object.entries(this.data.profiles || {})) {
        if (!p) continue;
        if (id === 'default') {
          // `default` is the hidden performance TEMPLATE, not a user profile.
          // Anyone upgrading already has it, so it must not suddenly appear in
          // their list as an extra profile they never made.
          p.hidden = true;
          p.seeded = true;
        } else if (p.hidden === undefined) {
          // Every other profile came from the user — always visible.
          p.hidden = false;
        }
        if (!p.mods) continue;
        if (p.mods.extraJar === undefined && p.mods.extras !== undefined) {
          p.mods.extraJar = p.mods.extras !== false;
        }
        delete p.mods.extras;
      }
      // A stored active profile that is the hidden template must be re-pointed at
      // something the user can actually see, or the Play button looks broken.
      if (this.data.profile && this.data.profiles[this.data.profile] &&
          this.data.profiles[this.data.profile].hidden) {
        this.data.profile = firstVisibleProfile(this.data.profiles);
      }
      // The same applies to an id that no longer exists at all (profile deleted,
      // or a launcher.json restored from an older install). Leaving it as a
      // dangling string is what breaks every caller that builds a path from it:
      // path.join(dir, 'profiles', null) throws ERR_INVALID_ARG_TYPE and takes
      // down the whole page that asked. One repair here beats a guard in each
      // of a dozen handlers.
      if (this.data.profile && !this.data.profiles[this.data.profile]) {
        this.data.profile = firstVisibleProfile(this.data.profiles);
      }
      await this.save();
    } catch (e) {
      // NEVER reset to defaults just because a read failed. A transient failure
      // (file mid-write, EPERM, momentary lock) would otherwise wipe every
      // profile the user ever made, and `await this.save()` below would make
      // that loss permanent on disk. Keep whatever we already hold in memory,
      // and only fall back to defaults when there is genuinely nothing.
      const code = e && e.code;
      if (code === 'ENOENT') {
        // First run: no file yet. Defaults are correct here.
        this.data = defaultSettings();
        await this.save();
      } else {
        // Real read error: keep the last known-good state in memory and report
        // it instead of destroying data. The file on disk stays untouched.
        if (!this.data) this.data = defaultSettings();
        this.lastLoadError = e && e.message ? e.message : String(e);
        console.error('[settings] load failed, keeping in-memory state:', this.lastLoadError);
      }
    }
    return this.data;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    // Write to a temp file then rename: rename is atomic on the same
    // filesystem, so a crash or kill mid-write can never leave a truncated
    // launcher.json behind. Without this, losing power during a save could
    // destroy every profile at once.
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2));
    await fsp.rename(tmp, this.file);
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
  async setProfileValues({ ram, width, height }) {
    const d = this.get();
    const key = activeProfileId(d.profiles, d.profile);
    if (!key) return this.save().then(() => this.data);   // no visible profile yet
    const p = { ...d.profiles[key] };
    const tuned = (d.hardware && d.hardware.tuned) || null;
    const adaptive = !!p.adaptive;

    const keep = (val, rec) => (adaptive && tuned && val === rec ? 0 : val);

    if (ram != null) p.ram = keep(Number(ram), tuned ? tuned.ramMB : 0);
    if (width != null) p.width = keep(Number(width), tuned ? tuned.width : 0);
    if (height != null) p.height = keep(Number(height), tuned ? tuned.height : 0);

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

module.exports = { Store, defaultSettings, DEFAULT_PROFILES, firstVisibleProfile, activeProfileId };
