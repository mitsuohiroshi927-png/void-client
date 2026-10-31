'use strict';
/* VOID Client — renderer logic. No node APIs; everything goes through the bridge. */

const api = window.voidClient;
const $ = (id) => document.getElementById(id);

/* Idle CPU thrift: while the window is hidden or minimised nothing can be seen,
   so every animation frame is wasted work. Freezing them here keeps a launcher
   parked in the tray at ~0% CPU instead of burning a core on a hidden glow. */
function applyVisibilityThrift() {
  const hidden = document.hidden;
  document.documentElement.classList.toggle('hidden', hidden);
  document.documentElement.classList.toggle('paused', hidden);
}
document.addEventListener('visibilitychange', applyVisibilityThrift);
window.addEventListener('blur', () => document.documentElement.classList.add('paused'));
window.addEventListener('focus', applyVisibilityThrift);
applyVisibilityThrift();

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
  // The Profiles page builds its cards on entry: counts come from disk, so
  // they go stale the moment a mod is installed elsewhere. Re-read settings so
  // a profile created since the last paint actually appears.
  if (btn.dataset.view === 'profiles') {
    api.getSettings().then((s) => renderProfileCards(s)).catch(() => renderProfileCards(state.settings));
  }
});

/* ------------------------------------------------------------ helpers */

/** Inline SVG icons: monochrome, currentColor, no emoji-font dependency.
 *  Emoji glyphs (📁 🗑 ⚙) render as colour bitmaps from the OS font — they clash
 *  with the launcher's single-accent palette and look different on every machine.
 */
const ICONS = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.6a1 1 0 0 1 1.5-.87l7 4.4a1 1 0 0 1 0 1.74l-7 4.4A1 1 0 0 1 4.5 11.4z" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 5.2A2.8 2.8 0 1 0 8 10.8 2.8 2.8 0 0 0 8 5.2zm0 4.1a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z" fill="currentColor"/><path d="M13.3 9.6a1.3 1.3 0 0 0 .26 1.43l.05.05a1.57 1.57 0 1 1-2.22 2.22l-.05-.05a1.3 1.3 0 0 0-1.43-.26 1.3 1.3 0 0 0-.79 1.19v.14a1.57 1.57 0 1 1-3.14 0v-.07a1.3 1.3 0 0 0-.85-1.19 1.3 1.3 0 0 0-1.43.26l-.05.05a1.57 1.57 0 1 1-2.22-2.22l.05-.05a1.3 1.3 0 0 0 .26-1.43 1.3 1.3 0 0 0-1.19-.79h-.14a1.57 1.57 0 1 1 0-3.14h.07a1.3 1.3 0 0 0 1.19-.85 1.3 1.3 0 0 0-.26-1.43l-.05-.05A1.57 1.57 0 1 1 4.4 1.68l.05.05a1.3 1.3 0 0 0 1.43.26h.07a1.3 1.3 0 0 0 .79-1.19v-.14a1.57 1.57 0 1 1 3.14 0v.07a1.3 1.3 0 0 0 .79 1.19 1.3 1.3 0 0 0 1.43-.26l.05-.05a1.57 1.57 0 1 1 2.22 2.22l-.05.05a1.3 1.3 0 0 0-.26 1.43v.07a1.3 1.3 0 0 0 1.19.79h.14a1.57 1.57 0 1 1 0 3.14h-.07a1.3 1.3 0 0 0-1.19.79z" fill="currentColor"/></svg>',
  folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3.5A1.25 1.25 0 0 1 3 2.25h2.9c.33 0 .65.13.88.37L8.02 3.8H13A1.25 1.25 0 0 1 14.25 5v7A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12z" fill="currentColor" opacity=".9"/></svg>',
  trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 1.5h3a1 1 0 0 1 1 1V3h2.5a.75.75 0 0 1 0 1.5h-.6l-.7 8.1a1.5 1.5 0 0 1-1.5 1.4H5.8a1.5 1.5 0 0 1-1.5-1.4l-.7-8.1H3A.75.75 0 0 1 3 3h2.5v-.5a1 1 0 0 1 1-1zm.5 1.5V3h2v-.5h-2zM5.6 4.5l.68 7.96a.1.1 0 0 0 .1.04h5.24a.1.1 0 0 0 .1-.04l.68-7.96z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.3 4.3a.9.9 0 0 1 0 1.27l-6.4 6.4a.9.9 0 0 1-1.27 0L2.7 9.04a.9.9 0 1 1 1.27-1.27l2.29 2.29 5.77-5.76a.9.9 0 0 1 1.27 0z" fill="currentColor"/></svg>',
  alert: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6a1.6 1.6 0 0 1 1.39.81l5.4 9.2A1.6 1.6 0 0 1 13.4 14H2.6a1.6 1.6 0 0 1-1.39-2.39l5.4-9.2A1.6 1.6 0 0 1 8 1.6zm0 3.7a.85.85 0 0 0-.85.9l.2 3.2a.65.65 0 0 0 1.3 0l.2-3.2A.85.85 0 0 0 8 5.3zm0 6.6a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.3 4.3a.85.85 0 0 1 1.2 0L8 6.8l2.5-2.5a.85.85 0 1 1 1.2 1.2L9.2 8l2.5 2.5a.85.85 0 1 1-1.2 1.2L8 9.2l-2.5 2.5a.85.85 0 0 1-1.2-1.2L6.8 8 4.3 5.5a.85.85 0 0 1 0-1.2z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2a.75.75 0 0 1 .75.75v3.3h3.3a.75.75 0 0 1 0 1.5h-3.3v3.3a.75.75 0 0 1-1.5 0v-3.3h-3.3a.75.75 0 0 1 0-1.5h3.3v-3.3A.75.75 0 0 1 8 3.2z" fill="currentColor"/></svg>',
};

