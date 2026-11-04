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
const crypto = require('crypto');

const [, , VER, SHA, SIZE_RAW, NOTES] = process.argv;
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
// Decimal MB, because that is the number the user sees on GitHub and in Windows.
// Dividing by 1048576 wrote "117 MB" for a 122,290,350-byte installer and quietly
// contradicted every other place the size is quoted.
const MB = Math.round(SIZE / 1e6);

/* Linux artifact, built separately by `electron-builder --linux`. The download pages
 * advertise it, so a missing AppImage is a hard error (see the gate below) rather than a
 * warning: a Linux button that 404s is worse than no button at all. */
const APPIMAGE = `VOID-Client-${VER}-x86_64.AppImage`;
const appImagePath = path.join(ROOT, 'dist-linux', APPIMAGE);
const hasLinux = fs.existsSync(appImagePath);
const appImageSha = hasLinux ? crypto.createHash('sha256').update(fs.readFileSync(appImagePath)).digest('hex') : '';
const appImageSize = hasLinux ? fs.statSync(appImagePath).size : 0;
const LINUX_MB = Math.round(appImageSize / 1e6);

/* ------------------------------------------------------------- download pages */

let rewrites = 0;
for (const name of ['index.html', 'download.html']) {
  const file = path.join(SITE, name);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');

  const after = before
    // installer filename, in hrefs, code samples and prose alike
    .replace(/VOID-Client-\d+\.\d+\.\d+-Setup\.exe/g, EXE)
    // the Linux artifact, in hrefs and prose alike
    .replace(/VOID-Client-\d+\.\d+\.\d+-x86_64\.AppImage/g, APPIMAGE)
    // "Version 1.2.2" (index) and "Versi 1.2.2" (download)
    .replace(/\bVersion \d+\.\d+\.\d+/g, `Version ${VER}`)
    .replace(/\bVersi \d+\.\d+\.\d+/g, `Versi ${VER}`)
    // size appears as "122 MB installer", "122 MB &middot;", "&middot; 117 MB"
    .replace(/\b\d+ MB\b/g, `${MB} MB`)
    // the published checksum
    .replace(/\b[0-9a-f]{64}\b/g, SHA)
    // The Linux size and hash DIFFER from the installer's, and the blanket rules above
    // would stamp the Windows values onto the Linux block (a bogus "your download is
    // corrupt" report). These marked spans are therefore rewritten LAST, so they win.
    .replace(/(<span[^>]*id="linux-size"[^>]*>)[^<]*(<\/span>)/g, (m, a, b) => `${a}${LINUX_MB} MB${b}`)
    .replace(/(<span[^>]*data-linux-size[^>]*>)[^<]*(<\/span>)/g, (m, a, b) => `${a}${LINUX_MB} MB${b}`)
    .replace(/(<code id="linux-sha">)[^<]*(<\/code>)/g, (m, a, b) => `${a}${appImageSha}${b}`);

  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`   rewritten site/${name}`);
    rewrites += 1;
  }
}
// A page that already carries every current value legitimately rewrites nothing, so
// "0 rewrites" is not an error. What IS an error is a page that never mentions this
// release at all — that means the placeholder was deleted or renamed and the page
// would ship pointing at an old installer.
const missingPage = ['index.html', 'download.html'].filter(
  (n) => {
    const f = path.join(SITE, n);
    return fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes(EXE);
  },
);
if (missingPage.length) throw new Error(`site page(s) never reference ${EXE}: ${missingPage.join(', ')}`);

/* The Linux block must carry the values of the artifact that was actually built: a stale
 * Linux size or hash reads exactly like a corrupt download. Also refuse to ship a page
 * that advertises a Linux build which is not in this checkout. */
