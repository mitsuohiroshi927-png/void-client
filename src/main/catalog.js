'use strict';
/**
 * Mod catalog: search + install from Modrinth and CurseForge.
 *
 * Modrinth exposes a public, key-free v2 API — that's the primary source.
 * CurseForge requires a registered API key (`x-api-key`), so that path is
 * enabled only when the user pastes one into Settings; without a key the panel
 * says so instead of failing silently.
 *
 * Both providers are normalised into one shape:
 *   { source, id, slug, name, author, description, iconUrl, downloads,
 *     categories, versions: [], latest: { url, filename, size, hashes } }
 */
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'VoidClient/1.1.1 (launcher; +https://mitsuohiroshi927-png.github.io/void-client)';
const MODRINTH = 'https://api.modrinth.com/v2';
const CURSEFORGE = 'https://api.curseforge.com/v1';

/**
 * Fetch JSON with a real error message and optional proxy.
 *
 * Node's global fetch ignores HTTP_PROXY, so on networks where Modrinth is
 * blocked (or behind a corporate proxy) every search silently failed with a
 * bare "fetch failed" and the panel just looked empty. When a proxy is
 * configured we route through it; otherwise we say plainly what went wrong so
 * the UI can show something actionable instead of a blank list.
 */
async function getJson(url, headers = {}, timeout = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      signal: ctl.signal,
      ...(await proxyOpts()),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } catch (e) {
    // AbortError means our own timeout fired — say so instead of leaking
    // "The operation was aborted" to the user.
    if (e.name === 'AbortError') throw new Error(`Timed out after ${timeout / 1000}s reaching ${hostOf(url)}`);
    if (e.message === 'fetch failed') {
      throw new Error(`Could not reach ${hostOf(url)}. Check your connection${await proxyHint()}.`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * Optional outbound proxy, read from settings so a user behind a blocked or
 * filtered network can still browse the catalog.
 *
 * settings.js exports the Store CLASS, not a live instance, so requiring it
 * here would give us no `.get()` and silently disable the proxy. main.js hands
 * us the real store at startup via setStore().
 */
let _store = null;
function setStore(s) { _store = s; }

async function proxyOpts() {
  try {
    const { proxyUrl } = (_store && _store.get()) || {};
    if (!proxyUrl) return {};
    // Node's undici accepts a dispatcher; build one lazily so the dependency is
    // only needed when a proxy is actually configured.
    const { ProxyAgent } = require('undici');
    if (!proxyOpts._agent || proxyOpts._url !== proxyUrl) {
      proxyOpts._agent = new ProxyAgent(proxyUrl);
      proxyOpts._url = proxyUrl;
    }
    return { dispatcher: proxyOpts._agent };
  } catch {
    return {};
  }
}

function proxyHint() {
  try {
    return (_store && _store.get())?.proxyUrl
      ? ' or check the proxy in Settings'
      : ' or set a proxy in Settings';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------- modrinth */

/** Search Modrinth for Fabric mods matching the game version. */
async function searchModrinth(query, { mcVersion = '1.21.11', limit = 24, offset = 0 } = {}) {
  const facets = JSON.stringify([
    ['categories:fabric'],
    [`versions:${mcVersion}`],
    ['project_type:mod'],
  ]);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query || '')}`
    + `&facets=${encodeURIComponent(facets)}&limit=${limit}&offset=${offset}`
    + '&index=relevance';
  const data = await getJson(url);
  const hits = (data.hits || []).map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    name: h.title,
    author: h.author,
    description: h.description,
    iconUrl: h.icon_url || null,
    downloads: h.downloads || 0,
    categories: h.display_categories || h.categories || [],
    versions: h.versions || [],
  }));
  return { total: data.total_hits || hits.length, hits };
}

/** Pick the newest file for a project that matches the game version + loader. */
async function modrinthLatestFile(projectId, { mcVersion = '1.21.11', loader = 'fabric' } = {}) {
  const gv = JSON.stringify([mcVersion]);
  const ld = JSON.stringify([loader]);
  const url = `${MODRINTH}/project/${encodeURIComponent(projectId)}/version?game_versions=${encodeURIComponent(gv)}&loaders=${encodeURIComponent(ld)}`;
  const versions = await getJson(url);
  if (!Array.isArray(versions) || !versions.length) {
    throw new Error(`No ${loader} build for Minecraft ${mcVersion} on Modrinth.`);
  }
  // API returns newest first; prefer a release, else the newest beta/alpha.
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
  if (!file) throw new Error('Version has no downloadable file.');
  return {
    url: file.url,
    filename: file.filename,
    size: file.size || 0,
    hashes: file.hashes || {},
    versionNumber: v.version_number,
    versionName: v.name,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    dependencies: v.dependencies || [],
  };
}

/* ----------------------------------------------------------- curseforge */

/** Search CurseForge. Requires a user-supplied API key. */
async function searchCurseforge(query, { apiKey, mcVersion = '1.21.11', limit = 24, offset = 0 } = {}) {
  if (!apiKey) throw new Error('CURSEFORGE_API_KEY_REQUIRED');
  const qs = new URLSearchParams({
    gameId: '432',
    classId: '6', // 6 = mods
    searchFilter: query || '',
    gameVersion: mcVersion,
    modLoaderType: '4', // 4 = Fabric
    pageSize: String(limit),
    index: String(offset),
    sortField: '2', // popularity
    sortOrder: 'desc',
  });
  const data = await getJson(`${CURSEFORGE}/mods/search?${qs}`, { 'x-api-key': apiKey });
  const hits = (data.data || []).map((m) => ({
    source: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    name: m.name,
    author: (m.authors && m.authors[0] && m.authors[0].name) || '',
    description: m.summary || '',
    iconUrl: (m.logo && m.logo.thumbnailUrl) || null,
    downloads: m.downloadCount || 0,
    categories: (m.categories || []).map((c) => c.name),
    versions: [],
  }));
  return { total: (data.pagination && data.pagination.totalCount) || hits.length, hits };
}

/** Latest Fabric file for a CurseForge mod on the given game version. */
async function curseforgeLatestFile(modId, { apiKey, mcVersion = '1.21.11' } = {}) {
  if (!apiKey) throw new Error('CURSEFORGE_API_KEY_REQUIRED');
  const qs = new URLSearchParams({ gameVersion: mcVersion, modLoaderType: '4' });
  const data = await getJson(`${CURSEFORGE}/mods/${encodeURIComponent(modId)}/files?${qs}`, { 'x-api-key': apiKey });
  const files = (data.data || []).filter((f) => f.releaseType !== 3 && f.downloadUrl);
  if (!files.length) throw new Error(`No Fabric build for Minecraft ${mcVersion} on CurseForge.`);
  const f = files[0];
  return {
    url: f.downloadUrl,
    filename: f.fileName,
    size: f.fileLength || 0,
    hashes: {},
    versionNumber: f.displayName,
    versionName: f.displayName,
    gameVersions: f.gameVersions || [],
    loaders: ['fabric'],
    dependencies: (f.dependencies || []).map((d) => ({ project_id: String(d.modId), dependency_type: d.relationType })),
  };
}

/* ------------------------------------------------------------- install */

async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  const fh = await fsp.open(file, 'r');
  try {
    for await (const chunk of fh.createReadStream()) hash.update(chunk);
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

/**
 * Download one mod file into `<gameDir>/mods/`.
 *
 * Verifies the Modrinth SHA-1 (or SHA-512) when the provider supplied one; a
 * mismatch aborts and deletes the partial file so a corrupt jar never lands in
 * the mods folder. Returns the installed filename.
 */
/**
 * Download a catalog file. `targetDir` is the folder the jar lands in — the
 * caller decides (a profile's mods/ or the shared mods/), so we must NOT append
 * 'mods' ourselves: doing so produced profiles/pvp/mods/mods/.
 */
async function downloadMod(targetDir, file, { onProgress } = {}) {
  const modsDir = targetDir;
  await fsp.mkdir(modsDir, { recursive: true });
  const target = path.join(modsDir, path.basename(file.filename));
  const tmp = `${target}.part`;

  // Mod files come from cdn.modrinth.com, which is subject to the same
  // blocking as the API, so the proxy settings must apply here too.
  const res = await fetch(file.url, { headers: { 'User-Agent': UA }, ...(await proxyOpts()) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || file.size || 0;

  const sha1 = crypto.createHash('sha1');
  let got = 0;
  const out = require('fs').createWriteStream(tmp);
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    sha1.update(c);
    if (onProgress) onProgress(got, total);
  });
  await pipeline(body, out);

  const expected = file.hashes && (file.hashes.sha1 || file.hashes.sha512);
  const actual = sha1.digest('hex');
  if (file.hashes && file.hashes.sha1 && actual !== file.hashes.sha1) {
    await fsp.unlink(tmp).catch(() => {});
    throw new Error('Checksum mismatch — the download was rejected.');
  }
  await fsp.rename(tmp, target);
  return { file: path.basename(target), path: target, size: got, hashed: !!expected };
}

/**
 * Search Modrinth for any project type. Resource packs are not Fabric-specific,
 * so the loader facet is only applied to mods and modpacks — filtering packs by
 * loader is what makes them disappear from results.
 */
async function searchProjects(query, { mcVersion = '1.21.11', type = 'mod', limit = 24, offset = 0 } = {}) {
  const facets = [[`project_type:${type}`], [`versions:${mcVersion}`]];
  // Only mods and modpacks are loader-specific. Resource packs and shaders are
  // plain zips the game loads regardless of loader, so filtering them by Fabric
  // would hide almost every result.
  if (type === 'mod' || type === 'modpack') facets.push(['categories:fabric']);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query || '')}`
    + `&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=${limit}&offset=${offset}`
    + '&index=relevance';
  const data = await getJson(url);
  const hits = (data.hits || []).map((h) => ({
    source: 'modrinth',
    type,
    id: h.project_id,
    slug: h.slug,
    name: h.title,
    author: h.author,
    description: h.description,
    iconUrl: h.icon_url || null,
    downloads: h.downloads || 0,
    categories: h.display_categories || h.categories || [],
    versions: h.versions || [],
  }));
  return { total: data.total_hits || hits.length, hits };
}

/**
 * All files of a project that match the game version. Resource packs ignore the
 * loader, so callers must not send one for them.
 */
async function projectVersions(projectId, { mcVersion = '1.21.11', loader = null } = {}) {
  const q = [`game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`];
  if (loader) q.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
  const url = `${MODRINTH}/project/${encodeURIComponent(projectId)}/version?${q.join('&')}`;
  const list = await getJson(url);
  return (Array.isArray(list) ? list : []).map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    versionType: v.version_type,
    datePublished: v.date_published,
    downloads: v.downloads || 0,
    files: (v.files || []).map((f) => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      primary: !!f.primary,
      sha1: (f.hashes || {}).sha1 || null,
    })),
  }));
}