/** Display name of the active profile, for messages like "added to ...". */
function activeProfileName() {
  const p = state.profiles && state.profiles[state.activeId];
  return (p && p.name) || state.activeId || 'this profile';
}

/** "1 mod" but "2 mods" — count labels must never read "1 mods". */
function plural(n, one, many) {
  return Number(n) === 1 ? one : (many || one + 's');
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Green/red toast. Errors stay until dismissed; successes fade after 4s. */
function toast(text, kind) {
  const err = kind === 'err';
  const host = $('toasts');
  if (!host) return log(text, err); // page without the host still reports
  const el = document.createElement('div');
  el.className = 'toast ' + (err ? 'toast-err' : 'toast-ok');
  el.setAttribute('role', err ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-ico">${err ? ICONS.alert : ICONS.check}</span>
    <span class="toast-msg"></span>
    ${err ? `<button class="toast-x" title="Dismiss">${ICONS.close}</button>` : ''}`;
  el.querySelector('.toast-msg').textContent = text;
  host.appendChild(el);
  // Two frames so the entry transition runs instead of being skipped.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  const kill = () => {
    if (!el.isConnected) return;
    el.classList.remove('in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // belt and braces if transitionend is missed
  };
  const btn = el.querySelector('.toast-x');
  if (btn) btn.addEventListener('click', kill);
  if (!err) setTimeout(kill, 4000);
  return el;
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
  // Settings page resolution. `storedProfile` is the user's own number; 0 means
  // auto, exactly like the profile panel.
  const sStored = (s.storedProfile || {});
  const sTuned = (s.hardware && s.hardware.tuned) || state.profileTuned || null;
  const sAuto = !Number(sStored.width) && !Number(sStored.height);
  $('sWidth').value = sAuto ? '' : String(s.width || 1280);
  $('sHeight').value = sAuto ? '' : String(s.height || 720);
  $('sWidth').placeholder = sAuto ? String((sTuned && sTuned.width) || 1280) : '';
  $('sHeight').placeholder = sAuto ? String((sTuned && sTuned.height) || 720) : '';
  $('sWidth').disabled = sAuto;
  $('sHeight').disabled = sAuto;
  if ($('sResSeg')) {
    setResMode('sResSeg', sAuto);
    $('sResHint').textContent = sAuto
      ? `Auto — recommended: ${(sTuned && sTuned.width) || 1280} × ${(sTuned && sTuned.height) || 720}`
      : 'Custom — your own resolution.';
  }
  $('sRoot').value = s.root || '';
  $('sGameDir').value = s.gameDir || '';
  $('sJava').value = s.javaPath || '';
  $('sJvm').value = s.extraJvmArgs || '';
  $('sFabricOn').checked = !!s.useFabric;
  if ($('sAutoTune')) $('sAutoTune').checked = s.autoTune !== false;
  if ($('sMcVersion')) $('sMcVersion').value = s.mcVersion || '1.21.11';
  if ($('sCfKey')) $('sCfKey').value = s.curseforgeApiKey || '';
  if ($('sSafety')) $('sSafety').checked = !!s.safetyMode;
  // ON by default: the launcher survives the game closing.
  if ($('sKeepOpen')) $('sKeepOpen').checked = s.keepLauncherOpen !== false;
  if ($('sDiscordRpc')) $('sDiscordRpc').checked = s.discordRpc !== false;
  if ($('sRpcId')) $('sRpcId').value = s.discordClientId || '';
  if ($('sAutoUpdate')) $('sAutoUpdate').checked = s.autoUpdate !== false;

  // Keep the Profiles page in sync when settings change (create/delete/switch).
  if ($('pfCards') && $('view-profiles')?.classList.contains('active')) renderProfileCards(s);

  // home stats
  // s.ram/width/height already carry the resolved profile values from main.
  const rp = s.resolvedProfile || null;
  // Hardware recommendation, used only as a hint by the profile panel.
  state.profileTuned = s.tuned || (state.hardware && state.hardware.tuned) || null;
  const ramMb = (rp && rp.ram) || s.ram || 4096;
  const rw = (rp && rp.width) || s.width || 1280;
  const rh = (rp && rp.height) || s.height || 720;
  // Panel first: it sets state.profileAuto, which the summary row reads to decide
  // whether to label a value as automatic.
  renderProfileList(s);
  renderRailProfiles(s);
  renderProfilePanel(s);
  paintSummaryRow(ramMb, rw, rh);
  $('homeSub').textContent = `Minecraft ${s.mcVersion} · ${s.useFabric ? 'Fabric' : 'Vanilla'}`;
  $('tagFabric').textContent = s.useFabric ? 'Fabric' : 'Vanilla';
  if ($('statVer')) $('statVer').textContent = s.mcVersion || '—';

}

const fmtRam = (mb) => `${Math.round(mb / 1024 * 10) / 10} GB`;

/**
 * Summary row (RAM / resolution under the Play button). Values labelled "Auto"
 * are coming from the hardware recommendation, not a deliberate user choice —
 * saying Auto · 8 GB is honest, printing a bare 8 GB is not.
 */
function paintSummaryRow(ramMb, rw, rh) {
  const auto = state.profileAuto || {};
  // RAM/resolution are owned by the profile panel; mirroring them here was pure
  // redundancy. Keep the resolved values in state for the panel to read.
  state.lastResolved = { ram: ramMb, width: rw, height: rh };
  $('statJava').textContent = state.settings && state.settings.javaPath ? 'custom' : 'auto';
  $('statDir').textContent = (state.settings && state.settings.gameDir) || '—';
  $('statDir').title = (state.settings && state.settings.gameDir) || '';
}

/**
 * Repaint the summary bar after the hardware probe lands. The probe resolves
 * late, so a profile still on "auto" gets new numbers — keep them labelled Auto.
 */
function repaintSummary(snap, hardware) {
  const tuned = (hardware && hardware.tuned) || null;
  const profiles = (snap && snap.profiles) || {};
  const activeId = (snap && snap.profile) || 'default';
  const p = profiles[activeId] || profiles.default || {};
  const ram = p.ram || (tuned ? tuned.ramMB : 4096);
  const w = p.width || (tuned ? tuned.width : 1280);
  const h = p.height || (tuned ? tuned.height : 720);
  state.profileAuto = { ram: !p.ram, res: !p.width && !p.height };
  paintSummaryRow(ram, w, h);
}

/**
 * The profile panel: RAM, resolution and JVM boost, all user-owned.
 *
 * A value of 0 means "whatever the hardware probe recommends" — we show that
 * recommendation as a hint and write an explicit number the moment the user
 * touches the control, so the choice survives restarts.
 */
function renderProfilePanel(s) {
  const stored = s.storedProfile || {};
  const tuned = state.profileTuned || null;

  // A stored 0 is the sentinel for "follow the hardware recommendation".
  const ram = Number(stored.ram) || (tuned ? tuned.ramMB : 4096);
  const w = Number(stored.width) || (tuned ? tuned.width : 1280);
  const h = Number(stored.height) || (tuned ? tuned.height : 720);

  // RAM ---------------------------------------------------------------
  const ramSlider = $('mpRam');
  ramSlider.value = String(ram);
  $('mpRamVal').textContent = fmtRam(ram);
  $('mpRamHint').textContent = tuned ? `Recommended: ${fmtRam(tuned.ramMB)}` : 'Recommended: —';

  // Resolution --------------------------------------------------------
  // Do NOT copy the recommendation into the inputs. A stored 0 means "auto", and
  // writing a number in would make auto look like an explicit user choice — the
  // summary row would then report a resolution the user never picked.
  const resolvedW = Number(stored.width) || (tuned ? tuned.width : 1280);
  const resolvedH = Number(stored.height) || (tuned ? tuned.height : 720);
  const autoRes = !Number(stored.width) && !Number(stored.height);
  $('mpW').value = autoRes ? '' : String(resolvedW);
  $('mpH').value = autoRes ? '' : String(resolvedH);
  $('mpW').placeholder = autoRes ? String(resolvedW) : '';
  $('mpH').placeholder = autoRes ? String(resolvedH) : '';
  $('mpResHint').textContent = tuned
    ? (autoRes ? `Auto — recommended: ${tuned.width} × ${tuned.height}` : `Recommended: ${tuned.width} × ${tuned.height}`)
    : 'Auto';
  setResMode('mpResSeg', autoRes);
  $('mpW').disabled = autoRes;
  $('mpH').disabled = autoRes;
  $('mpPreset').disabled = autoRes;

  // The preset dropdown only mirrors what is typed; it never overrides it.
  const preset = $('mpPreset');
  preset.value = '';
  if (!autoRes) {
    for (const opt of preset.options) {
      if (opt.value && opt.value === `${resolvedW}x${resolvedH}`) { preset.value = opt.value; break; }
    }
  }

  $('mpBoost').checked = !!s.boostFlags;

  // Expose the resolved values so the summary row can label them as automatic
  // instead of printing a number that implies a deliberate choice.
  state.profileAuto = { ram: !Number(stored.ram), res: autoRes };
  state.profileResolved = { ramMB: Number(stored.ram) || (tuned ? tuned.ramMB : 4096), width: resolvedW, height: resolvedH };
}

function paintBoostState() {}

/**
 * Paint the Auto|Custom segmented control.
 *
 * Leaving Auto stores the 0 sentinel back, which is what keeps the profile
 * adaptive; picking Custom only shows the fields — the number is written when the
 * user actually types one, so Auto never silently becomes a frozen value.
 */
function setResMode(segId, auto) {
  const seg = $(segId);
  if (!seg) return;
  for (const b of seg.querySelectorAll('.mp-seg-b')) {
    const on = (b.dataset.mode === 'auto') === !!auto;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/** Persist one profile value; main also updates the summary bar. */
async function saveProfileValue(patch) {
  const next = await api.setProfileValues(patch);
  state.settings = next;
  applySettings(next);
  const saved = $('mpSaved');
  saved.textContent = 'Saved.';
  setTimeout(() => { saved.textContent = 'Saved automatically'; }, 1600);
}

function initProfilePanel() {
  const ramSlider = $('mpRam');
  ramSlider.addEventListener('input', () => {
    $('mpRamVal').textContent = fmtRam(Number(ramSlider.value));
  });
  ramSlider.addEventListener('change', () => {
    saveProfileValue({ ram: Number(ramSlider.value) });
  });

  // Auto|Custom. Choosing Custom just reveals the fields and pre-fills today's
  // recommendation so the user edits a real number instead of a blank box; nothing
  // is stored until they change something (that keeps Auto honest).
  $('mpResSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.mp-seg-b');
    if (!b) return;
    const auto = b.dataset.mode === 'auto';
    setResMode('mpResSeg', auto);
    $('mpW').disabled = auto;
    $('mpH').disabled = auto;
    $('mpPreset').disabled = auto;
    if (auto) {
      // 0 = follow the hardware recommendation.
      saveProfileValue({ width: 0, height: 0 });
    } else {
      const w = Number($('mpW').value) || state.profileResolved.width;
      const h = Number($('mpH').value) || state.profileResolved.height;
      $('mpW').value = String(w);
      $('mpH').value = String(h);
      $('mpW').placeholder = '';
      $('mpH').placeholder = '';
      $('mpW').focus();
      $('mpResHint').textContent = `Custom — recommended: ${state.profileResolved.width} × ${state.profileResolved.height}`;
    }
  });

  const resInputs = [$('mpW'), $('mpH')];
  for (const el of resInputs) {
    el.addEventListener('change', () => {
      const w = Math.max(320, Math.min(7680, Number($('mpW').value) || 1280));
      const h = Math.max(240, Math.min(4320, Number($('mpH').value) || 720));
      saveProfileValue({ width: w, height: h });
    });
  }

  $('mpPreset').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) return;
    const [w, h] = v.split('x').map(Number);
    $('mpW').value = String(w);
    $('mpH').value = String(h);
    saveProfileValue({ width: w, height: h });
  });

  $('mpBoost').addEventListener('change', async (e) => {
    const next = await api.patchSettings({ boostFlags: e.target.checked });
    state.settings = next;
    applySettings(next);
    log(`JVM boost ${e.target.checked ? 'enabled' : 'disabled'}`);
  });

  // The Settings page has its own Auto|Custom pair; saving is done by "Save settings",
  // so this only toggles the visible state. Setting width/height to 0 there is handled
  // in the save handler.
  $('sResSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.mp-seg-b');
    if (!b) return;
    const auto = b.dataset.mode === 'auto';
    setResMode('sResSeg', auto);
    const tuned = state.profileTuned || {};
    const rw = Number($('sWidth').value) || tuned.width || 1280;
    const rh = Number($('sHeight').value) || tuned.height || 720;
    $('sWidth').disabled = auto;
    $('sHeight').disabled = auto;
    if (auto) {
      $('sWidth').value = '';
      $('sHeight').value = '';
      $('sWidth').placeholder = String(tuned.width || 1280);
      $('sHeight').placeholder = String(tuned.height || 720);
      $('sResHint').textContent = `Auto — recommended: ${tuned.width || 1280} × ${tuned.height || 720}`;
    } else {
      $('sWidth').value = String(rw);
      $('sHeight').value = String(rh);
      $('sWidth').placeholder = '';
      $('sHeight').placeholder = '';
      $('sResHint').textContent = 'Custom — your own resolution.';
      $('sWidth').focus();
    }
  });

  $('mpReset').addEventListener('click', async () => {
    // 0 is the sentinel for "follow the hardware recommendation".
    await api.setProfileValues({ ram: 0, width: 0, height: 0 });
    const next = await api.getSettings();
    state.settings = next;
    applySettings(next);
    log('Profile reset to the hardware recommendation');
  });
}

/* ------------------------------------------------------- mod browser */

const browse = { source: 'modrinth', type: 'mod', lastQuery: '', busy: false };

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

  for (const b of document.querySelectorAll('.typ')) {
    b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('.typ')) o.classList.toggle('active', o === b);
      browse.type = b.dataset.type || 'mod';
      // CurseForge has no resource-pack project type, so keep the user honest
      // instead of returning an empty list for a search that cannot work.
      if (browse.type === 'resourcepack' && browse.source === 'curseforge') {
        const mr = document.querySelector('.src[data-src="modrinth"]');
        if (mr) mr.click();
      }
      $('typeNote').textContent = browse.type === 'modpack'
        ? 'A modpack builds its own profile content — it overwrites matching files'
        : browse.type === 'resourcepack'
          ? 'Goes into this profile\'s resourcepacks/ folder'
          : browse.type === 'shader'
            ? 'Goes into this profile\'s shaderpacks/ folder'
            : 'Installs into the active profile';
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

  // Resource packs and modpacks go through the typed Modrinth endpoint; only
  // plain mods use the source-aware one (CurseForge has no pack/rp types).
  const r = browse.type === 'mod' && browse.source !== 'curseforge'
    ? await api.searchMods({ source: browse.source, query: q })
    : await api.searchProjects({ query: q, type: browse.type });
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

  const TYPE_LABEL = { resourcepack: 'resource packs', shader: 'shaders', modpack: 'modpacks', mod: 'mods' };
  $('browseHint').textContent = (browse.type !== 'mod' && browse.type !== 'modpack')
    ? `Filtered for Minecraft ${r.mcVersion} · ${TYPE_LABEL[browse.type] || browse.type}`
    : `Filtered for Minecraft ${r.mcVersion} · Fabric`;
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
    const NOUN = { mod: 'mods', modpack: 'modpacks', resourcepack: 'resource packs', shader: 'shaders' };
    box.innerHTML = `<div class="catalog-empty">No ${NOUN[browse.type] || 'results'} matched. Try another name or a different Minecraft version.</div>`;
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
  const type = hit.type || browse.type || 'mod';
  btn.classList.add('loading');
  btn.textContent = '…';

  const r = type === 'mod'
    ? await api.installMod(hit)
    : await api.installProject({ project: hit, type });

  btn.classList.remove('loading');
  if (r.ok) {
    btn.outerHTML = '<span class="installed-tag">installed</span>';
    if (r.kind === 'modpack') {
      // A pack reports how much of itself actually landed — never assume all of it.
      const missed = (r.failed || []).length;
      const line = `${r.packName} installed into "${r.profile}" — ${r.installed}/${r.total} files`
        + (missed ? ` (${missed} failed)` : '');
      log(line, missed > 0);
      // Toast only on a clean run: a half-installed pack is not a success.
      toast(missed ? `${r.packName}: ${r.installed}/${r.total} files — ${missed} failed`
                   : `${r.packName} added to "${r.profile}" (${r.installed} files)`, missed ? 'err' : 'ok');
      if (r.declaredMc) log(`Modpack pins Minecraft ${r.declaredMc} — the client now uses that version.`);
    } else {
      const where = r.profile || activeProfileName();
      log(`Installed ${hit.name} ${r.file || ''}`.trim());
      toast(`${hit.name} added to "${where}"`, 'ok');
    }
    refreshMods();
    loadProfileContent();
  } else {
    btn.textContent = 'Retry';
    btn.title = r.error || '';
    toast(`Could not install ${hit.name}: ${r.error}`, 'err');
    log(`Install failed (${hit.name}): ${r.error}`, true);
  }
}

/* ------------------------------------------------- profile list + content */

/**
 * The profile switcher. Each row is one profile the user made; selecting a row
 * changes which folder the client launches and where downloads land, so the rows
 * have to show that difference plainly (name + mod count + pack badge).
 */
function renderProfileList(s) {
  const box = $('pfList');
  if (!box) return;
  const profiles = s.profiles || {};
  const activeId = s.profile;
  box.innerHTML = '';

  for (const id of Object.keys(profiles)) {
    const p = profiles[id];
    const row = document.createElement('div');
    row.className = 'pf-row' + (id === activeId ? ' active' : '');

    const modpackBadge = p.modpack && p.modpack.name
      ? `<span class="pf-pack" title="Built from ${esc(p.modpack.name)}">◈ ${esc(p.modpack.name)}</span>`
      : '';

    row.innerHTML = `
      <span class="pf-ico">${esc(p.icon || '◈')}</span>
      <span class="pf-main">
        <input class="pf-name" value="${esc(p.name || id)}" data-rename="${esc(id)}" maxlength="24" />
        <span class="pf-meta">${p.ram ? gb(p.ram) : 'auto RAM'} · ${p.width || 1280}×${p.height || 720} ${modpackBadge}</span>
      </span>
      <button class="btn tiny ghost pf-del" data-del="${esc(id)}" title="Delete profile">✕</button>
    `;

    row.addEventListener('click', async (e) => {
      // Clicking a row selects it; the name field and delete button keep their
      // own behaviour so renaming never accidentally switches profile.
      if (e.target.closest('.pf-name') || e.target.closest('.pf-del')) return;
      if (id === activeId) return;
      const r = await api.profileSelect(id);
      if (!r.ok) return log(`Could not switch profile: ${r.error}`, true);
      state.settings = await api.getSettings();
      applySettings(state.settings);
      log(`Switched to profile "${p.name || id}"`);
      refreshMods();
      loadProfileContent();
    });

    const nameInput = row.querySelector('.pf-name');
    const commitRename = async () => {
      const next = nameInput.value.trim();
      if (!next || next === (p.name || id)) { nameInput.value = p.name || id; return; }
      const r = await api.profileRename(id, next);
      if (!r.ok) { nameInput.value = p.name || id; return log(`Rename failed: ${r.error}`, true); }
      log(`Profile renamed to "${next}"`);
      state.settings = await api.getSettings();
      applySettings(state.settings);
    };
    nameInput.addEventListener('blur', commitRename);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      if (e.key === 'Escape') { nameInput.value = p.name || id; nameInput.blur(); }
    });

    row.querySelector('.pf-del').addEventListener('click', async () => {
      if (Object.keys(profiles).length <= 1) return log('You need at least one profile.', true);
      const r = await api.profileDelete(id);
      if (!r.ok) return log(`Delete failed: ${r.error}`, true);
      log(`Profile "${p.name || id}" deleted`);
      state.settings = await api.getSettings();
      applySettings(state.settings);
      loadProfileContent();
    });

    box.appendChild(row);
  }
}

/**
 * The rail's profile switcher. One click per profile — a user with a survival
 * profile, a PvP profile and a modpack profile should never have to open a page
 * to get between them. The active row is marked so it is obvious where you are.
 */
function renderRailProfiles(s) {
  const box = $('rpList');
  if (!box) return;
  const profiles = s.profiles || {};
  const activeId = s.profile;
  const ids = Object.keys(profiles);
  box.innerHTML = '';

  if (!ids.length) {
    box.innerHTML = '<div class="rp-empty">No profiles yet</div>';
    return;
  }

  for (const id of ids) {
    const p = profiles[id];
    const btn = document.createElement('button');
    btn.className = 'rp-item' + (id === activeId ? ' active' : '');
    btn.title = `${p.name || id} - click to switch`;
    btn.innerHTML = `
      <span class="rp-ico">${esc(p.icon || '◈')}</span>
      <span class="rp-txt">${esc(p.name || id)}</span>
    `;
    btn.addEventListener('click', async () => {
      if (id === activeId) return;
      const r = await api.profileSelect(id);
      if (!r.ok) return log(`Could not switch profile: ${r.error}`, true);
      log(`Switched to profile "${p.name || id}"`);
      state.settings = await api.getSettings();
      applySettings(state.settings);
      refreshMods();
      loadProfileContent();
    });
    box.appendChild(btn);
  }
}

/** What the active profile actually owns on disk, per kind. */
const profileContent = { mod: [], resourcepack: [], shader: [], kind: 'mod' };

/** Big profile cards for the Profiles page: each one shows what it holds and
 *  can launch straight from the card. */
async function renderProfileCards(s) {
  const box = $('pfCards');
  if (!box) return;
  const profiles = s.profiles || {};
  const activeId = s.profile;
  const ids = Object.keys(profiles);
  box.innerHTML = '';

  for (const id of ids) {
    const p = profiles[id];
    const isActive = id === activeId;

    // Count what this profile owns right now. Cheap: stat the three folders.
    let counts = { mods: 0, packs: 0, shaders: 0 };
    try {
      const r = await api.profileContentOf(id);
      if (r && r.ok) counts = { mods: (r.mods || []).length, packs: (r.resourcepacks || []).length, shaders: (r.shaders || []).length };
    } catch { /* older main without the handler: show zeros rather than fail */ }

    const card = document.createElement('div');
    card.className = 'pf-card' + (isActive ? ' active' : '');
    card.innerHTML = `
      <div class="pfc-top">
        <span class="pfc-ico">${esc(p.icon || '◈')}</span>
        <span class="pfc-meta">
          <span class="pfc-name">${esc(p.name || id)}</span>
          <span class="pfc-sub">${p.ram ? gb(p.ram) : 'Auto RAM'} · ${p.width || 1280}×${p.height || 720}</span>
        </span>
        ${isActive ? '<span class="pfc-badge">ACTIVE</span>' : ''}
      </div>
      ${p.modpack && p.modpack.name ? `<div class="pfc-pack">◈ ${esc(p.modpack.name)}</div>` : ''}
      <div class="pfc-stats">
        <span class="pfc-stat"><b>${counts.mods}</b> ${plural(counts.mods, 'mod')}</span>
        <span class="pfc-stat"><b>${counts.packs}</b> ${plural(counts.packs, 'pack')}</span>
        <span class="pfc-stat"><b>${counts.shaders}</b> ${plural(counts.shaders, 'shader')}</span>
      </div>
      <div class="pfc-actions">
        <button class="btn primary sm pfc-play">${isActive ? `${ICONS.play} Play` : 'Switch &amp; play'}</button>
        <button class="btn ghost sm pfc-settings" title="RAM, resolution, icon">${ICONS.gear} Settings</button>
        <button class="btn ghost sm icon-only pfc-open" title="Open this profile's folder">${ICONS.folder}</button>
        <button class="btn danger sm icon-only pfc-del" title="Delete profile">${ICONS.trash}</button>
      </div>
    `;

    // Selecting first matters: launching into the wrong profile would put the
    // mods on someone else's setup.
    const select = async () => {
      if (id === activeId) return true;
      const r = await api.profileSelect(id);
      if (!r.ok) { log(`Could not switch profile: ${r.error}`, true); return false; }
      state.settings = await api.getSettings();
      applySettings(state.settings);
      log(`Switched to profile "${p.name || id}"`);
      refreshMods();
      loadProfileContent();
      return true;
    };

    card.querySelector('.pfc-play').addEventListener('click', async () => {
      if (!(await select())) return;
      if (window.launchGame) launchGame();
    });
    card.querySelector('.pfc-open').addEventListener('click', async () => {
      if (!(await select())) return;
      api.openProfileFolder?.();
    });
    // Per-profile RAM / resolution live in the Play page's profile panel. There
    // was no way to reach them from a card, so "Settings" scrolls there.
    card.querySelector('.pfc-settings').addEventListener('click', async () => {
      if (!(await select())) return;
      document.querySelector('[data-view="home"]')?.click();
      await new Promise((r) => setTimeout(r, 80));
      const grid = document.querySelector('.myprofile');
      if (grid) {
        grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        grid.classList.add('mp-flash');
        setTimeout(() => grid.classList.remove('mp-flash'), 1200);
      }
    });
    card.querySelector('.pfc-del').addEventListener('click', async () => {
      if (ids.length <= 1) return log('You need at least one profile.', true);
      const r = await api.profileDelete(id);
      if (!r.ok) return log(`Delete failed: ${r.error}`, true);
      log(`Profile "${p.name || id}" deleted`);
      state.settings = await api.getSettings();
      applySettings(state.settings);
      loadProfileContent();
    });

    box.appendChild(card);
  }
}

async function loadProfileContent() {
  if (!api.listProfileContent) return;
  const r = await api.listProfileContent();
  if (!r || !r.ok) return;
  profileContent.mod = r.mods || [];
  profileContent.resourcepack = r.resourcepacks || [];
  profileContent.shader = r.shaders || [];
  $('pcNMod').textContent = String(profileContent.mod.length);
  $('pcNRp').textContent = String(profileContent.resourcepack.length);
  $('pcNSh').textContent = String(profileContent.shader.length);
  if ($('pcSub')) $('pcSub').textContent = `In ${r.profileName}`;
  renderProfileContent();
}

function renderProfileContent() {
  const box = $('pcList');
  if (!box) return;
  const items = profileContent[profileContent.kind] || [];
  if (!items.length) {
    const LABEL = { mod: 'mods', resourcepack: 'resource packs', shader: 'shaders' };
    const KIND = LABEL[profileContent.kind] || 'content';
    box.innerHTML = `<div class="pc-empty">No ${KIND} in this profile yet.`
      + `<br/>Add them from the Mods page.</div>`;
    return;
  }
  box.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'pc-row' + (it.disabled ? ' off' : '');
    // `it.file` is the real on-disk name (with the .disabled suffix); `it.name`
    // is the clean name shown to the user.
    const onDisk = it.file || it.name;
    row.innerHTML = `
      <span class="pc-nm" title="${esc(onDisk)}">${esc(it.name)}</span>
      <span class="pc-sz">${fmtBytes(it.size)}</span>
      <span class="pc-st">${it.disabled ? 'off' : 'on'}</span>
      <button class="btn tiny ghost pc-tg" data-tg="${esc(onDisk)}" title="${it.disabled ? 'Enable mod' : 'Disable mod'}">${it.disabled ? 'Off' : 'On'}</button>
      <button class="btn tiny danger icon-only pc-x" data-rm="${esc(onDisk)}" title="Delete">${ICONS.trash}</button>
    `;
    row.querySelector('[data-tg]').addEventListener('click', async () => {
      const r = await api.toggleProfileContent(it.kind, onDisk, !it.disabled);
      if (!r.ok) { toast(`Could not change ${it.name}: ${r.error}`, 'err'); return log(`Toggle failed: ${r.error}`, true); }
      const was = it.disabled ? 'Enabled' : 'Disabled';
      log(`${was} ${it.name}`);
      toast(`${was} ${it.name}`, 'ok');
      loadProfileContent();
      refreshMods();
    });
    row.querySelector('[data-rm]').addEventListener('click', async () => {
      const r = await api.removeProfileContent(it.kind, onDisk);
      if (!r.ok) { toast(`Could not delete ${it.name}: ${r.error}`, 'err'); return log(`Remove failed: ${r.error}`, true); }
      log(`Deleted ${it.name} from this profile`);
      toast(`${it.name} deleted from "${activeProfileName()}"`, 'ok');
      loadProfileContent();
      refreshMods();
    });
    box.appendChild(row);
  }
}

function initProfileContent() {
  for (const tab of document.querySelectorAll('.pc-tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.pc-tab')) t.classList.toggle('active', t === tab);
      profileContent.kind = tab.dataset.kind || 'mod';
      renderProfileContent();
    });
  }
  if ($('pcRefresh')) $('pcRefresh').addEventListener('click', loadProfileContent);
}

/**
 * Create a profile through the inline row. Shared by the "+ New profile" button
 * on the Play page and the "+" at the top of the rail so both paths behave
 * identically (same rename/commit logic, same follow-up switch).
 */
async function createProfileInline(box) {
  if (!box) return;
  // Inline row instead of a modal: no dialog dependency, and the name is
  // committed with the same rename path the existing rows use.
  if (box.querySelector('.pf-new-row')) return;
  const row = document.createElement('div');
  row.className = 'pf-row pf-new-row';
  row.innerHTML = `
    <span class="pf-ico">◈</span>
    <span class="pf-main"><input class="pf-name" placeholder="New profile name…" maxlength="24" /></span>
    <button class="btn tiny primary" id="pfNewOk">Create</button>
  `;
  box.prepend(row);
  const input = row.querySelector('.pf-name');
  input.focus();
  const create = async () => {
    const name = input.value.trim();
    if (!name) return row.remove();
    const r = await api.profileCreate(name, {});
    if (!r.ok) { log(`Could not create profile: ${r.error}`, true); return; }
    log(`Profile "${name}" created — its own mods, RAM and resolution`);
    const next = await api.profileSelect(r.id);
    if (next.ok) {
      state.settings = await api.getSettings();
      applySettings(state.settings);
    }
    loadProfileContent();
  };
  row.querySelector('#pfNewOk').addEventListener('click', create);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
    if (e.key === 'Escape') row.remove();
  });
}

function initProfileList() {
  // Both "+" buttons lead to the Profiles page and start the same inline row —
  // one creation UI, not two. The rail button used to bounce to Play, which
  // meant creating a profile and then having to navigate back to find it.
  const startCreate = async () => {
    const cur = document.querySelector('.nav-item.active')?.dataset.view;
    if (cur !== 'profiles') {
      document.querySelector('[data-view="profiles"]')?.click();
      // renderProfileCards is async; give the cards a beat to paint so the new
      // row lands under them instead of on an empty page.
      await new Promise((r) => setTimeout(r, 60));
    }
    createProfileInline($('pfCards'));
  };
  if ($('rpAdd')) $('rpAdd').addEventListener('click', startCreate);
  if ($('profNewBtn')) $('profNewBtn').addEventListener('click', startCreate);
  if (!$('pfNew')) return;
  $('pfNew').addEventListener('click', () => createProfileInline($('pfList')));
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
  renderProfilePanel(state.settings || {});
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
        <div class="empty-s">Browse Modrinth or CurseForge above, or press “+ Add .jar” — you can also drag .jar files straight from Explorer into this window.</div>
      </div>`;
  }
  for (const m of real) {
    const el = document.createElement('div');
    el.className = 'mod-item' + (m.disabled ? ' off' : '');
    el.innerHTML = `
      <div class="mod-ico">${esc((m.name || m.file).slice(0, 1).toUpperCase())}</div>
      <div class="mod-body">
        <div class="mod-name">${esc(m.name || m.file)}${m.version ? ` <span class="badge">${esc(m.version)}</span>` : ''}${m.shared ? ' <span class="badge">shared</span>' : ''}</div>
        <div class="mod-sub">${esc(m.file)} · <b>${fmtBytes(m.size)}</b>${m.disabled ? ' · <b>disabled</b>' : ''}</div>
      </div>
      <button class="btn ghost sm mod-tg" title="${m.disabled ? 'Enable mod' : 'Disable mod'}">${m.disabled ? 'Off' : 'On'}</button>
      <button class="btn danger sm icon-only mod-x" title="Delete">${ICONS.trash}</button>
    `;
    const [tg, rm] = el.querySelectorAll('button');
    tg.addEventListener('click', async () => {
      const r = m.shared
        ? { ok: false, error: 'This mod lives in the shared mods/ folder, not in this profile.' }
        : await api.toggleProfileContent('mod', m.file, !m.disabled);
      if (!r.ok) { toast(`Could not change ${m.name || m.file}: ${r.error}`, 'err'); return log(`Toggle failed: ${r.error}`, true); }
      const was = m.disabled ? 'Enabled' : 'Disabled';
      log(`${was} ${m.name || m.file}`);
      toast(`${was} ${m.name || m.file}`, 'ok');
      await refreshMods();
      await loadProfileContent();
    });
    rm.addEventListener('click', async () => {
      if (m.shared) { toast('This mod lives in the shared mods/ folder, not in this profile.', 'err'); return log('This mod lives in the shared mods/ folder, not in this profile.', true); }
      const r = await api.removeProfileContent('mod', m.file);
      if (!r.ok) { toast(`Could not delete ${m.name || m.file}: ${r.error}`, 'err'); return log(`Delete failed: ${r.error}`, true); }
      log(`Deleted ${m.name || m.file}`);
      toast(`${m.name || m.file} deleted from "${activeProfileName()}"`, 'ok');
      await refreshMods();
      await loadProfileContent();
    });
    list.appendChild(el);
  }
}

$('addModBtn').addEventListener('click', async () => {
  const r = await api.addMods();
  if (r.ok) {
    const n = (r.added || []).length;
    if (!n) return;                     // user cancelled the file dialog
    log(`Added ${n} mod(s).`);
    toast(`${plural(n, 'mod')} added to "${r.profile || activeProfileName()}"`, 'ok');
    await refreshMods();
  } else {
    toast(`Could not add mods: ${r.error}`, 'err');
    log(`Add mods failed: ${r.error}`, true);
  }
});

// Drag & drop straight from Explorer. Electron gives us the real paths, so a jar
// dropped here lands in the active profile's mods/ just like "+ Add .jar".
(function initDropZone() {
  const zone = document.querySelector('[data-view="mods"]');
  if (!zone) return;
  let depth = 0;                       // dragenter/leave fire per child element
  const clear = () => { depth = 0; zone.classList.remove('dropping'); };
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++depth === 1) zone.classList.add('dropping');
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) clear(); });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); clear();
    const files = [...(e.dataTransfer.files || [])];
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const r = await api.addModPaths(paths);
    if (r && r.ok && r.added.length) {
      const n = r.added.length;
      log(`Added ${n} file(s) to ${r.profile}.`);
      toast(`${plural(n, 'mod')} added to "${r.profile || activeProfileName()}"`, 'ok');
      await refreshMods();
      await loadProfileContent();
    } else if (r && !r.ok) {
      toast(`Could not add mods: ${r.error || 'unknown error'}`, 'err');
      log(`Drop failed: ${r.error || 'unknown error'}`, true);
    }
  });
})();
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


