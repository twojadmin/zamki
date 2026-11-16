(function () {
  const { CELL, COLS, W, H, WATER_Y, MATERIALS, VEHICLES, pointState, segmentInsideTerrain, beamCost, Sim, Vehicle } = Physics;
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');
  const $ = (id) => document.getElementById(id);

  let level = 1;
  let mat = MATERIALS[0];
  let terrain = [];
  let gapStart = 0;
  let gapEnd = 0;
  let budget = 0;
  let design = { nodes: [], beams: [] };
  let undoStack = [];
  let pending = null;
  let hover = null;
  let mode = 'build';
  let tool = 'build'; // 'build' | 'pan' | 'del'
  let sim = null;
  let vehicle = null;
  let testIdx = 0;
  let pauseT = 0;
  let testTime = 0;
  let clock = 0;
  let overlayAction = null;

  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- poziomy ----------
  // [rozpiętość w kratkach, materiał]. Budżet wynika z kosztu przykładowej
  // kratownicy, która przechodzi wszystkie testy (z zapasem 50%).
  const LEVELS = [
    [6, 'wood'], [8, 'bamboo'], [10, 'wood'], [12, 'bamboo'], [12, 'alu'], [14, 'wood'],
    [16, 'steel'], [18, 'alu'], [20, 'steel'], [22, 'alu'], [24, 'steel'], [26, 'steel'],
  ];
  const REF_COST = {
    wood: { 6: 491, 8: 684, 10: 860, 12: 1036, 14: 1864, 16: 2456, 18: 3972, 20: 7100 },
    bamboo: { 6: 306, 8: 412, 10: 518, 12: 960, 14: 1292, 16: 2124, 18: 3120 },
    alu: { 6: 929, 8: 1264, 10: 1599, 12: 1934, 14: 2269, 16: 2604, 18: 2986, 20: 5884, 22: 6480, 24: 10158, 26: 14356 },
    steel: { 6: 1176, 8: 1600, 10: 2024, 12: 2448, 14: 2872, 16: 3296, 18: 3720, 20: 4144, 22: 4616, 24: 7776, 26: 8432 },
  };

  function genLevel(n) {
    level = n;
    const [gap, matId] = LEVELS[Math.min(n, LEVELS.length) - 1];
    mat = MATERIALS.find((m) => m.id === matId);
    const left = clamp(Math.floor((COLS - gap) / 2) + rnd(-2, 2), 6, COLS - gap - 6);
    gapStart = left;
    gapEnd = left + gap;
    const spread = Math.min(n - 1, 2);
    const hL = rnd(13, 17);
    const hR = clamp(hL + rnd(-spread, spread), 10, 20);
    terrain = new Array(COLS).fill(Infinity);
    let h = hL;
    for (let c = gapStart - 1; c >= 0; c--) {
      if (c < gapStart - 1 && Math.random() < 0.3 && h > 9) h--;
      terrain[c] = h;
    }
    h = hR;
    for (let c = gapEnd; c < COLS; c++) {
      if (c > gapEnd && Math.random() < 0.3 && h > 9) h--;
      terrain[c] = h;
    }
    budget = Math.ceil((REF_COST[mat.id][gap] * 1.5) / 50) * 50;
    design = { nodes: [], beams: [] };
    undoStack = [];
    pending = null;
    mode = 'build';
    sim = null;
    vehicle = null;
    resetTestBadges();
    fitView();
    updateHud();
  }

  function spent() {
    return design.beams.reduce((s, b) => {
      const p = design.nodes[b.a];
      const q = design.nodes[b.b];
      return s + beamCost(mat, Math.hypot(p.x - q.x, p.y - q.y));
    }, 0);
  }

  function updateHud() {
    $('lvl').textContent = level;
    $('mat').textContent = mat.name;
    $('gap').textContent = (gapEnd - gapStart) * CELL + ' px';
    const left = budget - spent();
    $('budget').textContent = left + ' / ' + budget;
    $('budget').classList.toggle('low', left < budget * 0.1);
    $('test').disabled = mode !== 'build' || design.beams.length === 0;
    $('undo').disabled = mode !== 'build' || !undoStack.length;
    $('clear').disabled = mode !== 'build' || !design.beams.length;
    for (const id of ['tBuild', 'tDel']) $(id).disabled = mode !== 'build';
  }

  function resetTestBadges() {
    for (let i = 0; i < VEHICLES.length; i++) $('t' + i).className = '';
  }

  // ---------- edycja ----------
  function snapshot() {
    undoStack.push(JSON.stringify(design));
    if (undoStack.length > 100) undoStack.shift();
  }

  function findNode(x, y) {
    return design.nodes.findIndex((n) => n.x === x && n.y === y);
  }

  function getNode(x, y) {
    let i = findNode(x, y);
    if (i < 0) {
      design.nodes.push({ x, y, fixed: pointState(terrain, x, y) === 'anchor' });
      i = design.nodes.length - 1;
    }
    return i;
  }

  function pruneNodes() {
    const used = new Set();
    for (const b of design.beams) { used.add(b.a); used.add(b.b); }
    const map = {};
    const nodes = [];
    design.nodes.forEach((n, i) => { if (used.has(i)) { map[i] = nodes.length; nodes.push(n); } });
    design.beams.forEach((b) => { b.a = map[b.a]; b.b = map[b.b]; });
    design.nodes = nodes;
  }

  function beamCheck(a, b) {
    if (a.x === b.x && a.y === b.y) return 'same';
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    if (len > mat.maxLen + 0.01) return 'Za długa belka (max ' + mat.maxLen + ' px)';
    if (segmentInsideTerrain(terrain, a.x, a.y, b.x, b.y)) return 'Belka w murze';
    const ia = findNode(a.x, a.y);
    const ib = findNode(b.x, b.y);
    if (ia >= 0 && ib >= 0 && design.beams.some((q) => (q.a === ia && q.b === ib) || (q.a === ib && q.b === ia))) return 'Już istnieje';
    if (spent() + beamCost(mat, len) > budget) return 'Brak budżetu';
    return null;
  }

  // ---------- płótno i widok (zoom / przesuwanie) ----------
  // Współrzędne „ekranu” to zawsze przestrzeń 1000×600 (W×H) niezależnie od
  // rozmiaru płótna; px = ile pikseli płótna przypada na jednostkę ekranu.
  const view = { s: 1, x: 0, y: 0 };
  const MAX_ZOOM = 8;
  let px = 1;
  let cssScale = 1; // piksele CSS na jednostkę ekranu
  let SH = H; // wysokość ekranu w jednostkach (szerokość zawsze W)

  function resize() {
    const wrap = $('wrap');
    const aw = wrap.clientWidth;
    const ah = wrap.clientHeight;
    // proporcje płótna: od 5:3 (poziomo) do 4:5 (telefon w pionie)
    let cw = aw;
    let ch = Math.min(ah, aw * 1.25);
    if (ch < (aw * H) / W) cw = (ch * W) / H;
    cw = Math.max(1, Math.floor(cw));
    ch = Math.max(1, Math.floor(ch));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.style.width = cw + 'px';
    cv.style.height = ch + 'px';
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    px = cv.width / W;
    cssScale = cw / W;
    SH = (W * ch) / cw;
    clampView();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  function clampView() {
    view.s = clamp(view.s, minZoom(), MAX_ZOOM);
    view.x = clamp(view.x, W - W * view.s, 0);
    view.y = clamp(view.y, SH - H * view.s, 0);
  }

  function minZoom() {
    return Math.max(1, SH / H);
  }

  function zoomAt(cx, cy, factor) {
    const ns = clamp(view.s * factor, minZoom(), MAX_ZOOM);
    const wx = (cx - view.x) / view.s;
    const wy = (cy - view.y) / view.s;
    view.s = ns;
    view.x = cx - wx * ns;
    view.y = cy - wy * ns;
    clampView();
  }

  // Dopasowanie widoku do przepaści z mostem (na telefonie to podstawowy widok)
  function fitView() {
    const x0 = (gapStart - 4) * CELL;
    const x1 = (gapEnd + 4) * CELL;
    const deck = Math.min(terrain[gapStart - 1], terrain[gapEnd]) * CELL;
    let s = W / (x1 - x0);
    s = clamp(s, minZoom(), 2.6);
    view.s = s;
    view.x = -((x0 + x1) / 2) * s + W / 2;
    view.y = -(deck + 50) * s + SH / 2;
    clampView();
  }

  function canvasPt(e) {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * SH };
  }

  function toWorld(c) {
    return { x: (c.x - view.x) / view.s, y: (c.y - view.y) / view.s };
  }

  // Najbliższy punkt siatki; gdy palec trafi w mur, szukamy obok punktu,
  // na którym da się budować (np. kotwicy na krawędzi muru).
  function gridAt(m) {
    let best = null;
    const cx = Math.round(m.x / CELL);
    const cy = Math.round(m.y / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const gx = (cx + dx) * CELL;
        const gy = (cy + dy) * CELL;
        const st = pointState(terrain, gx, gy);
        if (st === 'blocked') continue;
        const d = Math.hypot(gx - m.x, gy - m.y);
        if (d > CELL * 0.95) continue;
        if (!best || d < best.d) best = { x: gx, y: gy, state: st, d };
      }
    }
    if (!best) {
      const gx = cx * CELL;
      const gy = cy * CELL;
      return { x: gx, y: gy, raw: m, state: pointState(terrain, gx, gy) };
    }
    best.raw = m;
    return best;
  }

  function gridPt(e) {
    return gridAt(toWorld(canvasPt(e)));
  }

  // Klik/tap w punkt siatki: pierwszy ustawia początek, kolejne dokładają belkę
  function placePoint(g, chain) {
    if (g.state === 'blocked') return;
    if (!pending) { pending = { x: g.x, y: g.y }; return; }
    const err = beamCheck(pending, g);
    if (err === 'same') { pending = null; return; }
    if (err) { flash(err); return; }
    snapshot();
    const a = getNode(pending.x, pending.y);
    const b = getNode(g.x, g.y);
    design.beams.push({ a, b });
    pending = chain ? { x: g.x, y: g.y } : null;
    updateHud();
  }

  // ---------- wejście: mysz, dotyk, rysik ----------
  const pointers = new Map();
  let gesture = null; // dwa palce: zoom + przesuwanie
  let pan = null; // jeden wskaźnik przesuwa widok
  let touchStart = null; // jeden palec w trybie budowania
  let loupe = null; // {x, y} w przestrzeni ekranu — gdzie jest palec
  const DRAG_CSS = 8;

  function beginGesture() {
    const [p, q] = [...pointers.values()];
    const a = canvasPt(p);
    const b = canvasPt(q);
    gesture = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    if (touchStart && touchStart.moved) pending = touchStart.hadPending ? pending : null;
    touchStart = null;
    pan = null;
    loupe = null;
  }

  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = canvasPt(e);
    if (e.ctrlKey) zoomAt(c.x, c.y, Math.exp(-e.deltaY * 0.01)); // gest szczypania na touchpadzie
    else zoomAt(c.x, c.y, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* brak aktywnego wskaźnika */ }
    pointers.set(e.pointerId, e);
    if (pointers.size >= 2) { beginGesture(); return; }
    const c = canvasPt(e);
    const isMouse = e.pointerType === 'mouse';
    // przesuwanie: narzędzie „Przesuń”, środkowy przycisk, albo podczas testu
    if (tool === 'pan' || mode !== 'build' || (isMouse && e.button === 1)) {
      pan = { id: e.pointerId, x: c.x, y: c.y };
      cv.style.cursor = 'grabbing';
      return;
    }
    const g = gridPt(e);
    hover = g;
    if (isMouse && e.button === 2) {
      if (pending) { pending = null; return; }
      removeBeamNear(g.raw);
      return;
    }
    if (tool === 'del') { removeBeamNear(g.raw); return; }
    touchStart = { id: e.pointerId, g, cx: c.x, cy: c.y, moved: false, hadPending: !!pending, mouse: isMouse };
    if (!isMouse) loupe = c;
  });

  cv.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);
    const c = canvasPt(e);
    if (gesture && pointers.size >= 2) {
      const [p, q] = [...pointers.values()];
      const a = canvasPt(p);
      const b = canvasPt(q);
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      view.x += mx - gesture.mx;
      view.y += my - gesture.my;
      zoomAt(mx, my, d / gesture.d);
      gesture.d = d; gesture.mx = mx; gesture.my = my;
      return;
    }
    if (pan && pan.id === e.pointerId) {
      view.x += c.x - pan.x;
      view.y += c.y - pan.y;
      pan.x = c.x; pan.y = c.y;
      clampView();
      return;
    }
    if (mode !== 'build' || tool === 'pan') { hover = null; return; }
    hover = gridPt(e);
    if (touchStart && touchStart.id === e.pointerId) {
      if (!touchStart.mouse) loupe = c;
      if (!touchStart.moved && Math.hypot(c.x - touchStart.cx, c.y - touchStart.cy) * cssScale > DRAG_CSS) {
        touchStart.moved = true;
        // przeciąganie zaczyna nową belkę od punktu, w którym położono palec
        if (touchStart.g.state !== 'blocked') pending = { x: touchStart.g.x, y: touchStart.g.y };
      }
    }
  });

  cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !touchStart) hover = null; });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (gesture) {
      if (pointers.size < 2) gesture = null;
      // pozostały palec nie buduje, dopóki nie zostanie podniesiony
      return;
    }
    if (pan && pan.id === e.pointerId) { pan = null; cv.style.cursor = ''; return; }
    if (!touchStart || touchStart.id !== e.pointerId) return;
    const ts = touchStart;
    touchStart = null;
    loupe = null;
    if (!ts.mouse) hover = null;
    if (mode !== 'build' || e.type === 'pointercancel') return;
    const g = gridPt(e);
    if (ts.moved) {
      // przeciągnięcie: belka od punktu startu do miejsca puszczenia
      if (pending && (g.x !== pending.x || g.y !== pending.y)) placePoint(g, false);
      else pending = null;
    } else {
      placePoint(g, true);
    }
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  function setTool(t) {
    tool = t;
    pending = null;
    $('tBuild').classList.toggle('on', t === 'build');
    $('tPan').classList.toggle('on', t === 'pan');
    $('tDel').classList.toggle('on', t === 'del');
    cv.className = t === 'pan' ? 'pan' : t === 'del' ? 'del' : '';
  }
  $('tBuild').onclick = () => setTool('build');
  $('tPan').onclick = () => setTool(tool === 'pan' ? 'build' : 'pan');
  $('tDel').onclick = () => setTool(tool === 'del' ? 'build' : 'del');

  $('zin').onclick = () => zoomAt(W / 2, SH / 2, 1.4);
  $('zout').onclick = () => zoomAt(W / 2, SH / 2, 1 / 1.4);
  // ⤢: dopasuj do przepaści; drugie naciśnięcie pokazuje całą planszę
  $('zfit').onclick = () => {
    const before = view.s;
    fitView();
    if (Math.abs(before - view.s) < 0.01) { view.s = 0; view.x = 0; view.y = 0; clampView(); }
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') pending = null;
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) undo();
    if (e.key === '+' || e.key === '=') zoomAt(W / 2, SH / 2, 1.4);
    if (e.key === '-') zoomAt(W / 2, SH / 2, 1 / 1.4);
  });

  function removeBeamNear(m) {
    let best = -1;
    let bd = Math.max(8, 14 / (view.s * cssScale)); // ok. 14 px CSS tolerancji palca
    design.beams.forEach((b, i) => {
      const p = design.nodes[b.a];
      const q = design.nodes[b.b];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const t = clamp(((m.x - p.x) * dx + (m.y - p.y) * dy) / (dx * dx + dy * dy), 0, 1);
      const d = Math.hypot(p.x + dx * t - m.x, p.y + dy * t - m.y);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) {
      snapshot();
      design.beams.splice(best, 1);
      pruneNodes();
      updateHud();
    }
  }

  function undo() {
    if (mode !== 'build' || !undoStack.length) return;
    design = JSON.parse(undoStack.pop());
    pending = null;
    updateHud();
  }

  let toastTimer = 0;
  function flash(t) {
    const el = $('toast');
    el.textContent = t;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  $('undo').onclick = undo;
  $('clear').onclick = () => {
    if (!design.beams.length) return;
    snapshot();
    design = { nodes: [], beams: [] };
    pending = null;
    updateHud();
  };
  $('helpOpen').onclick = () => { $('help').style.display = 'flex'; };
  $('helpB').onclick = () => { $('help').style.display = 'none'; try { localStorage.setItem('zamki-help', '1'); } catch (e) { /* brak dostępu */ } };

  // ---------- test ----------
  $('test').onclick = () => {
    if (mode !== 'build' || !design.beams.length) return;
    pending = null;
    touchStart = null;
    loupe = null;
    mode = 'test';
    resetTestBadges();
    sim = new Sim(terrain, mat, JSON.parse(JSON.stringify(design)));
    sim.settle();
    testIdx = 0;
    startVehicle();
    updateHud();
  };

  let failT = null; // odliczanie do komunikatu o porażce
  function startVehicle() {
    failT = null;
    vehicle = new Vehicle(VEHICLES[testIdx], sim);
    testTime = 0;
    pauseT = 0;
    $('t' + testIdx).className = 'run';
  }

  function endTest(ok) {
    if (ok) {
      $('t' + testIdx).className = 'ok';
      if (testIdx < VEHICLES.length - 1) {
        testIdx++;
        pauseT = 0.8;
        vehicle = null;
        return;
      }
      showOverlay('Poziom ' + level + ' zaliczony! 🎉',
        'Most wytrzymał samochód i ciężarówkę.',
        'Następny poziom', () => { genLevel(level + 1); });
    } else {
      $('t' + testIdx).className = 'bad';
      const sagged = sim.sagFailed;
      showOverlay(sagged ? 'Most ugiął się za bardzo' : 'Most runął 💥',
        VEHICLES[testIdx].name + (sagged ? ': ugięcie ' + sim.sagAtFail.toFixed(1) + ' px (limit ' + sim.sagLimit.toFixed(1) + '). Dodaj trójkąty nad lub pod pomostem.' : ' nie dojechał — pękła belka. Wzmocnij konstrukcję.'),
        'Popraw most', () => { backToBuild(); });
    }
    vehicle = null;
    mode = 'over';
  }

  function backToBuild() {
    mode = 'build';
    sim = null;
    vehicle = null;
    resetTestBadges();
    updateHud();
  }

  function showOverlay(t, p, b, action) {
    $('msgT').textContent = t;
    $('msgP').textContent = p;
    $('msgB').textContent = b;
    overlayAction = action;
    $('msg').style.display = 'flex';
    $('status').style.display = 'none';
  }
  $('msgB').onclick = () => {
    $('msg').style.display = 'none';
    if (overlayAction) overlayAction();
    updateHud();
  };

  // ---------- pętla ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    clock += dt;
    if (mode === 'test' && sim) {
      if (vehicle) {
        testTime += dt;
        const loads = vehicle.update(dt);
        sim.step(dt, loads);
        if (vehicle.damaged && failT === null) failT = 2.2;
        if (failT !== null) failT -= dt;
        if (vehicle.failed || testTime > 40 || (failT !== null && failT <= 0)) endTest(false);
        else if (vehicle.done) endTest(!vehicle.damaged);
      } else {
        sim.step(dt, []);
        pauseT -= dt;
        if (pauseT <= 0 && mode === 'test') startVehicle();
      }
      for (const d of sim.debris) d.t += dt;
    } else if (mode === 'over' && sim) {
      sim.step(dt, []);
      for (const d of sim.debris) d.t += dt;
    }
    const st = $('status');
    if (mode === 'test' && vehicle) {
      st.style.display = 'block';
      st.textContent = VEHICLES[testIdx].name + ' · obciążenie ' + Math.round(sim.maxRatio * 100) + '% · ugięcie ' + sim.maxSag.toFixed(1) + '/' + sim.sagLimit.toFixed(1) + ' px';
    } else {
      st.style.display = 'none';
    }
    draw();
    requestAnimationFrame(frame);
  }

  // ---------- rysowanie ----------
  const brick = document.createElement('canvas');
  brick.width = 40; brick.height = 20;
  (function () {
    const b = brick.getContext('2d');
    b.fillStyle = '#7d7a86'; b.fillRect(0, 0, 40, 20);
    b.strokeStyle = '#5a5762'; b.lineWidth = 1;
    b.strokeRect(0.5, 0.5, 39, 9); b.strokeRect(-10.5, 10.5, 20, 9); b.strokeRect(9.5, 10.5, 20, 9); b.strokeRect(29.5, 10.5, 20, 9);
  })();

  function stressColor(r) {
    const t = clamp(r, 0, 1);
    return 'hsl(' + Math.round(120 - 120 * t) + ',85%,' + Math.round(48 + 4 * (1 - t)) + '%)';
  }

  function drawScene() {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#6fb1e8'); sky.addColorStop(1, '#cfe9f7');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    for (let i = 0; i < 4; i++) {
      const x = ((i * 280 + clock * 8) % (W + 200)) - 100;
      const y = 60 + i * 35;
      ctx.beginPath(); ctx.ellipse(x, y, 50, 16, 0, 0, 7); ctx.ellipse(x + 30, y - 8, 30, 14, 0, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#8fb08a';
    ctx.beginPath(); ctx.moveTo(0, WATER_Y);
    for (let x = 0; x <= W; x += 50) ctx.lineTo(x, 430 - 50 * Math.sin(x / 130 + 1));
    ctx.lineTo(W, WATER_Y); ctx.fill();

    // ziemia i mury zamków
    const pat = ctx.createPattern(brick, 'repeat');
    for (let c = 0; c < COLS; c++) {
      if (!isFinite(terrain[c])) continue;
      const y = terrain[c] * CELL;
      ctx.fillStyle = pat; ctx.fillRect(c * CELL, y, CELL, H - y);
    }
    for (let c = 0; c < COLS; c++) {
      if (!isFinite(terrain[c])) continue;
      const y = terrain[c] * CELL;
      ctx.fillStyle = '#4a3b2a'; ctx.fillRect(c * CELL, y - 3, CELL, 5);
    }
    drawTower(0, terrain[0] * CELL, 1);
    drawTower(W, terrain[COLS - 1] * CELL, -1);

    // woda
    ctx.fillStyle = 'rgba(40,110,190,.85)';
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) ctx.lineTo(x, WATER_Y + Math.sin(x / 25 + clock * 2) * 3);
    ctx.lineTo(W, H); ctx.fill();
  }

  function drawTower(x, y, dir) {
    const tw = 70;
    const th = 120;
    const x0 = dir > 0 ? x : x - tw;
    ctx.fillStyle = '#8b8894'; ctx.fillRect(x0, y - th, tw, th);
    ctx.fillStyle = '#6d6a76';
    for (let i = 0; i < 4; i++) ctx.fillRect(x0 + i * 20 - (i === 3 ? 10 : 0), y - th - 14, 12, 14);
    ctx.fillStyle = '#2b2530';
    ctx.beginPath(); ctx.moveTo(x0 + 24, y); ctx.lineTo(x0 + 24, y - 30); ctx.arc(x0 + 35, y - 30, 11, Math.PI, 0); ctx.lineTo(x0 + 46, y); ctx.fill();
    ctx.fillRect(x0 + 31, y - 90, 8, 22);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0 + 35, y - th - 14); ctx.lineTo(x0 + 35, y - th - 44); ctx.stroke();
    ctx.fillStyle = dir > 0 ? '#d33' : '#36c';
    const wv = Math.sin(clock * 4) * 3;
    ctx.beginPath(); ctx.moveTo(x0 + 35, y - th - 44); ctx.lineTo(x0 + 58, y - th - 38 + wv); ctx.lineTo(x0 + 35, y - th - 30); ctx.fill();
  }

  function drawBeams(bnodes, bbeams, testing) {
    for (const b of bbeams) {
      if (b.broken) continue;
      const p = bnodes[b.a];
      const q = bnodes[b.b];
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#222'; ctx.lineWidth = mat.w + 3;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.strokeStyle = testing ? stressColor(b.ratio) : mat.color; ctx.lineWidth = mat.w;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    for (const n of bnodes) {
      ctx.fillStyle = n.fixed ? '#ffd166' : '#eee';
      ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.fixed ? 5 : 4, 0, 7); ctx.fill(); ctx.stroke();
    }
  }

  function drawVehicle(v) {
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.angle);
    const id = v.def.id;
    const spin = v.wheel / 8;
    const wheel = (x, r) => {
      ctx.fillStyle = '#1d1d1d'; ctx.beginPath(); ctx.arc(x, -r, r, 0, 7); ctx.fill();
      ctx.strokeStyle = '#999'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(spin) * (r - 2), -r + Math.sin(spin) * (r - 2)); ctx.lineTo(x - Math.cos(spin) * (r - 2), -r - Math.sin(spin) * (r - 2)); ctx.stroke();
    };
    if (id === 'car') {
      ctx.fillStyle = '#d62828'; ctx.fillRect(-26, -22, 52, 13);
      ctx.beginPath(); ctx.moveTo(-14, -22); ctx.lineTo(-8, -33); ctx.lineTo(10, -33); ctx.lineTo(17, -22); ctx.fill();
      ctx.fillStyle = '#bfe3ff'; ctx.fillRect(-9, -31, 8, 8); ctx.fillRect(2, -31, 8, 8);
      wheel(-16, 7); wheel(16, 7);
    } else if (id === 'truck') {
      ctx.fillStyle = '#e09f3e'; ctx.fillRect(-50, -40, 66, 28);
      ctx.fillStyle = '#2a6f97'; ctx.fillRect(18, -40, 28, 28);
      ctx.fillStyle = '#bfe3ff'; ctx.fillRect(34, -36, 10, 11);
      ctx.fillStyle = '#6b4a1f'; ctx.fillRect(-46, -48, 56, 9);
      wheel(-38, 8); wheel(-4, 8); wheel(34, 8);
    } else {
      ctx.fillStyle = '#4b5d3a';
      ctx.fillRect(-55, -22, 110, 20);
      ctx.beginPath(); ctx.roundRect(-55, -22, 110, 20, 10); ctx.fill();
      ctx.fillRect(-28, -38, 52, 17);
      ctx.fillStyle = '#3a4a2c'; ctx.fillRect(22, -33, 46, 6);
      ctx.fillStyle = '#222';
      for (const dx of [-44, -22, 0, 22, 44]) { ctx.beginPath(); ctx.arc(dx, -9, 8, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }

  // rozmiar w jednostkach świata odpowiadający danej liczbie pikseli CSS
  function cssToWorld(n) { return n / (view.s * cssScale); }

  function drawLoupe() {
    const R = (58 / cssScale) * px; // promień lupy w pikselach płótna
    const fx = loupe.x * px;
    const fy = loupe.y * px;
    let lx = fx;
    let ly = fy - R * 2.1;
    if (ly < R + 4) { ly = Math.max(R + 4, fy); lx = fx + (fx < cv.width / 2 ? 1 : -1) * R * 2.3; }
    lx = clamp(lx, R + 4, cv.width - R - 4);
    const mag = 2.2;
    const src = R / mag;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, 7); ctx.closePath();
    ctx.fillStyle = '#6fb1e8'; ctx.fill();
    ctx.clip();
    const sx = clamp(fx - src, 0, cv.width - 2 * src);
    const sy = clamp(fy - src, 0, cv.height - 2 * src);
    ctx.drawImage(cv, sx, sy, 2 * src, 2 * src, lx - R + (sx - (fx - src)) * mag, ly - R + (sy - (fy - src)) * mag, 2 * R, 2 * R);
    ctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, R * 0.04);
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, 7); ctx.stroke();
    ctx.restore();
  }

  function draw() {
    const k = px;
    ctx.setTransform(k * view.s, 0, 0, k * view.s, k * view.x, k * view.y);
    drawScene();
    if (mode === 'build') {
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      const dot = clamp(cssToWorld(3), 1.5, 4);
      for (let gx = 0; gx <= W; gx += CELL) {
        for (let gy = 0; gy <= 26 * CELL; gy += CELL) {
          const st = pointState(terrain, gx, gy);
          if (st === 'free') ctx.fillRect(gx - dot / 2, gy - dot / 2, dot, dot);
        }
      }
      // kotwice na murach (tylko przy przepaści)
      ctx.fillStyle = 'rgba(255,209,102,.7)';
      for (const c of [gapStart, gapEnd]) {
        for (let r = 0; r <= 26; r++) {
          if (pointState(terrain, c * CELL, r * CELL) === 'anchor') ctx.fillRect(c * CELL - dot / 2, r * CELL - dot / 2, dot, dot);
        }
      }
      drawBeams(design.nodes, design.beams, false);
      const rr = clamp(cssToWorld(10), 5, 12);
      if (pending) {
        ctx.fillStyle = '#ff9f1c'; ctx.beginPath(); ctx.arc(pending.x, pending.y, rr * 0.8, 0, 7); ctx.fill();
        if (hover && hover.state !== 'blocked') {
          const err = beamCheck(pending, hover);
          ctx.strokeStyle = err && err !== 'same' ? '#ff3b3b' : '#ffffff'; ctx.lineWidth = clamp(cssToWorld(3), 2, 4);
          ctx.setLineDash([6, 5]);
          ctx.beginPath(); ctx.moveTo(pending.x, pending.y); ctx.lineTo(hover.x, hover.y); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (hover && hover.state !== 'blocked' && tool === 'build') {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = clamp(cssToWorld(2.5), 1.5, 3);
        ctx.beginPath(); ctx.arc(hover.x, hover.y, rr, 0, 7); ctx.stroke();
      }
    } else if (sim) {
      for (const d of sim.debris) {
        const f = 0.5 * 600 * d.t * d.t;
        ctx.globalAlpha = Math.max(0, 1 - d.t / 2);
        ctx.strokeStyle = '#6b4a1f'; ctx.lineWidth = mat.w;
        ctx.beginPath(); ctx.moveTo(d.x1, d.y1 + f); ctx.lineTo(d.x2, d.y2 + f); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (vehicle) drawVehicle(vehicle);
      drawBeams(sim.nodes, sim.beams, true);
    }
    if (loupe && mode === 'build') drawLoupe();
  }

  resize();
  genLevel(1);
  try { if (!localStorage.getItem('zamki-help')) $('help').style.display = 'flex'; } catch (e) { /* brak dostępu */ }
  requestAnimationFrame(frame);
  window.__game = {
    get mode() { return mode; }, get level() { return level; }, get design() { return design; },
    get terrain() { return terrain; }, get mat() { return mat; }, get view() { return view; },
    get gapStart() { return gapStart; }, get gapEnd() { return gapEnd; }, genLevel,
  };
})();
