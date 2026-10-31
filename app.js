'use strict';
/* VOID Client — renderer logic. No node APIs; everything goes through the bridge. */

const api = window.voidClient;
const $ = (id) => document.getElementById(id);

let state = {
  settings: null,
  profile: null,
  shaForAvatar: null,
  busy: false,
};

/* ---------------------------------------------------------------- nav */

$('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`view-${btn.dataset.view}`).classList.add('active');
});

/* ------------------------------------------------------------ helpers */

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function log(text, isErr) {
  const box = $('console');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const span = document.createElement('span');
  if (isErr) span.className = 'err';
  span.textContent = text.endsWith('\n') ? text : text + '\n';
  box.appendChild(span);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function setProgress(pct, label) {
  $('bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label) $('progressLabel').textContent = label;
}

/* --------------------------------------------------------- settings UI */

function applySettings(s) {
  state.settings = s;
  $('sMcVersion').value = s.mcVersion || '1.21.11';
  $('sFabric').value = s.fabricLoader || '';
  $('sRam').value = s.ram || 4096;
  $('sWidth').value = s.width || 1280;
  $('sHeight').value = s.height || 720;
  $('sRoot').value = s.root || '';
  $('sGameDir').value = s.gameDir || '';
  $('sJava').value = s.javaPath || '';
  $('sJvm').value = s.extraJvmArgs || '';
  $('sFabricOn').checked = !!s.useFabric;
  if ($('sAutoTune')) $('sAutoTune').checked = s.autoTune !== false;
  if ($('sMcVersion')) $('sMcVersion').value = s.mcVersion || '1.21.11';
  if ($('sCfKey')) $('sCfKey').value = s.curseforgeApiKey || '';
  if ($('sSafety')) $('sSafety').checked = !!s.safetyMode;
  $('sCloseOnLaunch').checked = !!s.closeLauncherOnLaunch;

  // home stats
  // s.ram/width/height already carry the resolved profile values from main.
  const rp = s.resolvedProfile || null;
  const ramMb = (rp && rp.ram) || s.ram || 4096;
  const rw = (rp && rp.width) || s.width || 1280;
  const rh = (rp && rp.height) || s.height || 720;
  $('statRam').textContent = fmtRam(ramMb);
  $('statRes').textContent = `${rw}×${rh}`;
  state.lastResolved = { ram: ramMb, width: rw, height: rh, id: (rp && rp.id) || s.profile };
  $('statJava').textContent = s.javaPath ? 'custom' : 'auto';
  $('statDir').textContent = s.gameDir || '—';
  $('statDir').title = s.gameDir || '';
  $('homeSub').textContent = `Minecraft ${s.mcVersion} · ${s.useFabric ? 'Fabric' : 'Vanilla'}`;
  $('tagFabric').textContent = s.useFabric ? 'Fabric' : 'Vanilla';

  renderProfiles(s);
}

const fmtRam = (mb) => `${Math.round(mb / 1024 * 10) / 10} GB`;

/**
 * Repaint the profile cards + summary bar from a single resolved snapshot so
 * the two can never drift apart (the hardware probe lands after first paint).
 */
function repaintSummary(snap, hardware) {
  const tuned = (hardware && hardware.tuned) || null;
  const profiles = (snap && snap.profiles) || {};
  const activeId = (snap && snap.profile) || 'auto';
  const p = profiles[activeId] || profiles.balanced || {};
  const ram = p.ram || (tuned ? tuned.ramMB : 4096);
  const w = p.width || (tuned ? tuned.width : 1280);
  const h = p.height || (tuned ? tuned.height : 720);
  $('statRam').textContent = fmtRam(ram);
  $('statRes').textContent = `${w}×${h}`;
  document.querySelectorAll('.prof').forEach((el) => {
    el.classList.toggle('active', el.dataset.prof === activeId);
  });
}

function renderProfiles(s) {
  const row = $('profRow');
  row.innerHTML = '';
  const profiles = s.profiles || {};
  const activeId = (s.resolvedProfile && s.resolvedProfile.id) || s.profile;
  const tuned = (state.hardware && state.hardware.tuned) || null;
  for (const key of Object.keys(profiles)) {
    const p = profiles[key];
    if (!p) continue;
    // Only a profile marked `adaptive` (Auto) inherits the hardware tuning.
    // Every other card shows its own numbers — a fixed profile with ram:0 means
    // "launcher decides", not "copy whatever Auto got".
    const adaptive = p.adaptive && tuned;
    const ram = adaptive ? tuned.ramMB : (p.ram || 4096);
    const w = adaptive ? tuned.width : (p.width || 1280);
    const h = adaptive ? tuned.height : (p.height || 720);
    const el = document.createElement('button');
    el.className = `prof${key === activeId ? ' active' : ''}`;
    el.dataset.prof = key;
    el.innerHTML = `
      <div class="prof-name"><span class="prof-dot"></span>${p.name}${(p.mods && p.mods.voidFps) ? '<span class="prof-vf" title="VOID FPS enabled">◆</span>' : ''}</div>
      <div class="prof-desc">${p.description || ''}</div>
      <div class="prof-desc" style="margin-top:7px;color:var(--blue-2)">${fmtRam(ram)} · ${w}×${h}</div>
    `;
    el.addEventListener('click', async () => {
      const next = await api.patchSettings({ profile: key });
      applySettings(next);
      log(`Profile set to ${p.name}`);
    });
    row.appendChild(el);
  }
}



/* ------------------------------------------------------- mod browser */

const browse = { source: 'modrinth', lastQuery: '', busy: false };

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function initModTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      const which = tab.dataset.tab;
      $('pane-installed').hidden = which !== 'installed';
      $('pane-browse').hidden = which !== 'browse';
      if (which === 'browse' && !$('modResults').children.length) runSearch();
    });
  }

  for (const b of document.querySelectorAll('.src')) {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      for (const o of document.querySelectorAll('.src')) o.classList.toggle('active', o === b);
      browse.source = b.dataset.src;
      $('browseCount').textContent = '';
      runSearch();
    });
  }

  $('modSearchBtn').addEventListener('click', () => runSearch());
  $('modQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });

  api.onCatalogProgress(({ slug, got, total }) => {
    const el = document.querySelector(`[data-install="${slug}"]`);
    if (!el) return;
    el.textContent = total ? `${Math.round((got / total) * 100)}%` : '…';
  });

  api.onModsChanged(() => {
    refreshMods();
    runSearch(true); // refresh installed badges without clearing the list
  });
}