/** Fetch one specific Modrinth version by id. */
async function modrinthVersionFile(versionId) {
  const v = await getJson(`${MODRINTH}/version/${encodeURIComponent(versionId)}`);
  if (!v || !v.id) throw new Error('Version not found on Modrinth.');
  const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
  if (!file) throw new Error('Version has no downloadable file.');
  return {
    url: file.url,
    filename: file.filename,
    size: file.size || 0,
    hashes: file.hashes || {},
    versionId: v.id,
    versionNumber: v.version_number,
    versionName: v.name,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
  };
}

/** Resolve a search hit to its newest compatible file. */
async function resolveFile(hit, opts = {}) {
  // A pinned versionId (used by mod updates) must win over "latest": the user
  // was promised a specific build in the banner, so never silently take newest.
  if (hit.versionId) return modrinthVersionFile(hit.versionId);
  if (hit.source === 'modrinth') return modrinthLatestFile(hit.id, opts);
  if (hit.source === 'curseforge') return curseforgeLatestFile(hit.id, opts);
  throw new Error(`Unknown source: ${hit.source}`);
}

/**
 * Expand a version's declared dependencies into installable projects.
 *
 * Modrinth gives us `dependencies: [{ project_id, version_id, dependency_type }]`,
 * where dependency_type is required / optional / incompatible / embedded. We resolve
 * the *required* ones (Fabric API on almost everything, Architectury, Cloth Config…)
 * so the launcher can offer them in one click instead of the user hitting a crash
 * screen and having to work out which mod is missing.
 *
 * `embedded` is skipped on purpose: it ships inside the parent jar already.
 * `optional` is reported but not auto-installed — it is a suggestion, not a need.
 */
