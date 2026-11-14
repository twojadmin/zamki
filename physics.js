// Silnik fizyki mostu: XPBD (sprężyste belki), obciążenia pojazdów, teren z kolumn.
(function (root) {
  const CELL = 20;
  const COLS = 50;
  const ROWS = 30;
  const W = COLS * CELL;
  const H = ROWS * CELL;
  const WATER_Y = 540;
  const G = 600;

  // dens: masa na px, ea: sztywność (E*A), str: wytrzymałość na rozciąganie,
  // lc: długość, powyżej której belka wyboczy się przy ściskaniu, cost: koszt za px
  const MATERIALS = [
    { id: 'wood', name: 'Drewno', color: '#b9824a', dens: 0.05, ea: 3e5, str: 40000, lc: 34, cost: 1.0, maxLen: 60, w: 5 },
    { id: 'steel', name: 'Stal', color: '#9aa7b5', dens: 0.11, ea: 1.5e6, str: 240000, lc: 60, cost: 2.4, maxLen: 80, w: 4 },
    { id: 'bamboo', name: 'Bambus', color: '#9bc255', dens: 0.025, ea: 1.5e5, str: 24000, lc: 30, cost: 0.6, maxLen: 50, w: 4 },
    { id: 'alu', name: 'Aluminium', color: '#d7e3ee', dens: 0.04, ea: 7e5, str: 65000, lc: 44, cost: 1.9, maxLen: 70, w: 4 },
  ];

  const VEHICLES = [
    {
      id: 'car', name: 'Samochód', speed: 130, len: 56,
      axles: [{ dx: -16, w: 6 }, { dx: 16, w: 6 }],
    },
    {
      id: 'truck', name: 'Ciężarówka', speed: 95, len: 100,
      axles: [{ dx: -38, w: 5 }, { dx: -4, w: 6.5 }, { dx: 30, w: 6.5 }],
    },
    {
      id: 'tank', name: 'Czołg', speed: 65, len: 110,
      axles: [-44, -22, 0, 22, 44].map((dx) => ({ dx, w: 8 })),
    },
  ];

  // Teren: tablica wysokości (wiersz góry kolumny); Infinity = przepaść.
  function pointState(terrain, x, y) {
    // 'free' | 'anchor' | 'blocked' dla punktu siatki
    const c = Math.round(x / CELL);
    const row = Math.round(y / CELL);
    if (c < 0 || c > COLS || row < 0 || row > 26) return 'blocked';
    const hl = c - 1 >= 0 ? terrain[c - 1] : terrain[0];
    const hr = c < COLS ? terrain[c] : terrain[COLS - 1];
    const lo = Math.min(hl, hr);
    const hi = Math.max(hl, hr);
    if (row < lo) return 'free';
    if (row <= hi) return 'anchor';
    return 'blocked';
  }

  function segmentInsideTerrain(terrain, x1, y1, x2, y2) {
    const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 4);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      const c = Math.floor(x / CELL);
      if (c < 0 || c >= COLS) return true;
      if (y > terrain[c] * CELL + 0.01) return true;
    }
    return false;
  }

  function beamCost(mat, len) {
    return Math.round(len * mat.cost);
  }

  class Sim {
    constructor(terrain, mat, design) {
      this.terrain = terrain;
      this.mat = mat;
      this.nodes = design.nodes.map((n) => ({
        x: n.x, y: n.y, vx: 0, vy: 0, fixed: n.fixed, m: 1, fx: 0, fy: 0,
      }));
      this.beams = design.beams.map((b) => {
        const a = this.nodes[b.a];
        const c = this.nodes[b.b];
        const rest = Math.hypot(a.x - c.x, a.y - c.y);
        const cap = mat.str;
        return {
          a: b.a, b: b.b, rest,
          alpha: 1 / (mat.ea / rest),
          capT: cap,
          capC: cap / Math.max(1, (rest / mat.lc) ** 2),
          force: 0, ratio: 0, broken: false, lambda: 0,
        };
      });
      for (const n of this.nodes) n.m = 1;
      for (const b of this.beams) {
        const bm = b.rest * mat.dens;
        this.nodes[b.a].m += bm / 2;
        this.nodes[b.b].m += bm / 2;
      }
      this.debris = [];
      this.maxRatio = 0;
      this.noBreak = false;
      this.span = terrain.filter((h) => !isFinite(h)).length * CELL;
      this.sagLimit = 1 + 0.005 * this.span;
      this.maxSag = 0;
      this.origY = this.nodes.map((n) => n.y);
    }

    // Ustabilizowanie od ciężaru własnego, bez łamania belek
    settle() {
      this.noBreak = true;
      for (let i = 0; i < 120; i++) this.step(1 / 60, []);
      this.noBreak = false;
      for (const b of this.beams) b.ratio = 0;
      this.origY = this.nodes.map((n) => n.y);
      this.maxSag = 0;
    }

    surfaceAt(x) {
      let best = null;
      const c = Math.floor(x / CELL);
      if (c >= 0 && c < COLS && isFinite(this.terrain[c])) {
        best = { y: this.terrain[c] * CELL, beam: null };
      }
      for (const b of this.beams) {
        if (b.broken) continue;
        const p = this.nodes[b.a];
        const q = this.nodes[b.b];
        const x1 = Math.min(p.x, q.x);
        const x2 = Math.max(p.x, q.x);
        if (x < x1 || x > x2 || x2 - x1 < 1) continue;
        if (Math.abs(q.y - p.y) / (x2 - x1) > 0.75) continue;
        const t = (x - p.x) / (q.x - p.x);
        const y = p.y + (q.y - p.y) * t;
        if (!best || y < best.y - 0.5) best = { y, beam: b, t };
      }
      return best;
    }

    // Jeden krok klatki; loads: [{x, w}] obciążenia punktowe
    step(dt, loads) {
      const nodes = this.nodes;
      for (const n of nodes) { n.fx = 0; n.fy = 0; }
      for (const l of loads) {
        const s = this.surfaceAt(l.x);
        if (!s || !s.beam) continue;
        const b = s.beam;
        const p = nodes[b.a];
        const q = nodes[b.b];
        const t = Math.max(0, Math.min(1, s.t));
        p.fy += l.w * G * (1 - t);
        q.fy += l.w * G * t;
      }
      const SUB = 10;
      const IT = 3;
      const h = dt / SUB;
      const damp = Math.exp(-1.2 * h);
      for (let s = 0; s < SUB; s++) {
        for (const n of nodes) {
          n.ox = n.x; n.oy = n.y;
          if (n.fixed) continue;
          n.vy += (G + n.fy / n.m) * h;
          n.vx += (n.fx / n.m) * h;
          n.x += n.vx * h;
          n.y += n.vy * h;
        }
        for (const b of this.beams) b.lambda = 0;
        for (let it = 0; it < IT; it++) {
          for (const b of this.beams) {
            if (b.broken) continue;
            const p = nodes[b.a];
            const q = nodes[b.b];
            const dx = p.x - q.x;
            const dy = p.y - q.y;
            const len = Math.hypot(dx, dy) || 1e-6;
            const w1 = p.fixed ? 0 : 1 / p.m;
            const w2 = q.fixed ? 0 : 1 / q.m;
            const at = b.alpha / (h * h);
            const C = len - b.rest;
            const dl = (-C - at * b.lambda) / (w1 + w2 + at);
            b.lambda += dl;
            const nx = dx / len;
            const ny = dy / len;
            p.x += w1 * dl * nx; p.y += w1 * dl * ny;
            q.x -= w2 * dl * nx; q.y -= w2 * dl * ny;
          }
        }
        for (const n of nodes) {
          if (n.fixed) continue;
          n.vx = ((n.x - n.ox) / h) * damp;
          n.vy = ((n.y - n.oy) / h) * damp;
          if (n.y > WATER_Y + 200) { n.y = WATER_Y + 200; n.vy = 0; }
        }
      }
      let maxR = 0;
      for (const b of this.beams) {
        if (b.broken) continue;
        // lambda > 0: ściskanie
        const f = -b.lambda / (h * h);
        b.force = f;
        const r = f < 0 ? -f / b.capC : f / b.capT;
        b.ratio += (Math.min(r, 3) - b.ratio) * 0.35;
        if (b.ratio > 1 && !this.noBreak) {
          b.broken = true;
          const p = nodes[b.a];
          const q = nodes[b.b];
          this.debris.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, t: 0 });
        }
        if (b.ratio > maxR) maxR = b.ratio;
      }
      this.maxRatio = maxR;
      this.nodes.forEach((n, i) => { if (!n.fixed) this.maxSag = Math.max(this.maxSag, n.y - this.origY[i]); });
    }
  }

  class Vehicle {
    constructor(def, sim) {
      this.def = def;
      this.sim = sim;
      this.x = -def.len / 2 - 10;
      this.y = sim.terrain[0] * CELL;
      this.angle = 0;
      this.vy = 0;
      this.falling = false;
      this.done = false;
      this.failed = false;
      this.wheel = 0;
    }

    update(dt) {
      const d = this.def;
      this.x += d.speed * dt;
      this.wheel += d.speed * dt;
      const loads = [];
      const pts = [];
      for (const a of d.axles) {
        const ax = this.x + a.dx;
        const s = this.sim.surfaceAt(ax);
        if (s) {
          pts.push({ x: ax, y: s.y });
          if (s.beam) loads.push({ x: ax, w: a.w });
        }
      }
      if (pts.length) {
        const avg = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        let ang = 0;
        if (pts.length > 1) {
          const f = pts[0];
          const l = pts[pts.length - 1];
          ang = Math.atan2(l.y - f.y, l.x - f.x);
        }
        this.falling = false;
        this.vy = 0;
        const k = Math.min(1, 14 * dt);
        this.y += (avg - this.y) * k;
        this.angle += (ang - this.angle) * k;
      } else {
        this.falling = true;
        this.vy += G * dt;
        this.y += this.vy * dt;
        this.angle += 1.2 * dt;
      }
      if (this.y > WATER_Y + 10) this.failed = true;
      if (this.sim.maxSag > this.sim.sagLimit || this.sim.beams.some((b) => b.broken)) this.failed = true;
      if (this.x - d.len / 2 > W) this.done = true;
      return loads;
    }
  }

  const api = { CELL, COLS, ROWS, W, H, WATER_Y, G, MATERIALS, VEHICLES, pointState, segmentInsideTerrain, beamCost, Sim, Vehicle };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Physics = api;
})(this);