async function runSearch(quiet) {
  if (browse.busy) return;
  const q = $('modQuery').value.trim();
  browse.lastQuery = q;
  const btn = $('modSearchBtn');
  browse.busy = true;
  btn.classList.add('loading');
  btn.textContent = 'Searching…';
  if (!quiet) {
    $('modResults').innerHTML = '<div class="catalog-empty">Searching…</div>';
  }

  const r = await api.searchMods({ source: browse.source, query: q });
  browse.busy = false;
  btn.classList.remove('loading');
  btn.textContent = 'Search';

  if (!r.ok) {
    $('browseCount').textContent = '';
    if (/CURSEFORGE_API_KEY_REQUIRED/.test(r.error || '')) {
      $('modResults').innerHTML =
        '<div class="catalog-empty">CurseForge needs a free API key.<br/>'
        + 'Get one at console.curseforge.com and paste it in Settings → CurseForge API key.</div>';
    } else {
      $('modResults').innerHTML = `<div class="catalog-empty">Search failed: ${escapeHtml(r.error || 'unknown error')}</div>`;
    }
    return;
  }

  $('browseHint').textContent = `Filtered for Minecraft ${r.mcVersion} · Fabric`;
  $('browseCount').textContent = `${r.total} result${r.total === 1 ? '' : 's'}`;
  renderCatalog(r.hits || []);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const esc = escapeHtml;

function renderCatalog(hits) {
  const box = $('modResults');
  box.innerHTML = '';
  if (!hits.length) {
    box.innerHTML = '<div class="catalog-empty">No mods matched. Try another name or a different Minecraft version.</div>';
    return;
  }
  for (const h of hits) {
    const el = document.createElement('div');
    el.className = 'mod-card';
    const icon = h.iconUrl
      ? `<img src="${escapeHtml(h.iconUrl)}" alt="" onerror="this.parentNode.textContent='◈'"/>`
      : '◈';
    el.innerHTML = `
      <div class="mod-ico">${icon}</div>
      <div class="mod-body">
        <div class="mod-name" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</div>
        <div class="mod-auth">${escapeHtml(h.author || 'unknown')} · ${h.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}</div>
        <div class="mod-desc">${escapeHtml(h.description || '')}</div>
        <div class="mod-stats"><span>⬇ ${fmtNum(h.downloads)}</span></div>
      </div>
      <div class="mod-act"></div>
    `;
    const act = el.querySelector('.mod-act');
    if (h.installed) {
      act.innerHTML = '<span class="installed-tag">installed</span>';
    } else {
      const b = document.createElement('button');
      b.className = 'btn primary sm';
      b.dataset.install = h.slug || h.id;
      b.textContent = 'Install';
      b.addEventListener('click', () => installHit(h, b));
      act.appendChild(b);
    }
    box.appendChild(el);
  }
}

async function installHit(hit, btn) {
  btn.classList.add('loading');
  btn.textContent = '…';
  const r = await api.installMod(hit);
  btn.classList.remove('loading');
  if (r.ok) {
    btn.outerHTML = '<span class="installed-tag">installed</span>';
    log(`Installed ${hit.name} ${r.versionNumber || ''}`.trim());
    refreshMods();
  } else {
    btn.textContent = 'Retry';
    btn.title = r.error || '';
    log(`Install failed (${hit.name}): ${r.error}`, true);
  }
}

/* ------------------------------------------------------------- hardware */

function gb(mb) { return (Math.round((mb || 0) / 1024 * 10) / 10) + ' GB'; }

function renderHardware(hw) {
  state.hardware = hw;
  const tuned = hw && hw.tuned;
  if (!hw) {
    $('hwTier').textContent = 'unavailable';
    $('hwTier').className = 'hw-tier warn';
    $('hwNote').textContent = 'Hardware detection failed — the Balanced profile will be used.';
    return;
  }
  const tier = hw.tier || 'medium';
  $('hwTier').textContent = tier === 'high' ? 'high end' : tier === 'low' ? 'low end' : 'mid range';
  $('hwTier').className = 'hw-tier ' + (tier === 'high' ? 'high' : tier === 'low' ? 'low' : 'ok');

  const c = hw.cpu || {};
  const cores = c.logical || c.cores || c.physical || 0;
  $('hwCpu').textContent = c.model
    ? `${String(c.model).replace(/\s+/g, ' ').slice(0, 40)}${cores ? ` · ${cores} threads` : ''}`
    : 'unknown';
  $('hwCpu').title = c.model || '';

  const g = hw.gpu || {};
  $('hwGpu').textContent = g.name ? g.name.slice(0, 44) : 'unknown';
  $('hwGpu').title = g.name || '';

  $('hwRam').textContent = hw.ramMB ? `${gb(hw.ramMB)} total` : 'unknown';

  if (tuned) {
    $('hwRec').textContent = `${gb(tuned.ramMB)} RAM · ${tuned.width}×${tuned.height}`;
    const bits = [];
    if (hw.is64bit === false) bits.push('32-bit OS — memory limited');
    if ((hw.ramMB || 0) < 4096) bits.push('low RAM — extra mods may not fit');
    if (g.software) bits.push('no hardware GPU detected — using safe render settings');
    $('hwNote').textContent = bits.length
      ? bits.join(' · ')
      : 'Profiles marked Auto adapt to this hardware automatically.';
  }
}

async function refreshJava() {
  try {
    const info = await api.listJava();
    const found = (info && info.suitable) || null;
    const managed = info && info.managed;
    if (managed) {
      $('javaState').textContent = 'ready';
      $('javaState').className = 'hw-tier ok';
      $('javaInUse').textContent = managed.path;
      $('javaInUse').title = managed.path;
      $('javaHint').textContent = `Bundled runtime · Java ${managed.major}`;
      $('javaDownloadBtn').textContent = 'Re-download';
    } else if (found) {
      $('javaState').textContent = 'ready';
      $('javaState').className = 'hw-tier ok';
      $('javaInUse').textContent = found.path;
      $('javaInUse').title = found.path;
      $('javaHint').textContent = `System Java ${found.major} (${found.bits}-bit)`;
      $('javaDownloadBtn').textContent = 'Download Java 21';
    } else {
      // No usable runtime: the launcher will fetch one on first Play.
      $('javaState').textContent = 'will download';
      $('javaState').className = 'hw-tier warn';
      $('javaInUse').textContent = 'none found on this PC';
      $('javaHint').textContent = 'Java 21 is fetched automatically on first Play.';
    }
  } catch (e) {
    $('javaState').textContent = 'unknown';
    $('javaState').className = 'hw-tier warn';
    $('javaHint').textContent = e.message;
  }
}

async function loadHardware(force) {
  if (force) {
    $('hwTier').textContent = 'detecting…';
    $('hwTier').className = 'hw-tier';
  }
  const hw = await api.probeHardware();
  renderHardware(hw);
  renderProfiles(state.settings || { profiles: {} });
}

function initHardwareUi() {
  $('reprobeBtn').addEventListener('click', () => loadHardware(true));

  if ($('testCfBtn')) {
    $('testCfBtn').addEventListener('click', async () => {
      const key = $('sCfKey').value.trim();
      if (!key) { $('testCfBtn').textContent = 'Empty'; setTimeout(() => { $('testCfBtn').textContent = 'Test'; }, 1800); return; }
      $('testCfBtn').textContent = 'Testing…';
      const r = await api.testCurseforge(key);
      $('testCfBtn').textContent = r.ok ? 'Valid ✓' : 'Invalid';
      setTimeout(() => { $('testCfBtn').textContent = 'Test'; }, 2600);
    });
  }

  $('javaDownloadBtn').addEventListener('click', async () => {
    const btn = $('javaDownloadBtn');
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    $('javaHint').textContent = 'Fetching Temurin 21 from Adoptium…';
    try {
      const r = await api.installJava({ major: 21 });
      $('javaHint').textContent = `Installed Java ${r.major}`;
      await refreshJava();
      const s = await api.patchSettings({ javaPath: r.path, javaRuntime: 'managed' });
      applySettings(s);
    } catch (e) {
      $('javaHint').textContent = 'Download failed: ' + e.message;
      btn.textContent = 'Retry download';
    } finally {
      btn.disabled = false;
    }
  });

  $('javaPickBtn').addEventListener('click', async () => {
    const p = await api.pickJava();
    if (!p) return;
    const s = await api.patchSettings({ javaPath: p, javaRuntime: 'custom' });
    applySettings(s);
    await refreshJava();
    $('javaHint').textContent = 'Using selected runtime.';
  });

  refreshJava();
}

/* ------------------------------------------------------------- account */

function paintAvatar(el, name, skins) {
  el.innerHTML = '';
  if (skins && skins.length) {
    const url = (skins.find((k) => k.state === 'ACTIVE') || skins[0]).url;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.onerror = () => { el.textContent = (name || '?')[0].toUpperCase(); };
      el.appendChild(img);
      return;
    }
  }
  el.textContent = (name || '?')[0].toUpperCase();
}

