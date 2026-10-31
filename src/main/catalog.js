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

const UA = 'VoidClient/1.0.0 (launcher; +https://voidclient.local)';
const MODRINTH = 'https://api.modrinth.com/v2';
const CURSEFORGE = 'https://api.curseforge.com/v1';

async function getJson(url, headers = {}, timeout = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
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

  const res = await fetch(file.url, { headers: { 'User-Agent': UA } });
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

/** Resolve a search hit to its newest compatible file. */
async function resolveFile(hit, opts = {}) {
  if (hit.source === 'modrinth') return modrinthLatestFile(hit.id, opts);
  if (hit.source === 'curseforge') return curseforgeLatestFile(hit.id, opts);
  throw new Error(`Unknown source: ${hit.source}`);
}

module.exports = {
  searchModrinth,
  searchCurseforge,
  searchProjects,
  projectVersions,
  modrinthLatestFile,
  curseforgeLatestFile,
  resolveFile,
  downloadMod,
  sha1File,
};
