'use strict';
/**
 * The performance mod set — the list that makes VOID Client feel like a
 * client-side boost rather than a plain launcher.
 *
 * Design rules, learned the hard way:
 *
 *  - Every entry is a **Modrinth slug**, never a hardcoded file URL. Modrinth
 *    serves per-loader/per-version files, so a pinned URL rots the moment the
 *    author publishes for a new Minecraft version, while a slug re-resolves.
 *  - `mc` records the version set this list was verified against. A slug whose
 *    project does not publish for the selected game version is SKIPPED, not
 *    forced: installing a mod built for 1.21.x into a 26.x profile is how a
 *    profile ends up crashing on boot.
 *  - Every mod here must be **client-side only**. The launcher never runs a
 *    server, and a server-side mod (ServerCore) in a client profile buys
 *    nothing while adding boot risk.
 *  - Nothing here is required for correctness: if any download fails the
 *    profile still boots with the mods that did land. A performance pack must
 *    never be a hard dependency of launching.
 *
 * `group` is the reason the mod is in the list, shown in the UI. Keeping it
 * honest matters: "renders fewer chunks" and "frees memory" are different
 * promises and the user can see which they are getting.
 */
const PERF_MODS = [
  // --- rendering: the biggest frame-time wins -----------------------------
  { slug: 'sodium',        group: 'FPS',    why: 'Rewrites the chunk renderer: the single biggest FPS gain.' },
  { slug: 'cull-leaves',   group: 'FPS',    why: 'Leaves render only the faces you can actually see.' },
  { slug: 'moreculling',   group: 'FPS',    why: 'Culls block faces hidden by other blocks.' },
  { slug: 'entityculling', group: 'FPS',    why: 'Skips rendering entities that are behind walls.' },
  { slug: 'particleculling', group: 'FPS', why: 'Hides particles you cannot see.' },
  { slug: 'particle-core', group: 'FPS',    why: 'Makes particle rendering cheaper.' },
  { slug: 'greedy-meshing', group: 'FPS',   why: 'Merges adjacent block faces into one quad.' },
  { slug: 'clear-fog',        group: 'Visual', why: 'Removes fog, which also drops a draw pass.' },
  { slug: 'obe',           group: 'FPS',    why: 'Optimised block entities (chests, signs, banners).' },
  { slug: 'scalablelux',   group: 'FPS',    why: 'Multithreads light updates (ex-Sodium light engine).' },
  { slug: 'badoptimizations', group: 'FPS', why: 'Removes CPU work per frame that nothing needs.' },

  // --- memory + CPU -------------------------------------------------------
  { slug: 'lithium',       group: 'CPU',    why: 'Optimises the game logic itself: physics, AI, ticking.' },
  { slug: 'ferrite-core',   group: 'Memory', why: 'Cuts block/item model memory by up to a third.' },
  { slug: 'krypton',       group: 'Network',why: 'Faster, lighter networking stack.' },
  { slug: 'clumps',        group: 'FPS',    why: 'Merges clumps of XP orbs into a single entity.' },
  { slug: 'c2me-fabric',   group: 'Chunks', why: 'Loads chunks on multiple threads.' },
  { slug: 'dynamic-fps',   group: 'FPS',    why: 'Drops the frame rate while the window is in the background.' },
  // --- SERVER / multiplayer: what makes playing on a server smooth ---------
  // "Server mods" means mods that make the CLIENT better at being on a server,
  // not mods you install on the server. Every entry below was checked to be
  // client-side (client_side=required/optional, server_side != required) — a
  // server-only mod such as ServerCore, Ksyxis or VMP does nothing in a client
  // profile, and shipping one would just be boot risk for zero frames.
  { slug: 'fastserverpings',  group: 'Server', why: 'Rewrites the server-list ping so the multiplayer menu fills instantly.' },
  { slug: 'serverpingerfixer', group: 'Server', why: 'Fixes the ping shown for servers whose icon fails to load.' },
  { slug: 'serverlist-fix',   group: 'Server', why: 'Lifts the thread cap that makes large server lists stall.' },
  { slug: 'serveraddressspacefix', group: 'Server', why: 'Fixes "unknown host" when adding an address with spaces or a port.' },
  { slug: 'resourcepackcached', group: 'Server', why: 'Keeps the server resource pack on disk so re-joining does not re-download it.' },
  { slug: 'server-resource-pack-checker', group: 'Server', why: 'Only applies a server pack when it actually changed — no reload stall.' },
  { slug: 'fast-ip-ping',  group: 'Network',why: 'Resolves server addresses faster.' },
  { slug: 'better-render-distance', group: 'FPS', why: 'Makes render distance spherical, so fewer chunks render for the same reach.' },
  { slug: 'entity-view-distance', group: 'FPS', why: 'Per-entity view distance: distant mobs stop costing frames.' },
  { slug: 'fastchest-revived', group: 'FPS', why: 'Draws chests as normal blocks instead of block entities.' },
  { slug: 'ebe-reloaded',     group: 'FPS',   why: 'Batches block entities (chests, signs, beds) into fewer draw calls.' },
  // Deliberately NOT included, despite being popular and client-side:
  //   pearl-optimizer — rewrites pearl motion client-side ("like zero ping"),
  //     which is exactly the kind of movement the server validates. Anti-cheat
  //     plugins flag it, so it is not worth a ban for a marginal smoothing win.
  //   NoRender / Freecam / Xray-likes — rendering built to hide things from the
  //     player is an advantage in PvP; the boost set stays assistive only.
  { slug: 'fps-reducer',      group: 'FPS',   why: 'Drops GPU/CPU use while you are idle or tabbed out (FPS Reducer).' },
  { slug: 'sodiumfpscapfix',  group: 'FPS',   why: 'Removes the 260 FPS ceiling and adds a real FPS cap box.' },
  { slug: 'moonrise-opt',     group: 'Chunks', why: 'Faster integrated-server worldgen: bigger win the further you explore.' },
  { slug: 'jasione',          group: 'Memory', why: 'Cuts GC pressure by removing throwaway enum array copies.' },
  { slug: 'consumableoptimizer', group: 'CPU', why: 'Handles eating/drinking client-side instead of waiting on the server.' },

  // --- the three OneClient ships that we were still missing --------------
  // Verified: 1.21.11 + 26.3 fabric builds exist, client-side required/optional,
  // server-side not required (so a vanilla server is fine with them).
  { slug: 'immediatelyfast', group: 'FPS', why: 'Rewrites immediate-mode rendering: fastest wins on text, items and HUD-heavy screens.' },
  { slug: 'asynclogger',     group: 'CPU', why: 'Logging moves off the main thread, so log writes stop hitching frames.' },

  // --- dependencies the above pull in ------------------------------------
  { slug: 'fabric-api',    group: 'Required', why: 'The Fabric API most mods are built against.', required: true },
];

/** Loader and game version a resolution should target. */
const DEFAULT_LOADER = 'fabric';

module.exports = { PERF_MODS, DEFAULT_LOADER };
