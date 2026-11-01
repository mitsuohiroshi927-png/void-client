'use strict';
/**
 * Preload bridge. Exposes a narrow, typed-ish API to the renderer.
 * No node internals leak through — contextIsolation is on.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('voidClient', {
  /* settings */
  profileCreate: (name, opts) => ipcRenderer.invoke('profile:create', name, opts),
  copyProfileMods: (fromId, toId) => ipcRenderer.invoke('profile:copyMods', fromId, toId),
  profileDelete: (id) => ipcRenderer.invoke('profile:delete', id),
  profileRename: (id, name) => ipcRenderer.invoke('profile:rename', id, name),
  profileSelect: (id) => ipcRenderer.invoke('profile:select', id),
  profileContentOf: (id) => ipcRenderer.invoke('profile:contentOf', id),

  /* launcher self-update */
  rpcTest: (clientId) => ipcRenderer.invoke('rpc:test', clientId),

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: (info) => ipcRenderer.invoke('update:download', info),
  updateApply: (info) => ipcRenderer.invoke('update:apply', info),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, p) => fn(p)),
  onUpdateAvailable: (fn) => ipcRenderer.on('update:available', (_e, info) => fn(info)),
  openProfileFolder: () => ipcRenderer.invoke('profile:openFolder'),
  // Profile-scoped RAM/resolution are stored per profile by main, not written
  // through settings:patch, so the active profile is never overwritten blindly.
  setProfileValues: (p) => ipcRenderer.invoke('profile:setValues', p),
  listVersions: (prefix) => ipcRenderer.invoke('versions:list', prefix),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (p) => ipcRenderer.invoke('settings:patch', p),
  pickDir: (kind) => ipcRenderer.invoke('settings:pickDir', kind),
  pickFile: (filters) => ipcRenderer.invoke('settings:pickFile', filters),

  /* modpacks + resource packs */
  searchProjects: (opts) => ipcRenderer.invoke('catalog:searchProjects', opts),
  listProjectVersions: (opts) => ipcRenderer.invoke('catalog:projectVersions', opts),
  installProject: (opts) => ipcRenderer.invoke('catalog:installProject', opts),
  listProfileContent: () => ipcRenderer.invoke('profile:content'),
  removeProfileContent: (kind, file) => ipcRenderer.invoke('profile:removeContent', kind, file),
  toggleProfileContent: (kind, file, disable) => ipcRenderer.invoke('profile:toggleContent', kind, file, disable),

  /* auth */
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authBegin: () => ipcRenderer.invoke('auth:begin'),
  authOpenLink: (url) => ipcRenderer.invoke('auth:openLink', url),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),
  onDeviceCode: (cb) => on('auth:device-code', cb),
  onAuthTick: (cb) => on('auth:tick', cb),
  onAuthDone: (cb) => on('auth:done', cb),
  onAuthError: (cb) => on('auth:error', cb),

  /* install */
  install: (opts) => ipcRenderer.invoke('install:run', opts),
  onInstallProgress: (cb) => on('install:progress', cb),
  onInstallDone: (cb) => on('install:done', cb),
  onInstallError: (cb) => on('install:error', cb),

  /* mods */
  inspectMods: () => ipcRenderer.invoke('mods:inspect'),
  installVoidFps: () => ipcRenderer.invoke('mods:installVoidFps'),
  addMods: () => ipcRenderer.invoke('mods:add'),
  addModPaths: (paths) => ipcRenderer.invoke('mods:addPaths', paths),
  // Electron 45 dropped File.path; webUtils is the supported way to turn a
  // dropped File into a real filesystem path.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  removeMod: (file) => ipcRenderer.invoke('mods:remove', file),
  modDependents: (file) => ipcRenderer.invoke('mods:dependents', file),
  resolveModDependencies: (hit, opts) => ipcRenderer.invoke('mods:dependencies', hit, opts),
  openFolder: (which) => ipcRenderer.invoke('mods:openFolder', which),

  /* integrity / repair */
  repairScan: () => ipcRenderer.invoke('repair:scan'),
  repairRun: (opts) => ipcRenderer.invoke('repair:run', opts),
  onRepairProgress: (cb) => on('repair:progress', cb),

  /* launch */
  play: () => ipcRenderer.invoke('launch:play'),
  kill: () => ipcRenderer.invoke('launch:kill'),
  onLaunchLog: (cb) => on('launch:log', cb),
  onLaunchStatus: (cb) => on('launch:status', cb),

  /* hardware / java runtime */
  probeHardware: () => ipcRenderer.invoke('hardware:probe'),
  listJava: () => ipcRenderer.invoke('java:list'),
  installJava: (opts) => ipcRenderer.invoke('java:install', opts),
  pickJava: () => ipcRenderer.invoke('java:pick'),
  onInstallLog: (cb) => on('install:log', cb),
  onHardwareReady: (cb) => on('hardware:ready', cb),

  /* dashboard stats */
  statsGet: () => ipcRenderer.invoke('stats:get'),
  statsStartPresence: () => ipcRenderer.invoke('stats:startPresence'),

  /* mod catalog */
  searchMods: (opts) => ipcRenderer.invoke('catalog:search', opts),
  installMod: (hit, opts) => ipcRenderer.invoke('catalog:install', hit, opts),
  testCurseforge: (key) => ipcRenderer.invoke('catalog:testCurseforge', key),
  onCatalogProgress: (cb) => on('catalog:progress', cb),
  onModsChanged: (cb) => on('mods:changed', cb),
  checkModUpdates: () => ipcRenderer.invoke('mods:checkUpdates'),
  applyModUpdate: (opts) => ipcRenderer.invoke('mods:applyUpdate', opts),

  /* performance mod set (the one-click FPS boost) */
  perfCheck: () => ipcRenderer.invoke('perf:check'),
  perfInstall: () => ipcRenderer.invoke('perf:install'),
  onPerfProgress: (cb) => on('perf:progress', cb),

  /* playtime */
  playtimeGet: () => ipcRenderer.invoke('playtime:get'),

  /* misc */
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
