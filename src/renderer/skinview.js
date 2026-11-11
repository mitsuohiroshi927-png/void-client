'use strict';
/* VOID Client — hero skin stage.
 *
 * Renders the active account's Minecraft skin as a walking 3D-style model on
 * the hero panel — no three.js, no WebGL. Orthographic projection: every face
 * of the classic 64x64 box model maps to an exact parallelogram on screen, so
 * each face is ONE affine drawImage. Six parts (head/body/2 arms/2 legs) x
 * 4 faces ≈ 24 draws per frame, all from a cached texture — zero allocation
 * in the hot path, well inside the launcher's perf contract.
 *
 * Monochrome rule: the skin is the only colour; particles are white/gray,
 * the pedestal a single glass hairline.
 */

const SkinStage = (() => {
  const D2R = Math.PI / 180;

  /* Model space: y runs DOWN from the top of the head (0..32), x right,
   * z toward the camera. Units = skin texels. Feet rest at y=32. */
  const PARTS = {
    head: { x0: -4, x1: 4, y0: 0, y1: 8, hz: 4, pivot: 8, xOff: 0 },
    body: { x0: -4, x1: 4, y0: 8, y1: 20, hz: 2, pivot: 20, xOff: 0 },
    armR: { x0: -2, x1: 2, y0: 8, y1: 20, hz: 2, pivot: 8, xOff: 6 },
    armL: { x0: -2, x1: 2, y0: 8, y1: 20, hz: 2, pivot: 8, xOff: -6 },
    legR: { x0: -2, x1: 2, y0: 20, y1: 32, hz: 2, pivot: 20, xOff: -2 },
    legL: { x0: -2, x1: 2, y0: 20, y1: 32, hz: 2, pivot: 20, xOff: 2 },
  };

  /* Skin-sheet rects (64x64 classic layout): [sx, sy, w, h]. */
  const UV = {
    head: { front: [8, 8, 8, 8], top: [8, 0, 8, 8], right: [0, 8, 8, 8], left: [16, 8, 8, 8] },
    body: { front: [20, 20, 8, 12], top: [20, 16, 8, 4], right: [16, 20, 4, 12], left: [28, 20, 4, 12] },
    armR: { front: [44, 20, 4, 12], top: [44, 16, 4, 4], right: [40, 20, 4, 12], left: [48, 20, 4, 12] },
    armL: { front: [36, 52, 4, 12], top: [52, 52, 4, 4], right: [40, 52, 4, 12], left: [32, 52, 4, 12] },
    legR: { front: [4, 20, 4, 12], top: [4, 16, 4, 4], right: [0, 20, 4, 12], left: [8, 20, 4, 12] },
    legL: { front: [20, 52, 4, 12], top: [20, 48, 4, 4], right: [16, 52, 4, 12], left: [24, 52, 4, 12] },
  };

  /* Second-layer (hat/jacket/sleeve/pants) rects, classic 64x64 v1. */
  const UV_OVER = {
    head: { front: [40, 8, 8, 8], top: [40, 0, 8, 8], right: [32, 8, 8, 8], left: [48, 8, 8, 8] },
    body: { front: [20, 36, 8, 12], top: [20, 32, 8, 4], right: [16, 36, 4, 12], left: [28, 36, 4, 12] },
    armR: { front: [44, 36, 4, 12], top: [44, 32, 4, 4], right: [40, 36, 4, 12], left: [48, 36, 4, 12] },
    armL: { front: [52, 52, 4, 12], top: [60, 52, 4, 4], right: [56, 52, 4, 12], left: [48, 64, 4, 12] },
    legR: { front: [4, 36, 4, 12], top: [4, 32, 4, 4], right: [0, 36, 4, 12], left: [8, 36, 4, 12] },
    legL: { front: [4, 52, 4, 12], top: [4, 48, 4, 4], right: [0, 52, 4, 12], left: [8, 52, 4, 12] },
  };

  /* Walk cycle poses. Angles in radians; run exaggerates everything. */
  function pose(t, mode) {
    if (mode === 'run') {
      const s = Math.sin(t * 9.5), c = Math.cos(t * 9.5);
      return {
        armR: s * 1.0, armL: -s * 1.0,
        legR: -s * 0.9, legL: s * 0.9,
        bob: Math.abs(c) * 1.2, yawOff: s * 0.03,
      };
    }
    if (mode === 'walk') {
      const s = Math.sin(t * 5.0), c = Math.cos(t * 5.0);
      return {
        armR: s * 0.55, armL: -s * 0.55,
        legR: -s * 0.5, legL: s * 0.5,
        bob: Math.abs(c) * 0.5, yawOff: s * 0.02,
      };
    }
    const b = Math.sin(t * 1.5);
    return { armR: b * 0.06, armL: -b * 0.06, legR: 0, legL: 0, bob: b * 0.3, yawOff: 0 };
  }

  function create(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const S = {
      canvas, ctx,
      tex: null,
      yaw: (opts.yaw ?? -26) * D2R,
      pitch: (opts.pitch ?? 10) * D2R,
      scale: opts.scale || 5.2,
      mode: 'idle',
      t: 0, raf: 0, last: 0,
      particles: null,
      running: false,
      visible: true,
      dpr: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
      w: 0, h: 0,
    };

    function fit() {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(120, Math.round(r.width));
      const h = Math.max(160, Math.round(r.height));
      if (canvas.width !== w * S.dpr || canvas.height !== h * S.dpr) {
        canvas.width = w * S.dpr;
        canvas.height = h * S.dpr;
        const need = Math.round(w * h / 9000);
        if (!S.particles || S.particles.length !== need) {
          const out = [];
          for (let i = 0; i < need; i++) {
            out.push({
              x: Math.random() * w, y: Math.random() * h,
              v: 8 + Math.random() * 26,
              drift: -6 + Math.random() * 12,
              r: 0.6 + Math.random() * 1.6,
              a: 0.10 + Math.random() * 0.22,
              ph: Math.random() * Math.PI * 2,
            });
          }
          S.particles = out;
        }
      }
      S.w = w; S.h = h;
    }

    /* Rotate a point around the part's pivot (X axis at z=0), then project
     * orthographically: yaw around Y, then pitch around X. Camera at +z∞,
     * so larger resulting z = nearer. */
    function rotY(p, yaw) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      return { x: p.x * cy + p.z * sy, y: p.y, z: -p.x * sy + p.z * cy };
    }
    function rotX(p, pitch) {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      return { x: p.x, y: p.y * cp - p.z * sp, z: p.y * sp + p.z * cp };
    }

    /* Corners of one face, in model space, limb swing applied.
     * Returns [TL, TR, BR, BL] matching the UV rect corners. */
    function faceCorners(part, face, uv) {
      const P = PARTS[part];
      const swing = face === 'top' ? 0 : (S.swings[part] || 0);
      const c = Math.cos(swing), s = Math.sin(swing);
      const R = (x, y, z) => {
        const dy = y - P.pivot;
        return { x: x + P.xOff, y: P.pivot + dy * c - z * s, z: dy * s + z * c };
      };
      const { x0, x1, y0, y1, hz } = P;
      const zF = hz, zB = -hz;
      if (face === 'front') {
        return [R(x0, y0, zF), R(x1, y0, zF), R(x1, y1, zF), R(x0, y1, zF)];
      }
      if (face === 'right') {
        return [R(x1, y0, zB), R(x1, y0, zF), R(x1, y1, zF), R(x1, y1, zB)];
      }
      if (face === 'left') {
        return [R(x0, y0, zF), R(x0, y0, zB), R(x0, y1, zB), R(x0, y1, zF)];
      }
      if (face === 'top') {
        return [R(x0, y0, zF), R(x1, y0, zF), R(x1, y0, zB), R(x0, y0, zB)];
      }
      return null;
      void uv;
    }

    /* One textured parallelogram: map the full uv rect onto the quad.
     * Orthographic projection keeps quads parallelograms, so a single affine
     * transform is exact — TL stays TL, u axis = TR-TL, v axis = BL-TL. */
    function drawFace(quad, rect, shade) {
      const { ctx } = S;
      const TL = quad[0], TR = quad[1], BL = quad[3];
      const [sx, sy, w, h] = rect;
      const ux = (TR.x - TL.x) / w, uy = (TR.y - TL.y) / w;
      const vx = (BL.x - TL.x) / h, vy = (BL.y - TL.y) / h;
      const v = shade === 0 ? S.texV.orig : shade <= 0.1 ? S.texV.dim : S.texV.dark;
      ctx.save();
      ctx.transform(ux, uy, vx, vy, TL.x, TL.y);
      ctx.drawImage(v, sx, sy, w, h, 0, 0, w, h);
      ctx.restore();
    }

    function drawModel() {
      const { ctx } = S;
      const yaw = S.yaw + S.yawOff;
      const pitch = S.pitch;
      const feetY = S.h * 0.86 - S.bob * S.scale;
      const ox = S.w * 0.5;
      const oy = feetY - 32 * S.scale; // model y=0 (top of head) on screen
      const toScreen = (p) => {
        const a = rotY(p, yaw);
        const b = rotX(a, pitch);
        return { x: ox + b.x * S.scale, y: oy + b.y * S.scale, z: b.z };
      };
      const faces = [];
      for (const part of Object.keys(PARTS)) {
        for (const face of ['front', 'right', 'left', 'top']) {
          const uv = UV[part][face];
          const corners = faceCorners(part, face, uv);
          const quad = corners.map(toScreen);
          const depth = (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4;
          const shade = face === 'front' ? 0.05 : face === 'top' ? 0 : 0.32;
          faces.push({ quad, rect: uv, depth, shade, base: true });
          const ov = UV_OVER[part][face];
          if (ov) {
            const oc = faceCorners(part, face, ov);
            const oq = oc.map(toScreen);
            const od = (oq[0].z + oq[1].z + oq[2].z + oq[3].z) / 4;
            faces.push({ quad: oq, rect: ov, depth: od + 0.001, shade: 0, base: false });
          }
        }
      }
      // painter's algorithm: far (small z) first, near last
      faces.sort((a, b) => a.depth - b.depth);
      ctx.imageSmoothingEnabled = false;
      for (const f of faces) drawFace(f.quad, f.rect, f.shade);
    }

    function drawParticles(dt) {
      const { ctx } = S;
      ctx.save();
      for (const p of S.particles) {
        p.y += p.v * dt;
        p.x += p.drift * dt + Math.sin(S.t * 0.7 + p.ph) * 0.12;
        if (p.y > S.h + 4) { p.y = -4; p.x = Math.random() * S.w; }
        if (p.x < -4) p.x = S.w + 4;
        if (p.x > S.w + 4) p.x = -4;
        ctx.globalAlpha = p.a;
        ctx.fillStyle = '#dfe7f2';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawPedestal() {
      const { ctx } = S;
      const w = S.w, y = S.h * 0.86;
      ctx.save();
      const g = ctx.createLinearGradient(w * 0.18, y, w * 0.82, y);
      g.addColorStop(0, 'rgba(120,180,255,0)');
      g.addColorStop(0.5, 'rgba(120,180,255,0.4)');
      g.addColorStop(1, 'rgba(120,180,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w * 0.18, y + 0.5);
      ctx.lineTo(w * 0.82, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(47,125,255,0.06)';
      ctx.beginPath();
      ctx.ellipse(w / 2, y + 6, 36, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function frame(ts) {
      if (!S.running) return;
      const dt = S.last ? Math.min(0.05, (ts - S.last) / 1000) : 0.016;
      S.last = ts;
      S.t += dt;
      if (document.hidden) { S.stop(); return; }
      if (S.visible) {
        fit();
        const P = pose(S.t, S.mode);
        S.swings = { head: 0, body: 0, armR: P.armR, armL: P.armL, legR: P.legR, legL: P.legL };
        S.bob = P.bob;
        S.yawOff = P.yawOff;
        const { ctx } = S;
        ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
        ctx.clearRect(0, 0, S.w, S.h);
        drawParticles(dt);
        drawPedestal();
        if (S.tex) drawModel();
      }
      S.raf = requestAnimationFrame(frame);
    }

    /* Pre-shaded texture variants, built once per skin: source-atop on the
     * live canvas would darken every previously drawn pixel under the fill
     * rect, so shading happens on isolated copies instead. */
    function makeShaded(src, shade) {
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      const cx = c.getContext('2d');
      cx.drawImage(src, 0, 0);
      if (shade > 0) {
        cx.globalCompositeOperation = 'source-atop';
        cx.fillStyle = `rgba(4,8,14,${shade})`;
        cx.fillRect(0, 0, c.width, c.height);
      }
      return c;
    }
    return {
      setSkin(bitmap) {
        S.tex = bitmap;
        S.texV = {
          orig: makeShaded(bitmap, 0),
          dim: makeShaded(bitmap, 0.05),
          dark: makeShaded(bitmap, 0.32),
        };
      },
      setMode(m) { if (['idle', 'walk', 'run'].includes(m)) S.mode = m; },
      get mode() { return S.mode; },
      setVisible(v) {
        S.visible = !!v;
        if (S.visible) this.start(); else this.stop();
      },
      start() {
        if (S.running || !S.visible || document.hidden) return;
        S.running = true;
        S.last = 0;
        S.raf = requestAnimationFrame(frame);
      },
      stop() {
        S.running = false;
        if (S.raf) cancelAnimationFrame(S.raf);
      },
      resize() { fit(); },
    };
  }

  return { create };
})();

/* ---------- boot & data ---------- */
let skinStage = null;

async function bootSkinStage() {
  const canvas = document.getElementById('skinStage');
  if (!canvas || !api.accountSkin) return;
  skinStage = SkinStage.create(canvas, { scale: 5.4 });
  skinStage.start();
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => {
      if (skinStage) skinStage.setVisible(!!(es[0] && es[0].isIntersecting));
    }, { threshold: 0.05 });
    io.observe(canvas);
  }
  // Hover = run (the Larp-style moment); click cycles idle → walk → run.
  canvas.addEventListener('pointerenter', () => { if (skinStage && skinStage.mode === 'idle') skinStage.setMode('run'); });
  canvas.addEventListener('pointerleave', () => { if (skinStage) skinStage.setMode('idle'); });
  canvas.addEventListener('click', () => {
    if (!skinStage) return;
    const order = ['idle', 'walk', 'run'];
    const next = order[(order.indexOf(skinStage.mode) + 1) % order.length];
    skinStage.setMode(next);
  });
  document.addEventListener('visibilitychange', () => {
    if (!skinStage) return;
    if (document.hidden) skinStage.stop(); else skinStage.start();
  });
  await refreshSkinStage();
}

async function refreshSkinStage() {
  if (!skinStage || !api.accountSkin) return;
  try {
    const r = await api.accountSkin();
    if (r && r.ok && r.texture) {
      const blob = await (await fetch(r.texture)).blob();
      const bmp = await createImageBitmap(blob);
      skinStage.setSkin(bmp);
    }
  } catch { /* no skin available — the stage still breathes */ }
}
