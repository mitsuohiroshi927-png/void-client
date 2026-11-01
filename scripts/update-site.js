#!/usr/bin/env node
'use strict';
/**
 * Rewrite the parts of site/ that must track the current release.
 *
 * The download pages hardcode the version, the installer size and the sha256 in
 * their "verify your download" block. A stale hash there tells users their
 * perfectly good installer is corrupt, so these values are regenerated from the
 * freshly built artifact instead of being edited by hand.
 *
 * Also refreshes site/_redirects: the installer is far over the Cloudflare Pages
 * 25 MiB per-file cap, so each installer path must be redirected to GitHub
 * Releases BEFORE the Pages SPA fallback can swallow the request and answer 200
 * with the homepage.
 *
 * Usage: node scripts/update-site.js <version> <sha256> <sizeBytes>
 */

const fs = require('fs');
const path = require('path');

const [, , VER, SHA, SIZE_RAW] = process.argv;
if (!VER || !SHA || !SIZE_RAW) {
  console.error('usage: update-site.js <version> <sha256> <sizeBytes>');
  process.exit(2);
}
const SIZE = Number(SIZE_RAW);
if (!/^\d+\.\d+\.\d+$/.test(VER)) throw new Error(`bad version: ${VER}`);
if (!/^[0-9a-f]{64}$/.test(SHA)) throw new Error(`bad sha256: ${SHA}`);
if (!Number.isFinite(SIZE) || SIZE <= 0) throw new Error(`bad size: ${SIZE_RAW}`);

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const EXE = `VOID-Client-${VER}-Setup.exe`;
const REPO = 'https://github.com/mitsuohiroshi927-png/void-client';
const MB = Math.round(SIZE / 1048576);

/* ------------------------------------------------------------- download pages */

let rewrites = 0;
for (const name of ['index.html', 'download.html']) {
  const file = path.join(SITE, name);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');

  const after = before
    // installer filename, in hrefs, code samples and prose alike
    .replace(/VOID-Client-\d+\.\d+\.\d+-Setup\.exe/g, EXE)
    // "Version 1.2.2" (index) and "Versi 1.2.2" (download)
    .replace(/\bVersion \d+\.\d+\.\d+/g, `Version ${VER}`)
    .replace(/\bVersi \d+\.\d+\.\d+/g, `Versi ${VER}`)
    // size appears as "122 MB installer", "122 MB &middot;", "&middot; 117 MB"
    .replace(/\b\d+ MB\b/g, `${MB} MB`)
    // the published checksum
    .replace(/\b[0-9a-f]{64}\b/g, SHA);

  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`   rewritten site/${name}`);
    rewrites += 1;
  }
}
if (!rewrites) console.warn('   WARNING: no download page contained release placeholders');

/* ------------------------------------------------------------------ redirects */

const REDIRECTS = path.join(SITE, '_redirects');
let lines = fs.readFileSync(REDIRECTS, 'utf8').split('\n');

const isRule = (l) => l.trim() && !l.trim().startsWith('#');
const newRule = `/VOID-Client-${VER}-Setup.exe  ${REPO}/releases/download/v${VER}/${EXE}  302`;
// releases/latest/download/<file> matches by FILENAME inside the newest release,
// so this alias must name the current asset or it 404s despite "latest" resolving.
const aliasRule = `/latest/VOID-Client-Setup.exe  ${REPO}/releases/latest/download/${EXE}  302`;

// Keep comments and older version rules (they still serve pinned downloads);
// drop any prior /latest alias so exactly one survives.
const rules = lines.filter((l) => isRule(l) && !l.startsWith('/latest/'));
const comments = lines.filter((l) => !isRule(l) && !l.startsWith('/latest/'));
const rulesWithoutDup = rules.filter((l) => !l.startsWith(`/VOID-Client-${VER}-Setup.exe`));

fs.writeFileSync(
  REDIRECTS,
  `${comments.join('\n').replace(/\n+$/, '')}\n${newRule}\n${rulesWithoutDup.join('\n')}\n${aliasRule}\n`,
);

const check = fs.readFileSync(REDIRECTS, 'utf8');
const aliasCount = check.split('\n').filter((l) => l.startsWith('/latest/')).length;
if (aliasCount !== 1) throw new Error(`expected exactly 1 /latest rule, found ${aliasCount}`);
if (check.split('\n').filter(isRule).length < 2) throw new Error('_redirects lost its rules');
if (check.includes('302/VOID-Client')) throw new Error('_redirects has a spliced rule');

console.log(`   _redirects: added ${VER}, pinned /latest -> ${EXE}`);
console.log(`   site pages: version ${VER}, ${MB} MB, sha256 ${SHA.slice(0, 12)}...`);
