#!/usr/bin/env node
'use strict';
/**
 * Regenerate the MOD update feed from the jar the launcher actually bundles.
 *
 * The mod's VoidUpdater reads this file. It used to point at a separate host that no
 * release step touched, so the version it announced had nothing to do with the jar
 * inside the installer. Deriving the feed from vendor/*.jar means the announced
 * version, size and sha256 are the bundled ones by construction — there is no second
 * value to keep in sync and nothing to forget.
 *
 * Usage: node scripts/update-mod-feed.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'https://github.com/mitsuohiroshi927-png/void-client';
const RAW = 'https://raw.githubusercontent.com/mitsuohiroshi927-png/void-client/main';

const vendorDir = path.join(ROOT, 'vendor');
const jars = fs.existsSync(vendorDir)
  ? fs.readdirSync(vendorDir).filter((f) => /^void-(?:fps|client)-.*\.jar$/i.test(f))
  : [];
if (!jars.length) {
  console.error('FATAL: no bundled mod jar in vendor/ — nothing to describe');
  process.exit(1);
}
// launch.js picks the same way (sort().pop()), so the feed describes the jar that wins.
const name = jars.sort().pop();
const file = path.join(vendorDir, name);
const buf = fs.readFileSync(file);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

// Read the version out of the jar's own manifest rather than from the filename: the
// two disagreeing is exactly how fabric.mod.json once said 0.2.0 for a 0.2.2 build.
const { execFileSync } = require('child_process');
let version = (name.match(/void-(?:fps|client)-(.+)\.jar$/i) || [])[1] || '';
try {
  const manifest = execFileSync('unzip', ['-p', file, 'fabric.mod.json'], { encoding: 'utf8' });
  const v = JSON.parse(manifest).version;
  if (v && !v.includes('${')) version = v;
} catch (e) {
  console.warn(`   warning: could not read fabric.mod.json (${e.message}); using the filename`);
}

const feed = {
  version,
  url: `${RAW}/vendor/${name}`,
  sha256,
  size: buf.length,
};

const targets = [
  path.join(ROOT, 'docs', 'voidfps.json'),
  path.join(ROOT, 'site', 'voidfps.json'),
];
for (const t of targets) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`   ${path.relative(ROOT, t)}: ${version}, ${buf.length} B, ${sha256.slice(0, 12)}...`);
}
console.log(`   bundled mod: vendor/${name}`);
console.log(`   served by:   ${REPO}/releases/latest/download/voidfps.json  (fallback)`);