// Verify a Discord Application ID before the user commits to it: a wrong id
// fails silently at runtime, which looks like the feature is broken.
if ($('rpcTestBtn')) {
  $('rpcTestBtn').addEventListener('click', async () => {
    const hint = $('rpcTestHint');
    const id = $('sRpcId') ? $('sRpcId').value.trim() : '';
    hint.textContent = 'Testing…';
    hint.className = 'muted';
    const r = await api.rpcTest(id);
    if (r && r.ok) {
      hint.textContent = 'Connected — check your Discord profile now.';
      hint.className = 'muted ok';
    } else {
      hint.textContent = (r && r.error) || 'Could not connect.';
      hint.className = 'muted bad';
    }
  });
}

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
    keepLauncherOpen: $('sKeepOpen') ? $('sKeepOpen').checked : true,
    discordRpc: $('sDiscordRpc') ? $('sDiscordRpc').checked : true,
    discordClientId: $('sRpcId') ? $('sRpcId').value.trim() : '',
    autoUpdate: $('sAutoUpdate') ? $('sAutoUpdate').checked : true,
  };
  // Auto means "follow the recommendation": store the sentinels instead of whatever
  // number happens to be sitting (disabled) in the field.
  if ($('sResSeg') && $('sResSeg').querySelector('.mp-seg-b.active')?.dataset.mode === 'auto') {
    patch.width = 0;
    patch.height = 0;
  }
  try {
    const s = await api.patchSettings(patch);
    applySettings(s);
    $('saveHint').textContent = 'Saved.';
    setTimeout(() => { $('saveHint').textContent = ''; }, 2200);
    log('Settings saved.');
    toast('Settings saved.', 'ok');
  } catch (e) {
    toast(`Could not save settings: ${e.message}`, 'err');
  }
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