if (!hasLinux) {
  throw new Error(
    `download pages advertise Linux but dist-linux/${APPIMAGE} is missing — `
    + 'build it (electron-builder --linux) or remove the Linux block from the pages',
  );
}
for (const rel of ['site/download.html', 'docs/download.html', 'site/index.html', 'docs/index.html']) {
  const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const bad = [];
  if (!t.includes(APPIMAGE)) bad.push(`does not name ${APPIMAGE}`);
  // Two marker forms are supported: id="linux-size" (download page's verify block) and
  // data-linux-size (the download dropdown rows). Either way the number must be the
  // AppImage's, never the installer's.
  if (!/id="linux-size"|data-linux-size/.test(t)) bad.push('lost the Linux size marker');
  else if (!t.includes(`${LINUX_MB} MB`)) bad.push(`Linux size is not ${LINUX_MB} MB`);
  if (rel.endsWith('download.html')) {
    if (!t.includes('id="linux-sha"')) bad.push('lost the Linux checksum marker');
    else if (!t.includes(appImageSha)) bad.push('Linux sha256 is not the built AppImage hash');
  }
  if (bad.length) throw new Error(`${rel}: ${bad.join('; ')}`);
}
/* URL sanity on every page. A doubled absolute URL (host spliced in twice) 404s on
 * GitHub Pages, and an absolute URL where a bare filename belongs turns the copy-paste
 * verification command into nonsense. Both shipped once; both are now fatal. */