function loginLog(text, level) {
  const el = $('loginLog');
  if (!el) return;
  const stamp = new Date().toLocaleTimeString();
  const cls = level === 'err' ? 'line-err' : level === 'ok' ? 'line-ok' : level === 'sys' ? 'line-sys' : '';
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = `[${stamp}] ${text}\n`;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

async function refreshAccount() {
  const st = await api.authStatus();
  if (st.signedIn) {
    state.profile = st.profile;
    $('accName').textContent = st.profile.name;
    $('accSub').textContent = 'Microsoft account';
    $('accBigName').textContent = st.profile.name;
    $('accBigSub').textContent = 'Signed in — premium session active.';
    paintAvatar($('accBigAvatar'), st.profile.name, st.profile.skins);
    $('accSignIn').textContent = 'Signed in';
    $('accSignIn').disabled = true;
    $('accCard').classList.add('signed');
    $('accountBox').classList.add('signed');
    const uuid = st.profile.id || '';
    $('accMeta').innerHTML =
      `<span class="chip ok">session valid</span>` +
      `<span class="chip">UUID <b class="mono">${uuid.slice(0, 8)}…${uuid.slice(-4)}</b></span>` +
      `<span class="chip">skin ${st.profile.skins && st.profile.skins.length ? 'loaded' : 'default'}</span>`;
  } else {
    state.profile = null;
    $('accName').textContent = 'Not signed in';
    $('accSub').textContent = 'Click to sign in';
    $('avatar').textContent = '?';
    $('accBigName').textContent = 'Not signed in';
    $('accBigSub').textContent = 'Sign in to play online and keep your skins.';
    $('accBigAvatar').textContent = '?';
    $('accSignIn').textContent = 'Sign in';
    $('accSignIn').disabled = false;
    $('accCard').classList.remove('signed');
    $('accountBox').classList.remove('signed');
    $('accMeta').innerHTML = st.error ? `<span class="chip warn">${esc(st.error)}</span>` : '';
  }
  return st;
}

$('accountBox').addEventListener('click', async () => {
  if (state.profile) {
    // Sign out on a second click when already signed in? Keep it explicit and safe:
    // open a confirm-less sign-out only when the user holds Shift.
    if (window.event && window.event.shiftKey) {
      await api.authSignOut();
      await refreshAccount();
      log('Signed out.');
      return;
    }
    log(`Signed in as ${state.profile.name}`);
    return;
  }
  $('authModal').hidden = false;
  $('authCode').textContent = '· · · · · · · ·';
  $('authHint').textContent = 'Requesting code from Microsoft…';
  const r = await api.authBegin();
  if (r && r.userCode) {
    $('authCode').textContent = r.userCode;
    $('authHint').textContent = 'Waiting for you to approve…';
    $('authOpen').dataset.url = r.verificationUri;
  }
});

$('authOpen').addEventListener('click', () => {
  const url = $('authOpen').dataset.url || 'https://www.microsoft.com/link';
  api.authOpenLink(url);
});
$('authClose').addEventListener('click', () => { $('authModal').hidden = true; });

api.onDeviceCode((d) => {
  $('authCode').textContent = d.userCode;
  $('authOpen').dataset.url = d.verificationUri;
  $('authHint').textContent = 'Waiting for approval…';
});
api.onAuthTick((t) => {
  $('authHint').textContent = `Waiting for approval… ${t.secondsLeft}s left`;
  if (t.secondsLeft % 15 === 0) loginLog(`Still waiting for approval… ${t.secondsLeft}s left`);
});
api.onAuthDone(async (d) => {
  $('authModal').hidden = true;
  log(`Signed in as ${d.profile.name}`);
  loginLog(`Microsoft approved. Minecraft session acquired for ${d.profile.name}.`, 'ok');
  $('loginState').textContent = 'signed in';
  $('loginState').className = 'hw-tier ok';
  await refreshAccount();
  setProgress(0, 'Ready');
});
api.onAuthError((e) => {
  $('authHint').textContent = e.message;
  log(`Auth error: ${e.message}`, true);
  loginLog(`Auth error: ${e.message}`, 'err');
  $('loginState').textContent = 'failed';
  $('loginState').className = 'hw-tier warn';
});

/* ------------------------------------------------- 1.21.x version picker */

async function loadVersionList() {
  const sel = $('sMcVersion');
  const hint = $('mcVersionHint');
  if (!sel || !api.listVersions) return;
  try {
    const r = await api.listVersions('1.21');
    if (!r || !r.ok || !r.versions.length) throw new Error(r && r.error ? r.error : 'empty list');
    const cur = (state.settings && state.settings.mcVersion) || '1.21.11';
    sel.innerHTML = '';
    for (const v of r.versions) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.id + (v.id === r.versions[0].id ? ' (newest)' : '');
      sel.appendChild(o);
    }
    if (![...sel.options].some((o) => o.value === cur)) {
      const o = document.createElement('option');
      o.value = cur;
      o.textContent = cur + ' (installed)';
      sel.appendChild(o);
    }
    sel.value = cur;
    hint.textContent = `${r.versions.length} Minecraft 1.21.x releases · mod search follows this`;
  } catch (e) {
    hint.textContent = 'Version list unavailable — check your connection.';
    log('Version list failed: ' + (e.message || e), true);
  }
}