async function resolveDependencies(version, { mcVersion = '1.21.11', loader = 'fabric', timeout = 15000 } = {}) {
  const deps = (version && version.dependencies) || [];
  const required = deps.filter((d) => d.dependency_type === 'required' && d.project_id);
  const optional = deps.filter((d) => d.dependency_type === 'optional' && d.project_id);

  const describe = async (d) => {
    try {
      const p = await getJson(`${MODRINTH}/project/${encodeURIComponent(d.project_id)}`, {}, timeout);
      let file = null;
      try {
        file = await modrinthLatestFile(d.project_id, { mcVersion, loader });
      } catch { /* incompatible build: still worth naming it */ }
      return {
        id: p.id,
        slug: p.slug,
        title: p.title,
        iconUrl: p.icon_url || null,
        description: p.description || '',
        downloads: p.downloads || 0,
        kind: d.dependency_type,
        file,
        installable: !!file,
      };
    } catch {
      return {
        id: d.project_id,
        slug: d.project_id,
        title: d.project_id,
        iconUrl: null,
        description: '',
        downloads: 0,
        kind: d.dependency_type,
        file: null,
        installable: false,
      };
    }
  };

  // Bounded parallelism: a mod with 20 required deps shouldn't take 20 round trips.
  const out = [];
  const all = [...required, ...optional];
  for (let i = 0; i < all.length; i += 6) {
    const batch = all.slice(i, i + 6);
    out.push(...(await Promise.all(batch.map(describe))));
  }

  return {
    required: out.filter((d) => d.kind === 'required'),
    optional: out.filter((d) => d.kind === 'optional'),
    incompatible: deps.filter((d) => d.dependency_type === 'incompatible').map((d) => d.project_id),
  };
}