for (const rel of ['site/index.html', 'site/download.html', 'docs/index.html', 'docs/download.html']) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  if (/github\.com[^"'<]*github\.com/.test(t)) throw new Error(`${rel}: doubled absolute URL`);
  if (/<code>[^<]*https?:\/\//.test(t)) throw new Error(`${rel}: absolute URL inside <code> (want a bare filename)`);
}

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

/* --------------------------------------------------------- download pages (docs/)
 *
 * docs/ is the GitHub Pages copy of the same pages, but it links to Releases with
 * ABSOLUTE urls, so the version appears twice in every href (tag dir + filename).
 * Nothing regenerated them before, which is how docs/ drifted a release behind site/.
 */
for (const name of ['index.html', 'download.html']) {
  const file = path.join(ROOT, 'docs', name);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = before
    .replace(/VOID-Client-\d+\.\d+\.\d+-Setup\.exe/g, EXE)
    .replace(/VOID-Client-\d+\.\d+\.\d+-x86_64\.AppImage/g, APPIMAGE)
    .replace(/\/releases\/download\/v\d+\.\d+\.\d+\//g, `/releases/download/v${VER}/`)
    .replace(/\bVersion \d+\.\d+\.\d+/g, `Version ${VER}`)
    .replace(/\bVersi \d+\.\d+\.\d+/g, `Versi ${VER}`)
    .replace(/\b\d+ MB\b/g, `${MB} MB`)
    .replace(/\b[0-9a-f]{64}\b/g, SHA)
    // marked Linux values LAST: they differ from the installer's, and the blanket rules
    // above (which run first) would otherwise stamp the Windows values onto them.
    .replace(/(<span[^>]*id="linux-size"[^>]*>)[^<]*(<\/span>)/g, (m, a, b) => `${a}${LINUX_MB} MB${b}`)
    .replace(/(<span[^>]*data-linux-size[^>]*>)[^<]*(<\/span>)/g, (m, a, b) => `${a}${LINUX_MB} MB${b}`)
    .replace(/(<code id="linux-sha">)[^<]*(<\/code>)/g, (m, a, b) => `${a}${appImageSha}${b}`);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`   rewritten docs/${name}`);
  }
}

/* ---------------------------------------------------------- launcher manifests
 *
 * Four copies exist (site/ + docs/, launcher.json + launcher-site.json) and they are
 * hand-maintained, so they drift. They drifted badly: version said 1.2.5 with the
 * 1.2.5 sha256 while primary/mirror/urls still named the 1.2.4 installer. updater.js
 * checks EVERY candidate against the same sha256, so that mirror list was not a
 * fallback — it was a guaranteed failure that only fired when the primary was down.
 *
 * Rule enforced here: every URL in the manifest must serve THIS release. Both the
 * pinned tag URL and the /latest/ alias are byte-identical, so the hash gate passes
 * on whichever answers first.
 */
const pinnedUrl = `${REPO}/releases/download/v${VER}/${EXE}`;
const latestUrl = `${REPO}/releases/latest/download/${EXE}`;

/*
 * The manifest gains a `linux` entry whenever the AppImage exists (its version, hash and
 * size were read at the top of this file), because otherwise updater.js falls through to
 * the single-platform branch and offers a LINUX user the Windows .exe. The AppImage is
 * ~127 MB, far over the Pages per-file limit, so it needs its own redirect rule too.
 */
if (hasLinux) {
  const alias = `/latest/VOID-Client.AppImage`;
  const rule = `/${APPIMAGE}  ${REPO}/releases/download/v${VER}/${APPIMAGE}  302`;
  let lines = fs.readFileSync(REDIRECTS, 'utf8').split('\n');
  const isRule = (l) => l.trim() && !l.trim().startsWith('#');
  const kept = lines.filter((l) => isRule(l) && !l.startsWith('/latest/VOID-Client.AppImage') && !l.startsWith(`/${APPIMAGE}`));
  const comments = lines.filter((l) => !isRule(l) && !l.startsWith('/latest/VOID-Client.AppImage'));
  const aliasRule = `${alias}  ${REPO}/releases/latest/download/${APPIMAGE}  302`;
  fs.writeFileSync(REDIRECTS, `${comments.join('\n').replace(/\n+$/, '')}\n${rule}\n${kept.join('\n')}\n${aliasRule}\n`);
  console.log(`   _redirects: added ${APPIMAGE} (${Math.round(appImageSize / 1e6)} MB, release-hosted)`);
} else {
  console.warn('   WARNING: dist-linux AppImage not found — manifest will stay Windows-only');
}

const MANIFESTS = [
  'site/launcher.json',
  'site/launcher-site.json',
  'docs/launcher.json',
  'docs/launcher-site.json',
];
let manifests = 0;
for (const rel of MANIFESTS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.version = VER;
  // Notes are what the updater DIALOG shows. Leaving them hand-written meant a
  // 1.2.5 update announced itself as "Update 1.2.3." forever.
  if (NOTES) m.notes = NOTES;
  m.platforms = m.platforms || {};
  const w = (m.platforms.win32 = m.platforms.win32 || {});
  w.url = pinnedUrl;
  w.primary = latestUrl;
  w.mirror = pinnedUrl;
  w.urls = [latestUrl];
  w.sha256 = SHA;
  w.size = SIZE;
  // A Linux copy must find a Linux artifact here; without it pickAsset() falls back to
  // "only one platform present" and hands the .exe to a Linux user.
  if (hasLinux) {
    const l = (m.platforms.linux = m.platforms.linux || {});
    l.url = `${REPO}/releases/download/v${VER}/${APPIMAGE}`;
    l.primary = `${REPO}/releases/latest/download/${APPIMAGE}`;
    l.mirror = l.url;
    l.urls = [l.primary];
    l.sha256 = appImageSha;
    l.size = appImageSize;
  } else {
    delete m.platforms.linux;
  }
  // Refuse to write a manifest whose own URLs cannot possibly pass verification.
  for (const plat of ['win32', 'linux']) {
    const e = m.platforms[plat];
    if (!e) continue;
    const want = plat === 'win32' ? EXE : APPIMAGE;
    for (const u of [e.url, e.primary, e.mirror, ...(e.urls || [])]) {
      if (!u.includes(want)) throw new Error(`${rel}: stale ${plat} URL survives regeneration: ${u}`);
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  manifests += 1;
}
if (!manifests) throw new Error('no launcher manifest found to update');
console.log(`   manifests: ${manifests} files -> ${VER} (win32${hasLinux ? ' + linux' : ''}), `
  + `all mirrors serve their own platform's artifact`);