/* ------------------------------------------------------- account page */

function openAuthModal() {
  $('authModal').hidden = false;
  $('authCode').textContent = '· · · · · · · ·';
  $('authHint').textContent = 'Requesting code from Microsoft…';
  $('loginState').textContent = 'requesting';
  $('loginState').className = 'hw-tier';
  loginLog('Requesting device code from Microsoft…', 'sys');
}

async function beginSignIn() {
  openAuthModal();
  try {
    const r = await api.authBegin();
    if (r && r.userCode) {
      $('authCode').textContent = r.userCode;
      $('authHint').textContent = 'Waiting for you to approve…';
      $('authOpen').dataset.url = r.verificationUri;
      $('loginState').textContent = 'waiting';
      $('loginState').className = 'hw-tier warn';
      loginLog(`Code issued: ${r.userCode}`, 'ok');
      loginLog(`Open ${r.verificationUri} and enter the code.`, 'sys');
    }
  } catch (e) {
    $('authHint').textContent = e.message || 'Failed to start sign-in';
    loginLog(`Failed to start sign-in: ${e.message}`, 'err');
  }
}

$('accSignIn').addEventListener('click', beginSignIn);
$('accRefresh').addEventListener('click', async () => {
  const st = await refreshAccount();
  loginLog(st.signedIn ? `Session valid for ${st.profile.name}` : 'No valid session.', st.signedIn ? 'ok' : 'err');
  $('loginState').textContent = st.signedIn ? 'signed in' : 'idle';
  $('loginState').className = st.signedIn ? 'hw-tier ok' : 'hw-tier';
});
$('accSignOut').addEventListener('click', async () => {
  await api.authSignOut();
  await refreshAccount();
  loginLog('Signed out. Cached session removed.', 'sys');
  $('loginState').textContent = 'idle';
  $('loginState').className = 'hw-tier';
});
$('authCopy').addEventListener('click', () => {
  const code = $('authCode').textContent.trim();
  navigator.clipboard.writeText(code).then(
    () => { $('authHint').textContent = 'Code copied to clipboard.'; },
    () => { $('authHint').textContent = 'Copy failed — select the code manually.'; }
  );
});

