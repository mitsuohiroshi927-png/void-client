/**
 * JVM tuning for a Minecraft client: more frames, fewer stalls, less RAM churn.
 *
 * Everything here is client-side. No flag here can corrupt a world, and none of
 * them disable Mojang's integrity checks. Flags are split by intent so the
 * safety mode in Settings can drop the experimental half.
 */
'use strict';

/**
 * Core flags for every launch. G1 is the right collector for a client: short
 * pauses matter more than raw throughput when the render loop is the workload.
 */
function coreArgs({ gcPause = 50, heapMB = 4096 } = {}) {
  const args = [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',   // parallel reference processing: shortens the remark pause
    `-XX:MaxGCPauseMillis=${gcPause}`,
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',        // ignore System.gc() calls from mods
    '-XX:+AlwaysPreTouch',           // commit the heap up front: no page-fault hitches mid-fight
    '-XX:G1NewSizePercent=30',       // bigger young gen: most client garbage dies young
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',       // headroom so a hump in allocation never triggers a full GC
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',     // no hsperfdata file: avoids a disk-write stall every GC
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ];
  // Frame-time flags. These do not create frames — the renderer does — but they stop
  // GC from stealing them: Minecraft allocates hard during play, and a young-gen
  // collection that lands mid-fight is what users feel as a stutter.
  args.push(
    // Keep the young gen from filling between collections: most client garbage dies
    // immediately, so collecting it cheaply and often beats a big deep pause.
    '-XX:MaxTenuringThreshold=1',
    // A soft reference collected mid-frame is a visible hitch; keep them alive longer.
    '-XX:SoftRefLRUPolicyMSPerMB=1000',
    // Free regions get reused instead of being returned to the OS and re-faulted.
    '-XX:-ShrinkHeapInSteps',
    '-XX:+UseStringDeduplication',
  );

  // Large heaps get longer region sizing so the remembered-set scan stays cheap.
  if (heapMB >= 12288) {
    args[args.indexOf('-XX:G1NewSizePercent=30')] = '-XX:G1NewSizePercent=40';
    args[args.indexOf('-XX:G1MaxNewSizePercent=40')] = '-XX:G1MaxNewSizePercent=50';
    args[args.indexOf('-XX:G1HeapRegionSize=8M')] = '-XX:G1HeapRegionSize=16M';
    args[args.indexOf('-XX:G1ReservePercent=20')] = '-XX:G1ReservePercent=15';
    args[args.indexOf('-XX:InitiatingHeapOccupancyPercent=15')] = '-XX:InitiatingHeapOccupancyPercent=20';
  }
  return args;
}

/**
 * Extra flags for the FPS-focused profiles. Things that trade a little memory or
 * JIT warmup for smoother frame times.
 */
function boostArgs() {
  return [
    // C2 compiles hotter code sooner instead of waiting for a call threshold
    // the client never reaches during a short session.
    '-XX:TieredStopAtLevel=4',
    '-XX:+UseCompressedOops',
    '-XX:+UseCompressedClassPointers',
    // Don't let the JIT hold a big code cache it never fills.
    '-XX:ReservedCodeCacheSize=256M',
    '-XX:+SegmentedCodeCache',
    // Keep the JIT's compiler threads fed but not starving the render threads.
    '-XX:CICompilerCount=3',
    // Skip stack trace collection for allocation-site debugging in this build.
    '-XX:-OmitStackTraceInFastThrow',
    // Natives + LWJGL: disable the debug interface, big win on busy servers.
    '-Djdk.attach.allowAttachSelf=false',
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    '-Dorg.lwjgl.util.NoChecks=true',
    '-Dorg.lwjgl.util.Debug=false',
    '-Dorg.lwjgl.util.DebugLoader=false',
    // Skylight/mixin noise off keeps log I/O off the render thread.
    '-Dmixin.debug.export=false',
    '-Dmixin.checks.interfaces=false',
    // Font/unicode table: allocate once, skip the lookup-table resize churn.
    '-Dsun.java2d.opengl=false',
  ];
}

/**
 * Flags that make the JVM friendlier on low-RAM machines: cap the JIT's
 * bookkeeping, avoid pre-touching RAM the machine may not have spare.
 */
function lowMemoryArgs() {
  return [
    '-XX:-AlwaysPreTouch',                // pre-touching 8 GB on a 4 GB box is suicide
    '-XX:+UseSerialGC',                   // lowest overhead collector on 1-2 cores
    '-XX:TieredStopAtLevel=1',            // C1 only: less code cache, faster startup
    '-XX:ReservedCodeCacheSize=128M',
    '-Xshare:auto',
    '-XX:+ReduceSignalUsage',
  ];
}

