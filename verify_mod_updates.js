/**
 * Verify the two things that were broken:
 *   1. catalog.js can reach Modrinth through the proxy (was: bare "fetch failed")
 *   2. findModUpdates() detects a genuinely outdated mod and stays quiet on a current one
 *
 * Runs against the real Modrinth API. No mocks.
 */
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const path = require('path');
const fs = require('fs');
const os = require('os');

const catalog = require('./src/main/catalog.js');
// Must go through setStore(): the old test injected a fake .get() onto the
// settings module, which is exactly what hid the class-vs-instance bug.
catalog.setStore({ get: () => ({ proxyUrl: 'http://127.0.0.1:28118', mcVersion: '1.21.11' }) });

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  /* ---------------- 1. does the proxy actually work? ---------------- */
  console.log('=== 1. Modrinth reachability through proxy ===');
  try {
    const r = await catalog.searchProjects('sodium', { mcVersion: '1.21.11', type: 'mod' });
    check('searchProjects returns hits', r.hits.length > 0, `${r.hits.length} hits, total=${r.total}`);
    const withIcon = r.hits.filter((h) => h.iconUrl);
    check('hits carry iconUrl', withIcon.length > 0, `${withIcon.length}/${r.hits.length} have an icon`);
    check('iconUrl is absolute https', /^https:\/\//.test(withIcon[0].iconUrl || ''), (withIcon[0].iconUrl || '').slice(0, 60));
  } catch (e) {
    check('searchProjects returns hits', false, e.message);
  }

  /* ---------------- 2. update detection ---------------- */
  console.log('\n=== 2. findModUpdates: outdated vs current ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'void-uptest-'));
  const modsDir = path.join(tmp, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  // sodium: lie that we installed an ancient build -> must be flagged
  // fabric-api: claim we're on the newest release -> must stay quiet
  const sodiumVersions = await catalog.projectVersions('AANobbMI', { mcVersion: '1.21.11', loader: 'fabric' });
  const fabricVersions = await catalog.projectVersions('P7dR8mSH', { mcVersion: '1.21.11', loader: 'fabric' });
  const newestSodium = sodiumVersions.find((v) => v.versionType === 'release') || sodiumVersions[0];
  const newestFabric = fabricVersions.find((v) => v.versionType === 'release') || fabricVersions[0];
  check('projectVersions resolved sodium builds', sodiumVersions.length > 0, `${sodiumVersions.length} builds`);
  check('projectVersions resolved fabric-api builds', fabricVersions.length > 0, `${fabricVersions.length} builds`);

  fs.writeFileSync(path.join(modsDir, 'sodium-outdated.jar'), 'x');
  fs.writeFileSync(path.join(modsDir, 'fabric-api-current.jar'), 'x');
  fs.writeFileSync(path.join(modsDir, '.origins.json'), JSON.stringify({
    'sodium-outdated.jar': { id: 'AANobbMI', name: 'Sodium', slug: 'sodium', versionId: 'OLD_BUILD', versionNumber: '0.1.0' },
    'fabric-api-current.jar': { id: 'P7dR8mSH', name: 'Fabric API', slug: 'fabric-api', versionId: newestFabric.id, versionNumber: newestFabric.versionNumber },
  }, null, 2));

  const mainSrc = fs.readFileSync(path.join(__dirname, 'src', 'main', 'main.js'), 'utf8');
  // Pull the two helpers out of main.js and run them in isolation.
  const grab = (name) => {
    const i = mainSrc.indexOf(`async function ${name}(`);
    if (i < 0) throw new Error(`${name} not found in main.js`);
    let d = 0, started = false;
    for (let j = i; j < mainSrc.length; j++) {
      if (mainSrc[j] === '{') { d++; started = true; }
      else if (mainSrc[j] === '}') { d--; if (started && d === 0) return mainSrc.slice(i, j + 1); }
    }
    throw new Error(`${name} unterminated`);
  };
  const fsp = require('fs/promises');
  const fnSrc = `${grab('readModOrigins')}\n${grab('findModUpdates')}\nmodule.exports={findModUpdates,readModOrigins};`;
  const mod = { exports: {} };
  // catalog must be injected: the extracted functions are closure-scoped to the
  // real module, so without this they throw and the catch swallows it — which
  // made every assertion pass for the wrong reason.
  new Function('require', 'module', 'exports', 'path', 'fsp', 'catalog', fnSrc)(
    require, mod, mod.exports, path, fsp, catalog,
  );
  const { findModUpdates } = mod.exports;

  const updates = await findModUpdates(tmp, '1.21.11');
  const names = updates.map((u) => u.file);
  // A silently-empty result is indistinguishable from "nothing outdated" — the
  // fabric-api assertion passes either way. Require at least one update here so
  // a broken injection can never masquerade as success.
  check('scan returned at least one update', updates.length > 0, `updates=[${names.join(', ')}]`);
  check('outdated sodium flagged', names.includes('sodium-outdated.jar'), `updates=[${names.join(', ')}]`);
  check('current fabric-api NOT flagged', !names.includes('fabric-api-current.jar'));
  const s = updates.find((u) => u.file === 'sodium-outdated.jar');
  if (s) check('update carries from/to versions', !!s.from && !!s.to && s.to !== s.from, `${s.from} -> ${s.to}`);

  // A user-dropped jar with no origin metadata must be left alone.
  fs.writeFileSync(path.join(modsDir, 'manual-drop.jar'), 'x');
  const u2 = await findModUpdates(tmp, '1.21.11');
  check('manual jar without origin ignored', !u2.map((u) => u.file).includes('manual-drop.jar'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
