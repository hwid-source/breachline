// Shared movement/collision (server + client). Blocks: {x,z,w,d,h,y,mat}
(function (root, f) { const m = f(); if (typeof module === 'object' && module.exports) module.exports = m; else root.PHYS = m; })(typeof self !== 'undefined' ? self : globalThis, function () {
  const R = 0.42, STEP = 0.55, HS = 1.75, HC = 1.25;
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  function hit(b, x, z, r) { const dx = x - cl(x, b.x - b.w / 2, b.x + b.w / 2), dz = z - cl(z, b.z - b.d / 2, b.z + b.d / 2); return dx * dx + dz * dz < r * r; }
  function blocked(bl, x, z, y, h) { for (const b of bl) { if (b.y + b.h <= y + STEP || b.y >= y + h) continue; if (hit(b, x, z, R)) return true; } return false; }
  function floorAt(bl, x, z, y) { let f = 0; for (const b of bl) { const t = b.y + b.h; if (t <= y + STEP && t > f && hit(b, x, z, R * 0.7)) f = t; } return f; }
  return { R, STEP, HS, HC, cl, hit, blocked, floorAt };
});