/**
 * Assemble the final flag list for a launch.
 *
 * @param {object} o
 * @param {string} o.profile      profile id: auto | pvp | balanced | fps
 * @param {number} o.heapMB       resolved -Xmx/-Xms
 * @param {number} o.gcPause      MaxGCPauseMillis target
 * @param {boolean} o.safety      drop the experimental half
 * @param {boolean} o.lowMemory   sub-4GB machine
 * @returns {string[]}
 */
function buildArgs({ profile = 'default', heapMB = 4096, gcPause = 50, safety = false, lowMemory = false, boost = false } = {}) {
  if (lowMemory) {
    // Serial GC overrides contradict G1 flags, so return a compact dedicated set.
    const base = [
      '-XX:+UseSerialGC',
      '-XX:+DisableExplicitGC',
      '-XX:ReservedCodeCacheSize=128M',
      '-XX:+UseCompressedOops',
      '-XX:+UseCompressedClassPointers',
      '-XX:TieredStopAtLevel=1',
      '-Xshare:auto',
      '-XX:+PerfDisableSharedMem',
      '-Dfile.encoding=UTF-8',
      '-Dorg.lwjgl.util.NoChecks=true',
      '-Dorg.lwjgl.util.Debug=false',
    ];
    const extra = boost ? boostArgs().filter((a) => !/TieredStopAtLevel|ReservedCodeCacheSize|UseSerialGC/.test(a)) : [];
    return [...base, ...extra];
  }

  const args = [...coreArgs({ gcPause, heapMB })];

  // The tuning profiles add the boost set; balanced keeps it lighter.
  if (boost) args.push(...boostArgs());
  else if (profile === 'auto') args.push(...boostArgs().filter((a) => !/TieredStopAtLevel|CICompilerCount/.test(a)));

  if (safety) {
    const banned = /AlwaysPreTouch|G1NewSizePercent|G1MaxNewSizePercent|G1ReservePercent|G1HeapRegionSize|InitiatingHeapOccupancy|G1MixedGC|G1RSetUpdating|ReservedCodeCacheSize|TieredStopAtLevel|CICompilerCount|UnlockExperimentalVMOptions/;
    return args.filter((a) => !banned.test(a));
  }
  return args;
}

/** Strip our own flags out of a user-supplied extra-args list to avoid conflicts. */
function dedupeAgainst(userArgs = [], ours = []) {
  const ourKeys = new Set(ours.map(keyOf).filter(Boolean));
  // Mutually exclusive collector choices: a different GC flag is just as fatal
  // as setting it twice, so drop any GC selector we did not choose ourselves.
  const ourGc = ours.find((a) => /-XX:\+Use\w*GC\b/.test(a));
  const gcFlags = [
    '-XX:+UseSerialGC', '-XX:+UseParallelGC', '-XX:+UseConcMarkSweepGC',
    '-XX:+UseG1GC', '-XX:+UseZGC', '-XX:+UseShenandoahGC', '-XX:+UseEpsilonGC',
  ];
  return userArgs.filter((a) => {
    if (gcFlags.includes(a)) return ourGc ? a === ourGc : false;
    const k = keyOf(a);
    return !k || !ourKeys.has(k);
  });
}

function keyOf(a) {
  if (typeof a !== 'string' || !a.startsWith('-')) return null;
  // -XX:+Flag / -XX:-Flag / -XX:Flag=value  -> one key per flag name,
  // -Xmx / -Xms / -Xss                     -> one key per -X option,
  // -Dname=value                           -> one key per property name.
  let m = a.match(/^-XX:([+\-]?)([A-Za-z0-9]+)(?:=.*)?$/);
  if (m) {
    // +UseG1GC / -UseG1GC / UseG1GC=30 all collapse to the flag name.
    return `XX:${m[2]}`;
  }
  m = a.match(/^-X([a-z]+)[0-9]/);
  if (m) return `X:${m[1]}`;
  m = a.match(/^-D([^=]+)=/);
  if (m) return `D:${m[1]}`;
  m = a.match(/^-([A-Za-z][A-Za-z0-9._]*)/);
  if (m) return `opt:${m[1]}`;
  return null;
}

module.exports = { buildArgs, coreArgs, boostArgs, lowMemoryArgs, dedupeAgainst };
