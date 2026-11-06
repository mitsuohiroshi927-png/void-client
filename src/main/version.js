'use strict';
/**
 * One source of truth for the launcher's version.
 *
 * The version used to be typed by hand in eight places — the User-Agent of every network call,
 * the `launcher_version` handed to the game, two `-Dminecraft.launcher.*` flags and two
 * placeholders in the UI. They were all still saying 1.1.1 while the app shipped 1.2.8, which
 * means every Modrinth/Mojang request identified itself as a version that does not exist.
 *
 * Read from package.json rather than from Electron's `app.getVersion()` on purpose: these
 * modules are also loaded in plain Node by verify_launcher.js, and requiring `electron` there
 * would break the offline suite. Inside a packaged app the same path resolves through the asar.
 */

const fs = require('fs');
const path = require('path');

function readVersion() {
  for (const rel of ['../../package.json', '../package.json', './package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
      if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      /* try the next candidate layout */
    }
  }
  return '0.0.0';
}

const VERSION = readVersion();

/** Identifies the launcher to Modrinth, Mojang and the Fabric meta server. */
const UA = `VoidClient/${VERSION} (launcher; +https://github.com/mitsuohiroshi927-png/void-client)`;

module.exports = { VERSION, UA };
