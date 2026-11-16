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
    { id: 'wood', name: 'Drewno', color: '#b9824a', dens: 0.05, ea: 9e6, str: 70000, lc: 34, cost: 1.0, maxLen: 60, w: 5 },
    { id: 'steel', name: 'Stal', color: '#9aa7b5', dens: 0.11, ea: 4.5e7, str: 420000, lc: 60, cost: 2.4, maxLen: 80, w: 4 },
    { id: 'bamboo', name: 'Bambus', color: '#9bc255', dens: 0.025, ea: 4.5e6, str: 42000, lc: 30, cost: 0.6, maxLen: 50, w: 4 },
    { id: 'alu', name: 'Aluminium', color: '#d7e3ee', dens: 0.04, ea: 2.1e7, str: 114000, lc: 44, cost: 1.9, maxLen: 70, w: 4 },
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

  // Rozkład Cholesky'ego macierzy pasmowej (symetrycznej, dodatnio określonej).
  // A[i*(b+1)+k] = a(i, i-k), k = 0..b. Wynik nadpisuje A.
  function bandCholesky(A, n, b) {
    const s1 = b + 1;
    for (let i = 0; i < n; i++) {
      const j0 = Math.max(0, i - b);
      for (let j = j0; j <= i; j++) {
        let s = A[i * s1 + (i - j)];
        const k0 = Math.max(j0, j - b);
        for (let k = k0; k < j; k++) s -= A[i * s1 + (i - k)] * A[j * s1 + (j - k)];
        if (i === j) A[i * s1] = Math.sqrt(Math.max(s, 1e-9));
        else A[i * s1 + (i - j)] = s / A[j * s1];
      }
    }
  }

  function bandSolve(A, n, b, x) {
    const s1 = b + 1;
    for (let i = 0; i < n; i++) {
      let s = x[i];
      for (let k = Math.max(0, i - b); k < i; k++) s -= A[i * s1 + (i - k)] * x[k];
      x[i] = s / A[i * s1];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let k = i + 1; k <= Math.min(n - 1, i + b); k++) s -= A[k * s1 + (k - i)] * x[k];
      x[i] = s / A[i * s1];
    }
  }

  // Symulacja kratownicy: niejawny schemat Eulera + metoda Newtona.
  // W odróżnieniu od prostego PBD rozwiązanie jest zbieżne, więc sztywność
  // konstrukcji zależy od jej geometrii: trójkąty są sztywne, a sam łańcuch
  // belek zachowuje się jak lina i mocno się ugina.
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
          k: mat.ea / rest,
          capT: cap,
          capC: cap / Math.max(1, (rest / mat.lc) ** 2),
          force: 0, ratio: 0, broken: false,
        };
      });
      for (const b of this.beams) {
        const bm = b.rest * mat.dens;
        this.nodes[b.a].m += bm / 2;
        this.nodes[b.b].m += bm / 2;
      }
      this.debris = [];
      this.maxRatio = 0;
      this.noBreak = false;
      this.span = terrain.filter((h) => !isFinite(h)).length * CELL;
      this.sagLimit = 2 + 0.01 * this.span;
      this.maxSag = 0;
      this.sagFailed = false;
      this.origY = this.nodes.map((n) => n.y);
      this.buildDofs();
    }

    // Numeracja stopni swobody: wolne węzły posortowane wg x (wąskie pasmo macierzy)
    buildDofs() {
      const free = [];
      this.nodes.forEach((n, i) => { if (!n.fixed) free.push(i); });
      free.sort((i, j) => this.nodes[i].x - this.nodes[j].x || this.nodes[i].y - this.nodes[j].y);
      this.dof = new Int32Array(this.nodes.length).fill(-1);
      free.forEach((ni, k) => { this.dof[ni] = k; });
      this.nFree = free.length;
      let bw = 1;
      for (const b of this.beams) {
        if (b.broken) continue;
        const da = this.dof[b.a];
        const db = this.dof[b.b];
        if (da >= 0 && db >= 0) bw = Math.max(bw, Math.abs(da - db) * 2 + 1);
      }
      this.bw = bw;
      const n = this.nFree * 2;
      this.H = new Float64Array(Math.max(1, n * (bw + 1)));
      this.g = new Float64Array(Math.max(1, n));
    }

    // Ustabilizowanie od ciężaru własnego, bez łamania belek
    settle() {
      this.noBreak = true;
      for (let i = 0; i < 90; i++) this.step(1 / 60, []);
      for (const n of this.nodes) { n.vx = 0; n.vy = 0; }
      this.noBreak = false;
      for (const b of this.beams) b.ratio = 0;
      // Ugięcie liczymy względem projektu, więc obejmuje też ciężar własny:
      // sam łańcuch belek „wisi” jak lina i to też jest wada mostu.
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

    addBlock(i, j, kxx, kxy, kyy) {
      // dodaje blok 2x2 dla pary stopni swobody (i, j) w dolnym trójkącie
      const H = this.H;
      const s1 = this.bw + 1;
      const r0 = 2 * i;
      const c0 = 2 * j;
      const put = (r, c, v) => {
        if (c > r) { const t = r; r = c; c = t; }
        H[r * s1 + (r - c)] += v;
      };
      if (i === j) {
        put(r0, r0, kxx); put(r0 + 1, r0, kxy); put(r0 + 1, r0 + 1, kyy);
      } else {
        put(r0, c0, kxx); put(r0, c0 + 1, kxy); put(r0 + 1, c0, kxy); put(r0 + 1, c0 + 1, kyy);
      }
    }

    implicitStep(h) {
      const nodes = this.nodes;
      const nF = this.nFree;
      const n = nF * 2;
      for (const nd of nodes) {
        nd.ox = nd.x; nd.oy = nd.y;
        if (nd.fixed) continue;
        // przewidywana pozycja (ruch bez sił wewnętrznych)
        nd.px = nd.x + h * nd.vx;
        nd.py = nd.y + h * nd.vy;
        nd.x = nd.px; nd.y = nd.py;
      }
      if (n > 0) {
        const ih2 = 1 / (h * h);
        for (let it = 0; it < 4; it++) {
          this.H.fill(0);
          this.g.fill(0);
          const g = this.g;
          for (let ni = 0; ni < nodes.length; ni++) {
            const nd = nodes[ni];
            const d = this.dof[ni];
            if (d < 0) continue;
            const mi = nd.m * ih2;
            g[2 * d] += mi * (nd.x - nd.px) - nd.fx;
            g[2 * d + 1] += mi * (nd.y - nd.py) - nd.m * G - nd.fy;
            this.addBlock(d, d, mi, 0, mi);
          }
          for (const b of this.beams) {
            if (b.broken) continue;
            const p = nodes[b.a];
            const q = nodes[b.b];
            const dx = p.x - q.x;
            const dy = p.y - q.y;
            const len = Math.hypot(dx, dy) || 1e-6;
            const ux = dx / len;
            const uy = dy / len;
            const f = b.k * (len - b.rest); // >0 rozciąganie
            const gt = Math.max(0, f / len); // sztywność geometryczna (tylko przy rozciąganiu)
            const kxx = b.k * ux * ux + gt * (1 - ux * ux);
            const kxy = b.k * ux * uy - gt * ux * uy;
            const kyy = b.k * uy * uy + gt * (1 - uy * uy);
            const da = this.dof[b.a];
            const db = this.dof[b.b];
            if (da >= 0) {
              g[2 * da] += f * ux; g[2 * da + 1] += f * uy;
              this.addBlock(da, da, kxx, kxy, kyy);
            }
            if (db >= 0) {
              g[2 * db] -= f * ux; g[2 * db + 1] -= f * uy;
              this.addBlock(db, db, kxx, kxy, kyy);
            }
            if (da >= 0 && db >= 0) this.addBlock(Math.max(da, db), Math.min(da, db), -kxx, -kxy, -kyy);
          }
          let gn = 0;
          for (let i = 0; i < n; i++) { g[i] = -g[i]; gn = Math.max(gn, Math.abs(g[i])); }
          if (gn < 1e-3) break;
          bandCholesky(this.H, n, this.bw);
          bandSolve(this.H, n, this.bw, g);
          let mx = 0;
          for (let ni = 0; ni < nodes.length; ni++) {
            const d = this.dof[ni];
            if (d < 0) continue;
            mx = Math.max(mx, Math.abs(g[2 * d]), Math.abs(g[2 * d + 1]));
          }
          const sc = mx > 8 ? 8 / mx : 1; // ograniczenie kroku Newtona
          for (let ni = 0; ni < nodes.length; ni++) {
            const d = this.dof[ni];
            if (d < 0) continue;
            nodes[ni].x += g[2 * d] * sc;
            nodes[ni].y += g[2 * d + 1] * sc;
          }
          if (mx * sc < 1e-3) break;
        }
      }
      const damp = Math.exp(-2.5 * h);
      for (const nd of nodes) {
        if (nd.fixed) continue;
        nd.vx = ((nd.x - nd.ox) / h) * damp;
        nd.vy = ((nd.y - nd.oy) / h) * damp;
        if (nd.y > WATER_Y + 200) { nd.y = WATER_Y + 200; nd.vy = 0; }
      }
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
      const SUB = 2;
      const h = dt / SUB;
      let broke = false;
      for (let s = 0; s < SUB; s++) {
        this.implicitStep(h);
        for (const b of this.beams) {
          if (b.broken) continue;
          const p = nodes[b.a];
          const q = nodes[b.b];
          const f = b.k * (Math.hypot(p.x - q.x, p.y - q.y) - b.rest);
          b.force = f;
          const r = f < 0 ? -f / b.capC : f / b.capT;
          b.ratio += (Math.min(r, 3) - b.ratio) * 0.5;
          if (b.ratio > 1 && !this.noBreak) {
            b.broken = true;
            broke = true;
            this.debris.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, t: 0 });
          }
        }
        if (broke) this.buildDofs();
      }
      let maxR = 0;
      for (const b of this.beams) if (!b.broken && b.ratio > maxR) maxR = b.ratio;
      this.maxRatio = maxR;
      let worst = -1;
      let worstD = 0;
      this.nodes.forEach((n, i) => {
        if (n.fixed) return;
        const d = n.y - this.origY[i];
        if (d > worstD) { worstD = d; worst = i; }
      });
      this.maxSag = Math.max(this.maxSag, worstD);
      // Zbyt duże ugięcie: przegub w najbardziej ugiętym węźle puszcza
      // i pomost się zapada (zamiast tylko „liczbowo” oblać test).
      // (sprawdzamy tylko, gdy pojazd stoi na moście — wtedy widać, jak pomost się pod nim zapada)
      const loaded = loads.some((l) => { const su = this.surfaceAt(l.x); return su && su.beam; });
      if (loaded && !this.noBreak && !this.sagFailed && worst >= 0 && this.maxSag > this.sagLimit) {
        this.sagFailed = true;
        this.sagAtFail = this.maxSag;
        let pick = null;
        for (const b of this.beams) {
          if (b.broken || (b.a !== worst && b.b !== worst)) continue;
          if (!pick || b.ratio > pick.ratio) pick = b;
        }
        if (pick) {
          pick.broken = true;
          const p = nodes[pick.a];
          const q = nodes[pick.b];
          this.debris.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, t: 0 });
          this.buildDofs();
        }
      }
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
      // most uszkodzony (pęknięta belka albo za duże ugięcie) — test oblany,
      // ale gra pokazuje jeszcze chwilę, jak konstrukcja się wali
      this.damaged = this.sim.sagFailed || this.sim.beams.some((b) => b.broken);
      if (this.x - d.len / 2 > W) this.done = true;
      return loads;
    }
  }

  const api = { CELL, COLS, ROWS, W, H, WATER_Y, G, MATERIALS, VEHICLES, pointState, segmentInsideTerrain, beamCost, Sim, Vehicle };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Physics = api;
})(this);
