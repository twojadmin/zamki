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
  function genLevel(n) {
    level = n;
    mat = MATERIALS[(n - 1) % MATERIALS.length];
    const gap = Math.min(6 + 2 * (n - 1), 26);
    const left = clamp(Math.floor((COLS - gap) / 2) + rnd(-2, 2), 6, COLS - gap - 6);
    gapStart = left;
    gapEnd = left + gap;
    const spread = Math.min(1 + n, 4);
    const hL = rnd(13, 17);
    const hR = n === 1 ? hL : clamp(hL + rnd(-spread, spread), 10, 20);
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
    budget = Math.round(gap * CELL * mat.cost * 8);
    design = { nodes: [], beams: [] };
    undoStack = [];
    pending = null;
    mode = 'build';
    sim = null;
    vehicle = null;
    resetTestBadges();
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
    $('budget').textContent = budget - spent() + ' / ' + budget;
    $('test').disabled = mode !== 'build' || design.beams.length === 0;
    $('undo').disabled = mode !== 'build' || !undoStack.length;
    $('clear').disabled = mode !== 'build' || !design.beams.length;
  }

  function resetTestBadges() {
    for (let i = 0; i < 3; i++) $('t' + i).className = '';
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

  // ---------- widok (zoom / przesuwanie) ----------
  const view = { s: 1, x: 0, y: 0 };
  const MAX_ZOOM = 5;
  let deleteMode = false;

  function clampView() {
    view.s = clamp(view.s, 1, MAX_ZOOM);
    view.x = clamp(view.x, W - W * view.s, 0);
    view.y = clamp(view.y, H - H * view.s, 0);
  }

  function zoomAt(cx, cy, factor) {
    const ns = clamp(view.s * factor, 1, MAX_ZOOM);
    const wx = (cx - view.x) / view.s;
    const wy = (cy - view.y) / view.s;
    view.s = ns;
    view.x = cx - wx * ns;
    view.y = cy - wy * ns;
    clampView();
  }

  function canvasPt(e) {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  function mousePt(e) {
    const c = canvasPt(e);
    return { x: (c.x - view.x) / view.s, y: (c.y - view.y) / view.s };
  }

  function gridPt(e) {
    const m = mousePt(e);
    const gx = Math.round(m.x / CELL) * CELL;
    const gy = Math.round(m.y / CELL) * CELL;
    return { x: gx, y: gy, raw: m, state: pointState(terrain, gx, gy) };
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

  const pointers = new Map();
  let gesture = null;
  let touchStart = null;
  const DRAG_PX = 10;

  function beginGesture() {
    const [p, q] = [...pointers.values()];
    const a = canvasPt(p);
    const b = canvasPt(q);
    gesture = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    touchStart = null;
  }

  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = canvasPt(e);
    zoomAt(c.x, c.y, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  cv.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);
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
    hover = gridPt(e);
    if (touchStart && touchStart.id === e.pointerId && !touchStart.moved) {
      const c = canvasPt(e);
      if (Math.hypot(c.x - touchStart.cx, c.y - touchStart.cy) > DRAG_PX * (W / cv.getBoundingClientRect().width)) {
        touchStart.moved = true;
        if (!deleteMode && !pending && touchStart.g.state !== 'blocked') pending = { x: touchStart.g.x, y: touchStart.g.y };
      }
    }
  });

  cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover = null; });

  cv.addEventListener('pointerdown', (e) => {
    if (mode !== 'build') return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* zdarzenie bez aktywnego wskaźnika */ }
    pointers.set(e.pointerId, e);
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      if (pointers.size >= 2) { beginGesture(); return; }
      const c = canvasPt(e);
      hover = gridPt(e);
      touchStart = { id: e.pointerId, g: hover, cx: c.x, cy: c.y, moved: false, hadPending: !!pending };
      return;
    }
    const g = gridPt(e);
    if (e.button === 2) {
      if (pending) { pending = null; return; }
      removeBeamNear(g.raw);
      return;
    }
    if (deleteMode) { removeBeamNear(g.raw); return; }
    placePoint(g, true);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (gesture && pointers.size < 2) gesture = null;
    if (!touchStart || touchStart.id !== e.pointerId) return;
    const ts = touchStart;
    touchStart = null;
    if (mode !== 'build' || e.type === 'pointercancel') return;
    const g = gridPt(e);
    if (deleteMode) { removeBeamNear(g.raw); return; }
    if (ts.moved) {
      // przeciągnięcie: belka od punktu startu do puszczenia palca
      if (pending && (g.x !== pending.x || g.y !== pending.y)) placePoint(g, false);
      else pending = ts.hadPending ? pending : null;
    } else {
      placePoint(g, true);
    }
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  $('zin').onclick = () => zoomAt(W / 2, H / 2, 1.5);
  $('zout').onclick = () => zoomAt(W / 2, H / 2, 1 / 1.5);
  $('zreset').onclick = () => { view.s = 1; view.x = 0; view.y = 0; };
  $('del').onclick = () => {
    deleteMode = !deleteMode;
    pending = null;
    $('del').classList.toggle('on', deleteMode);
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') pending = null;
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) undo();
  });

  function removeBeamNear(m) {
    let best = -1;
    let bd = 10;
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

  let flashMsg = '';
  let flashT = 0;
  function flash(t) { flashMsg = t; flashT = 1.5; }

  $('undo').onclick = undo;
  $('clear').onclick = () => {
    if (!design.beams.length) return;
    snapshot();
    design = { nodes: [], beams: [] };
    pending = null;
    updateHud();
  };

  // ---------- test ----------
  $('test').onclick = () => {
    if (mode !== 'build' || !design.beams.length) return;
    pending = null;
    view.s = 1; view.x = 0; view.y = 0;
    mode = 'test';
    resetTestBadges();
    sim = new Sim(terrain, mat, JSON.parse(JSON.stringify(design)));
    sim.settle();
    testIdx = 0;
    startVehicle();
    updateHud();
  };

  function startVehicle() {
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
        'Most wytrzymał samochód, ciężarówkę i czołg. W następnym poziomie zmieni się teren, odległość między zamkami i materiał.',
        'Następny poziom', () => { genLevel(level + 1); });
    } else {
      $('t' + testIdx).className = 'bad';
      const sagged = sim.maxSag > sim.sagLimit && !sim.beams.some((b) => b.broken);
      showOverlay(sagged ? 'Most ugiął się za bardzo' : 'Most runął 💥',
        VEHICLES[testIdx].name + (sagged ? ' zapadł się w pomost (' + sim.maxSag.toFixed(1) + ' px, limit ' + sim.sagLimit.toFixed(1) + ' px). Luźny łańcuch belek nie wystarczy — użyj usztywnień (trójkątów).' : ' nie dojechał na drugą stronę. Wzmocnij konstrukcję.'),
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
    if (flashT > 0) flashT -= dt;
    if (mode === 'test' && sim) {
      if (vehicle) {
        testTime += dt;
        const loads = vehicle.update(dt);
        sim.step(dt, loads);
        if (vehicle.failed || testTime > 40) endTest(false);
        else if (vehicle.done) endTest(true);
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

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.setTransform(view.s, 0, 0, view.s, view.x, view.y);
    drawScene();
    if (mode === 'build') {
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      for (let gx = 0; gx <= W; gx += CELL) {
        for (let gy = 0; gy <= 26 * CELL; gy += CELL) {
          if (pointState(terrain, gx, gy) === 'free') ctx.fillRect(gx - 1, gy - 1, 2, 2);
        }
      }
      drawBeams(design.nodes, design.beams, false);
      if (pending) {
        ctx.fillStyle = '#ff9f1c'; ctx.beginPath(); ctx.arc(pending.x, pending.y, 7, 0, 7); ctx.fill();
        if (hover && hover.state !== 'blocked') {
          const err = beamCheck(pending, hover);
          ctx.strokeStyle = err && err !== 'same' ? '#ff3b3b' : '#ffffff'; ctx.lineWidth = 3;
          ctx.setLineDash([6, 5]);
          ctx.beginPath(); ctx.moveTo(pending.x, pending.y); ctx.lineTo(hover.x, hover.y); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (hover && hover.state !== 'blocked') {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(hover.x, hover.y, 7, 0, 7); ctx.stroke();
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
      if (vehicle) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(10, 10, 420, 28);
        ctx.fillStyle = '#fff'; ctx.font = '14px system-ui';
        ctx.fillText(VEHICLES[testIdx].name + ' — największe obciążenie: ' + Math.round(sim.maxRatio * 100) + '%, ugięcie ' + sim.maxSag.toFixed(1) + '/' + sim.sagLimit.toFixed(1) + ' px', 18, 29);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (flashT > 0) {
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(W / 2 - 130, 12, 260, 30);
      ctx.fillStyle = '#ff8a8a'; ctx.font = '15px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(flashMsg, W / 2, 32); ctx.textAlign = 'left';
    }
  }

  genLevel(1);
  requestAnimationFrame(frame);
  window.__game = { get mode() { return mode; }, get level() { return level; }, get design() { return design; }, get terrain() { return terrain; }, get mat() { return mat; }, genLevel };
})();