/**
 * Community stats. The server count is authoritative; when the endpoint is down
 * we show local numbers and label them as such — never a made-up player count.
 */
async function paintStats() {
  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  let d;
  try {
    d = await api.statsGet();
  } catch {
    d = { ok: false };
  }
  const src = $('statSrc');
  if (!d || !d.ok) {
    $('statOnline').textContent = '—';
    for (const id of ['statToday', 'statUnique', 'statSessions']) $(id).textContent = '—';
    src.textContent = 'stats unavailable';
    src.className = 'stat-src';
    return;
  }
  $('statOnline').textContent = fmt(d.online);
  $('statToday').textContent = fmt(d.today);
  $('statUnique').textContent = fmt(d.total_players);
  $('statSessions').textContent = fmt(d.total_sessions);
  if (d.source === 'server') {
    src.textContent = `live · ${d.window || 120}s window`;
    src.className = 'stat-src live';
  } else {
    src.textContent = d.error ? 'local only · server unreachable' : 'local only · no endpoint';
    src.className = 'stat-src local';
  }
}

(async function boot() {
  const info = await api.appInfo();
  $('appVer').textContent = `v${info.version}`;
  const s = await api.getSettings();
  applySettings(s);
  state.settings = s;
  initHardwareUi();
  initModTabs();
  initProfilePanel();
  initProfileList();
  initProfileContent();
  await refreshAccount();
  await refreshMods();
  await paintStats();
  loadProfileContent();
  if (api.statsStartPresence) api.statsStartPresence().catch(() => {});
  // Presence window is 120s; refresh twice as often so the number tracks reality.
  setInterval(() => {
    // A hidden window cannot show the result, so skip the fetch and the repaint.
    if (document.hidden) return;
    paintStats().catch(() => {});
  }, 60000);
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