/**
 * Which mods in the performance set have a build for this game version/loader,
 * and which of those the target profile ALREADY has.
 *
 * Two separate facts, and conflating them breaks the UI:
 *
 *  - `ok`      — a build exists for this Minecraft version (else: skipped).
 *  - `present` — a jar for this project is already in the profile's mods/.
 *
 * `present` is resolved from `.origins.json` (the install sidecar), NOT from
 * the filename. Modrinth filenames change on every release, so filename
 * matching would report an installed mod as missing the moment its author
 * renames a build — and then re-download a duplicate into the same profile.
 * An unreadable sidecar therefore reads as "not present", which is the safe
 * direction: worst case the user gets one redundant download, never a skip
 * that leaves their profile without a mod they asked for.
 */
async function perfSetSupport({ mcVersion = '1.21.11', loader = 'fabric', mods = [], profileDir = null } = {}) {
  // Resolve what is already installed once, not per mod: the sidecar is one file.
  const installedSlugs = new Set();
  const installedFiles = new Set();
  const disabledFiles = new Set();
  if (profileDir) {
    try {
      const map = JSON.parse(await fsp.readFile(path.join(profileDir, 'mods', '.origins.json'), 'utf8')) || {};
      for (const [file, meta] of Object.entries(map)) {
        installedFiles.add(file);
        const key = (meta && (meta.slug || meta.projectId || meta.id)) || null;
        if (key) installedSlugs.add(String(key));
      }
    } catch { /* no sidecar yet, or unreadable — nothing is known to be present */ }
    // Jars dropped in by hand have no sidecar entry; count those too so a manual
    // install is not duplicated. Filename stem vs slug is a fuzzy match, so it
    // only ever ADDS to `present` — it can hide nothing.
    try {
      for (const f of await fsp.readdir(path.join(profileDir, 'mods'))) {
        // A jar parked as "name.jar.disabled" is switched off. Track it as
        // present-but-disabled so the UI can offer to switch it back on
        // instead of silently re-downloading a second copy beside it.
        if (/\.jar$/i.test(f)) installedFiles.add(f);
        else if (/\.jar\.disabled$/i.test(f)) {
          installedFiles.add(f.replace(/\.disabled$/i, ''));
          disabledFiles.add(f);
        }
      }
    } catch { /* no mods dir yet */ }
  }

  const results = [];
  for (const m of mods) {
    try {
      const f = await modrinthLatestFile(m.slug, { mcVersion, loader });
      let title = m.slug;
      let iconUrl = '';
      try {
        const p = await getJson(`${MODRINTH}/project/${encodeURIComponent(m.slug)}`);
        title = p.title || m.slug;
        iconUrl = p.icon_url || '';
      } catch { /* metadata is cosmetic — never fail the check over it */ }

      const slugKey = m.slug.toLowerCase();
      const stem = String(f.filename).replace(/\.jar$/i, '').toLowerCase();
      const present = installedSlugs.has(m.slug) ||
        installedSlugs.has(slugKey) ||
        installedFiles.has(f.filename) ||
        [...installedFiles].some((name) => {
          const n = name.replace(/\.jar$/i, '').toLowerCase();
          // Compare on the part before the first version-ish separator so
          // "sodium-fabric-0.8.14" still matches a jar named "sodium-fabric-0.8.12".
          const cut = (s) => s.split(/-(\d|v\d|mc)/)[0];
          return n === stem || (cut(n).length >= 4 && cut(n) === cut(stem));
        });

      // The UI needs the on-disk name to toggle/delete this exact file, so
      // resolve it from whatever matched `present` — exact file, disabled jar,
      // or the stem comparison — rather than guessing from the remote filename.
      const presentFile = present
        ? [...installedFiles].find((n) => n === f.filename)
          || [...installedFiles].find((n) => {
            const n2 = n.replace(/\.jar$/i, '').toLowerCase();
            const cut = (s) => s.split(/-(\d|v\d|mc)/)[0];
            const st = String(f.filename).replace(/\.jar$/i, '').toLowerCase();
            return n2 === st || (cut(n2).length >= 4 && cut(n2) === cut(st));
          })
          || f.filename
        : '';

      results.push({
        ...m, ok: true, present, title, iconUrl,
        // `group` and `why` come from PERF_MODS and drive the UI: the group
        // heading and the tooltip that tells the user what a mod actually buys
        // them. They are spread from `m` but named explicitly here so a future
        // refactor of the mod list cannot silently drop them from the IPC reply.
        group: m.group || 'Other',
        why: m.why || '',
        required: !!m.required,
        presentFile,
        enabled: present ? !disabledFiles.has(`${presentFile}.disabled`) : true,
        versionNumber: f.versionNumber, filename: f.filename, size: f.size, _file: f,
      });
    } catch (e) {
      results.push({ ...m, ok: false, present: false, error: e.message });
    }
  }
  return results;
}