/* ---------------------------------------------------------------- mods */

async function refreshMods() {
  const info = await api.inspectMods();
  const vf = info.voidFps;
  if (vf.found) {
    $('vfVersion').textContent = vf.version || '?';
    $('vfPath').textContent = 'Bundled with the client — loaded from classpath, never from mods/';
    $('vfPath').title = vf.path || '';
    $('vfState').textContent = 'Active';
    const dep = vf.depends && vf.depends.minecraft ? vf.depends.minecraft : '—';
    $('vfMeta').innerHTML = `
      <span class="chip blue">v${esc(vf.version || '?')}</span>
      <span class="chip">${fmtBytes(vf.size)}</span>
      <span class="chip">MC ${esc(dep)}</span>
      <span class="chip">id ${esc(vf.id || 'voidfps')}</span>
      <span class="chip">sha256 ${esc((vf.sha256 || '').slice(0, 12))}…</span>
      <span class="chip ${info.hasModConfig ? 'ok' : ''}">config ${info.hasModConfig ? 'present' : 'not created yet'}</span>
    `;
    $('tagMod').textContent = `VOID FPS ${vf.version || ''} bundled`.trim();
  } else {
    $('vfVersion').textContent = 'missing';
    $('vfPath').textContent = vf.hint || 'vendor/void-fps-*.jar not found next to the launcher.';
    $('vfState').textContent = 'Inactive';
    $('vfState').className = 'chip warn';
    $('vfMeta').innerHTML = '';
  }

  const list = $('modList');
  list.innerHTML = '';
  const real = info.installed.filter((m) => !m.isVoidFps);
  $('modCount').textContent = String(real.length);
  if (!real.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-ico">▣</div>
        <div class="empty-t">No mods installed</div>
        <div class="empty-s">Browse Modrinth or CurseForge above, or press “+ Add .jar” to drop in your own Fabric mods.</div>
      </div>`;
  }
  for (const m of real) {
    const el = document.createElement('div');
    el.className = 'mod-item';
    el.innerHTML = `
      <div class="mod-ico">${esc((m.name || m.file).slice(0, 1).toUpperCase())}</div>
      <div class="mod-body">
        <div class="mod-name">${esc(m.name || m.file)}${m.version ? ` <span class="badge">${esc(m.version)}</span>` : ''}</div>
        <div class="mod-sub">${esc(m.file)} · <b>${fmtBytes(m.size)}</b></div>
      </div>
      <button class="btn danger sm" title="Remove">Remove</button>
    `;
    el.querySelector('button').addEventListener('click', async () => {
      await api.removeMod(m.file);
      await refreshMods();
    });
    list.appendChild(el);
  }
}

$('addModBtn').addEventListener('click', async () => {
  const r = await api.addMods();
  if (r.ok) { log(`Added ${r.added.length} mod(s).`); await refreshMods(); }
});
$('openModsFolder').addEventListener('click', () => api.openFolder('mods'));

/* ------------------------------------------------------------ settings */

$('pickRoot').addEventListener('click', async () => {
  const p = await api.pickDir('root');
  if (p) $('sRoot').value = p;
});
$('pickGameDir').addEventListener('click', async () => {
  const p = await api.pickDir('game');
  if (p) $('sGameDir').value = p;
});
$('pickJava').addEventListener('click', async () => {
  const p = await api.pickFile([{ name: 'Java executable', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]);
  if (p) $('sJava').value = p;
});


$('saveSettings').addEventListener('click', async () => {
  const patch = {
    mcVersion: $('sMcVersion').value.trim() || '1.21.11',
    fabricLoader: $('sFabric').value.trim(),
    ram: Number($('sRam').value) || 4096,
    width: Number($('sWidth').value) || 1280,
    height: Number($('sHeight').value) || 720,
    root: $('sRoot').value.trim(),
    gameDir: $('sGameDir').value.trim(),
    javaPath: $('sJava').value.trim(),
    extraJvmArgs: $('sJvm').value.trim(),
    useFabric: $('sFabricOn').checked,
    mcVersion: $('sMcVersion') ? $('sMcVersion').value : undefined,
    curseforgeApiKey: $('sCfKey') ? $('sCfKey').value.trim() : undefined,
    autoTune: $('sAutoTune') ? $('sAutoTune').checked : true,
    safetyMode: $('sSafety') ? $('sSafety').checked : false,
    closeLauncherOnLaunch: $('sCloseOnLaunch').checked,
  };
  const s = await api.patchSettings(patch);
  applySettings(s);
  $('saveHint').textContent = 'Saved.';
  setTimeout(() => { $('saveHint').textContent = ''; }, 2200);
  log('Settings saved.');
});

$('installBtn').addEventListener('click', async () => {
  const btn = $('installBtn');
  btn.disabled = true;
  setProgress(0, 'Starting…');
  const r = await api.install();
  btn.disabled = false;
  if (r.ok) {
    setProgress(100, `Installed ${r.mcVersion}${r.fabricLoader ? ` + Fabric ${r.fabricLoader}` : ''}`);
    log(`Install complete: ${r.mcVersion}${r.fabricLoader ? ` + fabric ${r.fabricLoader}` : ''}`);
  } else {
    setProgress(0, 'Install failed');
    log(`Install failed: ${r.error}`, true);
  }
});

/* -------------------------------------------------------------- launch */

api.onInstallProgress((p) => {
  const pct = p.total ? (p.done / p.total) * 100 : 0;
  setProgress(pct, `${p.label} ${p.done}/${p.total}`);
  if (p.phase === 'client' || p.phase === 'fabric') log(`${p.label}: ${p.done}/${p.total}`);
});
api.onInstallError((e) => log(`Install error: ${e.message}`, true));
api.onInstallDone((d) => {
  setProgress(100, `Ready · ${d.mcVersion}${d.fabric ? ` + Fabric ${d.fabric}` : ''}`);
});

api.onLaunchLog((l) => log(l.text, l.stream === 'stderr'));
api.onLaunchStatus((s) => {
  if (s.state === 'starting') { setProgress(0, `Launching ${s.version}…`); }
  if (s.state === 'exited') {
    setProgress(100, `Game closed (code ${s.code})`);
    $('playBtn').disabled = false;
    $('playBtn').classList.remove('busy');
    $('killBtn').hidden = true;
    log(`Game exited with code ${s.code}`);
  }
  if (s.state === 'error') {
    setProgress(0, 'Launch failed');
    $('playBtn').disabled = false;
    $('playBtn').classList.remove('busy');
    log(`Launch error: ${s.message}`, true);
  }
});

$('playBtn').addEventListener('click', async () => {
  if (state.busy) return;
  const btn = $('playBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.querySelector('.play-text').textContent = 'LAUNCHING';
  setProgress(2, 'Checking account…');
  log('--- Launch requested ---');
  const r = await api.play();
  if (!r.ok) {
    log(`Launch refused: ${r.error}`, true);
    setProgress(0, r.error.slice(0, 70));
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.querySelector('.play-text').textContent = 'PLAY';
  } else {
    setProgress(100, `Running ${r.version} (pid ${r.pid})`);
    $('killBtn').hidden = false;
    btn.querySelector('.play-text').textContent = 'RUNNING';
  }
});

$('killBtn').addEventListener('click', async () => {
  await api.kill();
  log('Kill requested.');
});

/* ------------------------------------------------------------- console */

$('clearLog').addEventListener('click', () => { $('console').innerHTML = ''; });

/* ---------------------------------------------------------------- boot */

(async function boot() {
  const info = await api.appInfo();
  $('appVer').textContent = `v${info.version}`;
  const s = await api.getSettings();
  applySettings(s);
  state.settings = s;
  initHardwareUi();
  initModTabs();
  await refreshAccount();
  await refreshMods();
  log(`VOID Client ${info.version} · Electron ${info.electron} · ${info.platform}/${info.arch}`);

  // The main process probes hardware in the background; pick up the result and
  // repaint the profile cards once it lands.
  if (api.onHardwareReady) {
    api.onHardwareReady(async (hw) => {
      renderHardware(hw);
      // Re-read settings from main so the card and the summary bar are painted
      // from the same post-probe snapshot (adaptive profiles were placeholders
      // during the first paint).
      const fresh = await api.getSettings();
      applySettings(fresh);
      repaintSummary(fresh, hw);
      log('Hardware profile tuned for this PC');
    });
  }
  loadHardware(false).catch(() => {});
  loadVersionList().catch(() => {});
  setProgress(0, 'Ready');

  // Keyboard: Shift+click account chip = sign out (documented in the hint).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12' && info.dev) {
      // handled by electron menu in dev
    }
  });
})();
