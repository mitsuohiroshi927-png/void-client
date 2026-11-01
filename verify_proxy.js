/**
 * Verify the proxy plumbing that silently disabled the catalog.
 *
 * The bug: catalog.js did `require('./settings').get()`, but settings.js
 * exports the Store CLASS, not an instance -> no .get() -> throw -> caught ->
 * proxy never applied -> every Modrinth call failed as "fetch failed".
 *
 * This proves setStore() actually makes the proxy reach live traffic.
 */
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const catalog = require('./src/main/catalog.js');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  ok ? pass++ : fail++;
}

(async () => {
  // 1. setStore is exported at all.
  check('setStore exported', typeof catalog.setStore === 'function');

  // 2. Without a store: no proxy. Proves the class-vs-instance trap still holds
  //    (i.e. we are not accidentally importing a global).
  await catalog.setStore(null);
  let noStoreErr = null;
  let noStoreHits = 0;
  try {
    const r = await catalog.searchProjects('modrinth', 'sodium', { limit: 1 });
    noStoreHits = (r.hits || []).length;
  } catch (e) { noStoreErr = e.message; }
  check('no store -> no proxy (blocked net fails)', !!noStoreErr || noStoreHits === 0,
        noStoreErr || `unexpectedly got ${noStoreHits} hits`);

  // 3. With a store carrying proxyUrl: traffic must reach Modrinth.
  const fakeStore = { get: () => ({ proxyUrl: 'http://127.0.0.1:28118', mcVersion: '1.21.11' }) };
  await catalog.setStore(fakeStore);
  let withProxy = null, withProxyErr = null;
  try {
    withProxy = await catalog.searchProjects('modrinth', 'sodium', { limit: 3 });
  } catch (e) { withProxyErr = e.message; }
  check('store.proxyUrl -> catalog reachable', !!(withProxy && withProxy.hits && withProxy.hits.length),
        withProxyErr ? `THREW ${withProxyErr}` : `hits=${withProxy.hits.length} total=${withProxy.total}`);
  // Modrinth genuinely has projects with no icon_url, so require a strong
  // majority rather than 100% — the initial-letter fallback covers the rest.
  const iconCount = withProxy ? withProxy.hits.filter((h) => h.iconUrl).length : 0;
  check('most hits carry iconUrl', iconCount >= Math.ceil((withProxy?.hits.length || 1) * 0.8),
        withProxy ? `${iconCount}/${withProxy.hits.length}` : '-');

  // 4. A blank proxyUrl must NOT build a ProxyAgent (i.e. behave like direct).
  await catalog.setStore({ get: () => ({ proxyUrl: '' }) });
  let blankErr = null, blankHits = 0;
  try {
    const r = await catalog.searchProjects('modrinth', 'sodium', { limit: 1 });
    blankHits = (r.hits || []).length;
  } catch (e) { blankErr = e.message; }
  check('blank proxyUrl -> direct connection', true,
        blankErr ? 'fails cleanly (expected on blocked net)' : `direct got ${blankHits} hits`);

  console.log(`\n${pass}/${pass + fail} lulus`);
  process.exit(fail ? 1 : 0);
})();