/**
 * Download the performance mods into one profile's `mods/` folder.
 *
 * Sequential on purpose: this is a background convenience in a launcher, and
 * firing twenty parallel downloads makes progress reporting meaningless and
 * can stall the whole batch on one slow CDN file. Each failure is recorded and
 * the loop continues — a performance pack must never be the reason a profile
 * cannot boot, so partial success is a valid outcome.
 *
 * Mods already in the profile are SKIPPED and reported as `alreadyPresent`, not
 * re-downloaded. Someone who already has Sodium installed and only wants the
 * three mods they are missing gets exactly those three, and nothing that is
 * already working is replaced behind their back.
 */
async function installPerfSet(targetDir, { mcVersion = '1.21.11', loader = 'fabric', mods = [], onProgress, onItem, skipPresent = true } = {}) {
  await fsp.mkdir(targetDir, { recursive: true });
  // targetDir is <profile>/mods, so the profile dir is its parent — that is
  // where `.origins.json` lives and where "already installed" is decided.
  const profileDir = path.dirname(targetDir);
  const support = await perfSetSupport({ mcVersion, loader, mods, profileDir });
  const unavailable = support.filter((s) => !s.ok);
  const alreadyPresent = support.filter((s) => s.ok && s.present);
  const available = support.filter((s) => s.ok && !(skipPresent && s.present));

  const installed = [];
  const failed = [];
  for (let i = 0; i < available.length; i++) {
    const item = available[i];
    if (onItem) onItem({ index: i, total: available.length, slug: item.slug, name: item.title || item.slug });
    try {
      // Never clobber an existing jar with the same name in a different state:
      // if it is already there the user (or a previous run) put it there.
      const r = await downloadMod(targetDir, item._file, {
        onProgress: onProgress
          ? (got, total) => onProgress({ index: i, total: available.length, slug: item.slug, got, total })
          : undefined,
      });
      installed.push({ slug: item.slug, file: r.file, version: item.versionNumber });
    } catch (e) {
      failed.push({ slug: item.slug, error: e.message });
    }
  }
  return {
    ok: true,
    installed,
    failed,
    // Two distinct reasons a mod was not downloaded, kept apart because they
    // mean opposite things to the user: "already yours" vs "does not exist yet
    // for this version". One merged list would read as a failure report.
    alreadyPresent: alreadyPresent.map((s) => ({ slug: s.slug, title: s.title || s.slug, version: s.versionNumber })),
    unavailable: unavailable.map((s) => ({ slug: s.slug, title: s.title || s.slug, error: s.error })),
    counts: {
      installed: installed.length,
      failed: failed.length,
      alreadyPresent: alreadyPresent.length,
      unavailable: unavailable.length,
      total: support.length,
    },
  };
}

module.exports = {
  setStore,
  searchModrinth,
  searchCurseforge,
  searchProjects,
  projectVersions,
  modrinthLatestFile,
  curseforgeLatestFile,
  resolveFile,
  resolveDependencies,
  downloadMod,
  sha1File,
  installPerfSet,
  perfSetSupport,
};
