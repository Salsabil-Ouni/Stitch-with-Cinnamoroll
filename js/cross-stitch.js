(() => {
  const LEVELS = window.STITCH_LEVELS;
  const SYMBOLS = ['●', '♥', '■', '▲', '◆', '★', '✿'];
  const PROGRESS_KEY = 'cinna-stitch-v2';
  const UNLOCK_KEY = 'cinna-stitch-unlocked';
  const SFX_KEY = 'cinna-stitch-sfx';
  const MUSIC_KEY = 'cinna-stitch-music';
  const ZOOMS = [1, 1.5, 2, 3];

  const $ = id => document.getElementById(id);
  const canvas = $('cloth');
  const ctx = canvas.getContext('2d');
  const board = $('board');
  const levelsEl = $('levels');
  const titleEl = $('levelTitle');
  const paletteEl = $('palette');
  const fillEl = $('fill');
  const countEl = $('count');
  const totalEl = $('total');
  const doneEl = $('done');
  const nextBtn = $('next');
  const hintBtn = $('hintBtn');
  const needle = $('needle');

  LEVELS.forEach(L => {
    L.total = L.grid.reduce((n, row) => n + [...row].filter(ch => ch !== '.').length, 0);
  });

  let saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); // levelId -> ["r,c", ...]
  let unlocked = Number(localStorage.getItem(UNLOCK_KEY) || 1);
  let levelIndex = 0;
  let level, CELL, targets, done;
  let current = 0;
  let showGuide = true;
  let flash = null;
  let drawing = false;
  let strokes = [];
  let stroke = null;
  let zoomIdx = 0;
  let moveMode = false;
  let panning = null;
  let hintCell = null;
  let lastCell = null;
  let wrongStreak = 0;
  let announced = new Set();
  let gameStarted = false;
  const pops = new Map();
  let rafPending = false;

  const key = (r, c) => r + ',' + c;
  const chAt = (r, c) => level.grid[r][c];
  const colorIdx = (r, c) => {
    const ch = chAt(r, c);
    return ch === '.' ? -1 : '0123456789abcdefghij'.indexOf(ch);
  };
  const parse = k => k.split(',').map(Number);

  /* ---------- sound ---------- */
  const audio = {
    ctx: null,
    master: null,
    sfxOn: localStorage.getItem(SFX_KEY) !== '0',
    musicOn: localStorage.getItem(MUSIC_KEY) === '1',
    musicTimer: null,
    step: 0,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    },
    tone(freq, dur, type, vol, delay) {
      const t = this.ctx.currentTime + (delay || 0);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    },
    sfx(fn) { if (this.sfxOn && gameStarted && this.ensure()) fn(); },
    pop(i) {
      const f = [523.25, 587.33, 659.25, 698.46, 783.99, 880, 987.77][i % 7];
      this.sfx(() => { this.tone(f, 0.14, 'sine', 0.12); this.tone(f * 2, 0.08, 'triangle', 0.035); });
    },
    wrong() { this.sfx(() => this.tone(196, 0.14, 'sine', 0.07)); },
    undo() { this.sfx(() => { this.tone(392, 0.09, 'sine', 0.08); this.tone(294, 0.12, 'sine', 0.08, 0.07); }); },
    hint() { this.sfx(() => { this.tone(880, 0.12, 'sine', 0.08); this.tone(1318.5, 0.18, 'sine', 0.07, 0.1); }); },
    chime() { this.sfx(() => [659.25, 783.99, 1046.5].forEach((f, k) => this.tone(f, 0.45, 'sine', 0.11, k * 0.11))); },
    fanfare() {
      this.sfx(() => [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5].forEach((f, k) => this.tone(f, 0.5, 'triangle', 0.12, k * 0.13)));
    },
    // soft, slow lullaby: sine pads and sparse bell notes through a low-pass filter and a gentle echo
    musicBus() {
      if (this.bus) return this.bus;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1100;
      const delay = this.ctx.createDelay(1);
      delay.delayTime.value = 0.55;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.3;
      const wet = this.ctx.createGain();
      wet.gain.value = 0.35;
      const bus = this.ctx.createGain();
      bus.gain.value = 0.7;
      bus.connect(lp);
      lp.connect(this.master);
      lp.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(wet);
      wet.connect(this.master);
      this.bus = bus;
      return bus;
    },
    soft(freq, dur, vol, attack, delay) {
      const t = this.ctx.currentTime + (delay || 0);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.musicBus());
      osc.start(t);
      osc.stop(t + dur + 0.05);
    },
    startMusic() {
      if (!this.musicOn || this.musicTimer || !this.ensure()) return;
      const MEL = [
        659.25, 0, 523.25, 0, 587.33, 0, 523.25, 0,   // C
        440, 0, 523.25, 0, 659.25, 0, 587.33, 0,      // Am
        523.25, 0, 440, 0, 523.25, 0, 587.33, 0,      // F
        587.33, 0, 493.88, 0, 587.33, 0, 392, 0,      // G
      ];
      const CHORDS = [[261.63, 329.63, 392], [220, 261.63, 329.63], [174.61, 220, 261.63], [196, 246.94, 293.66]];
      const tick = () => {
        if (!this.musicOn) { this.musicTimer = null; return; }
        const s = this.step++ % 32;
        if (s % 8 === 0) CHORDS[s / 8].forEach(f => this.soft(f, 6, 0.02, 1.2));
        if (MEL[s]) this.soft(MEL[s], 2.2, 0.026, 0.05);
        this.musicTimer = setTimeout(tick, 640);
      };
      tick();
    },
    stopMusic() { clearTimeout(this.musicTimer); this.musicTimer = null; },
  };

  /* ---------- confetti ---------- */
  const fx = document.createElement('canvas');
  fx.id = 'fx';
  document.body.appendChild(fx);
  const fctx = fx.getContext('2d');
  let parts = [];
  let fxRunning = false;
  const CONFETTI = ['#ff9ec4', '#6cc3f7', '#ffd36e', '#b9e8a8', '#d4c5f0', '#ffffff'];

  function resizeFx() { fx.width = window.innerWidth; fx.height = window.innerHeight; }
  window.addEventListener('resize', resizeFx);
  resizeFx();

  function burst(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 7;
      parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 5,
        size: 6 + Math.random() * 9, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)],
        shape: ['heart', 'star', 'dot'][Math.floor(Math.random() * 3)], life: 1,
      });
    }
    if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxLoop); }
  }

  function shape(c, p) {
    c.save();
    c.translate(p.x, p.y);
    c.rotate(p.rot);
    c.fillStyle = p.color;
    c.globalAlpha = Math.max(0, p.life);
    const s = p.size;
    c.beginPath();
    if (p.shape === 'heart') {
      c.moveTo(0, s * 0.35);
      c.bezierCurveTo(-s, -s * 0.3, -s * 0.5, -s, 0, -s * 0.45);
      c.bezierCurveTo(s * 0.5, -s, s, -s * 0.3, 0, s * 0.35);
    } else if (p.shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? s * 0.4 : s * 0.9;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr);
      }
    } else {
      c.arc(0, 0, s * 0.4, 0, Math.PI * 2);
    }
    c.closePath();
    c.fill();
    c.restore();
  }

  function fxLoop() {
    fctx.clearRect(0, 0, fx.width, fx.height);
    parts.forEach(p => {
      p.vy += 0.22; p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 0.008;
      shape(fctx, p);
    });
    parts = parts.filter(p => p.life > 0 && p.y < fx.height + 40);
    if (parts.length) requestAnimationFrame(fxLoop);
    else { fxRunning = false; fctx.clearRect(0, 0, fx.width, fx.height); }
  }

  function celebrate() {
    const w = window.innerWidth, h = window.innerHeight;
    burst(w * 0.2, h * 0.6, 40);
    burst(w * 0.8, h * 0.6, 40);
    setTimeout(() => burst(w * 0.5, h * 0.4, 60), 250);
  }

  /* ---------- mascot ---------- */
  let bubbleTimer = null;
  function say(text, ms) {
    if (!gameStarted) return;
    const b = $('bubble');
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => b.classList.remove('show'), ms || 3200);
  }
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  /* ---------- levels ---------- */
  function loadLevel(i) {
    levelIndex = i;
    level = LEVELS[i];
    CELL = Math.max(10, Math.floor(560 / Math.max(level.cols, level.rows)));
    canvas.width = level.cols * CELL;
    canvas.height = level.rows * CELL;
    canvas.style.aspectRatio = level.cols + ' / ' + level.rows;

    targets = [];
    for (let r = 0; r < level.rows; r++) {
      for (let c = 0; c < level.cols; c++) {
        if (colorIdx(r, c) >= 0) targets.push(key(r, c));
      }
    }
    done = new Set((saved[level.id] || []).filter(k => targets.includes(k)));
    strokes = [];
    hintCell = null;
    lastCell = null;
    pops.clear();
    setZoom(0);
    resetAnnounced();
    titleEl.textContent = (i + 1 === LEVELS.length ? 'Master Level' : 'Level ' + (i + 1)) + ': ' + level.title;
    totalEl.textContent = targets.length;
    pickFirstUnfinished();
    buildLevelButtons();
    buildPalette();
    draw();
    if (gameStarted) say(pick(['let\'s stitch ' + level.title + '!', 'this one is so cute!', 'take your time~']));
  }

  function resetAnnounced() {
    announced = new Set();
    const pct = done.size / targets.length * 100;
    [25, 50, 75].forEach(t => { if (pct >= t) announced.add(t); });
  }

  function remaining(idx) {
    let n = 0;
    targets.forEach(k => {
      const [r, c] = parse(k);
      if (colorIdx(r, c) === idx && !done.has(k)) n++;
    });
    return n;
  }

  function pickFirstUnfinished() {
    const first = level.palette.findIndex((_, i) => remaining(i) > 0);
    current = first >= 0 ? first : 0;
    updateNeedle();
  }

  function buildLevelButtons() {
    levelsEl.innerHTML = '';
    LEVELS.forEach((L, i) => {
      const b = document.createElement('button');
      const locked = i + 1 > unlocked;
      b.className = 'lvl' + (i === levelIndex ? ' active' : '') + (locked ? ' locked' : '');
      if (locked) b.innerHTML = '<img src="gifs/stitch/lock.png" alt="locked" />';
      else b.textContent = i + 1 === LEVELS.length ? '★' : i + 1;
      b.title = L.title;
      b.disabled = locked;
      b.addEventListener('click', () => loadLevel(i));
      levelsEl.appendChild(b);
    });
  }

  function buildPalette() {
    paletteEl.innerHTML = '';
    level.palette.forEach((t, i) => {
      const left = remaining(i);
      const b = document.createElement('button');
      b.className = 'swatch' + (i === current ? ' active' : '') + (left === 0 ? ' finished' : '');
      b.innerHTML =
        '<span class="dot" style="background:' + t.color + '">' + SYMBOLS[i % SYMBOLS.length] + '</span>' +
        t.name + ' (' + left + ')';
      b.addEventListener('click', () => { current = i; wrongStreak = 0; updateNeedle(); buildPalette(); draw(); });
      paletteEl.appendChild(b);
    });
  }

  function updateNeedle() {
    const t = level && level.palette[current];
    if (t) $('needleThread').setAttribute('stroke', t.color);
  }

  /* ---------- drawing ---------- */
  function drawStitchOn(c2, cell, r, c, color, scale) {
    const cx = c * cell + cell / 2;
    const cy = r * cell + cell / 2;
    const half = cell / 2 - Math.max(2, cell * 0.15);
    c2.save();
    c2.translate(cx, cy);
    c2.scale(scale, scale);
    c2.lineCap = 'round';
    c2.lineWidth = cell * 0.26;
    c2.strokeStyle = 'rgba(91,127,166,0.35)';
    c2.beginPath();
    c2.moveTo(-half, -half); c2.lineTo(half, half);
    c2.moveTo(half, -half); c2.lineTo(-half, half);
    c2.stroke();
    c2.lineWidth = cell * 0.18;
    c2.strokeStyle = color;
    c2.beginPath();
    c2.moveTo(-half, -half); c2.lineTo(half, half);
    c2.moveTo(half, -half); c2.lineTo(-half, half);
    c2.stroke();
    c2.restore();
  }

  function easeOutBack(t) {
    const c1 = 2.2, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; draw(); });
  }

  function draw() {
    const now = performance.now();
    let animating = false;

    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#e3e8f0';
    for (let r = 0; r <= level.rows; r++) {
      for (let c = 0; c <= level.cols; c++) {
        ctx.fillRect(c * CELL - 1, r * CELL - 1, 2, 2);
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = Math.round(CELL * 0.6) + 'px Nunito, sans-serif';

    targets.forEach(k => {
      const [r, c] = parse(k);
      const idx = colorIdx(r, c);
      if (done.has(k)) {
        let scale = 1;
        const t0 = pops.get(k);
        if (t0 !== undefined) {
          const p = (now - t0) / 240;
          if (p < 1) { scale = easeOutBack(Math.max(0, p)); animating = true; } else pops.delete(k);
        }
        drawStitchOn(ctx, CELL, r, c, level.palette[idx].color, scale);
      } else if (showGuide) {
        ctx.fillStyle = idx === current ? 'rgba(91,127,166,0.75)' : 'rgba(91,127,166,0.28)';
        ctx.fillText(SYMBOLS[idx % SYMBOLS.length], c * CELL + CELL / 2, r * CELL + CELL / 2 + 1);
      }
    });

    if (flash && now < flash.until) {
      const [r, c] = parse(flash.key);
      ctx.fillStyle = 'rgba(255, 120, 150, 0.35)';
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      animating = true;
    }

    if (hintCell && now < hintCell.until && !done.has(hintCell.key)) {
      const [r, c] = parse(hintCell.key);
      const idx = colorIdx(r, c);
      const pulse = 0.5 + 0.5 * Math.sin(now / 130);
      ctx.fillStyle = 'rgba(255, 211, 110, ' + (0.25 + 0.3 * pulse) + ')';
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      ctx.strokeStyle = 'rgba(255, 126, 182, ' + (0.6 + 0.4 * pulse) + ')';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c * CELL + CELL / 2, r * CELL + CELL / 2, CELL * (0.75 + 0.35 * pulse), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(91,127,166,0.9)';
      ctx.fillText(SYMBOLS[idx % SYMBOLS.length], c * CELL + CELL / 2, r * CELL + CELL / 2 + 1);
      animating = true;
    } else if (hintCell) {
      hintCell = null;
    }

    const n = done.size;
    countEl.textContent = n;
    fillEl.style.width = (n / targets.length * 100) + '%';
    const finished = n >= targets.length;
    doneEl.hidden = !finished;
    nextBtn.hidden = levelIndex + 1 >= LEVELS.length;

    if (animating) schedule();
  }

  /* ---------- zoom ---------- */
  function setZoom(i) {
    zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, i));
    const z = ZOOMS[zoomIdx];
    board.style.setProperty('--zoom', z);
    board.classList.toggle('zoomed', z > 1);
    $('zoomOut').disabled = zoomIdx === 0;
    $('zoomIn').disabled = zoomIdx === ZOOMS.length - 1;
    $('zoomOut').style.opacity = zoomIdx === 0 ? 0.45 : 1;
    $('zoomIn').style.opacity = zoomIdx === ZOOMS.length - 1 ? 0.45 : 1;
    $('moveBtn').hidden = z === 1;
    if (z === 1) setMove(false);
  }
  function setMove(on) {
    moveMode = on;
    board.classList.toggle('moving', on);
    $('moveBtn').setAttribute('aria-pressed', String(on));
    $('moveBtn').classList.toggle('on', on);
  }

  /* ---------- stitching ---------- */
  function cellAt(e) {
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width) / CELL);
    const r = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height) / CELL);
    if (r < 0 || c < 0 || r >= level.rows || c >= level.cols) return null;
    return { r, c };
  }

  function save() {
    saved[level.id] = [...done];
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(saved));
  }

  function stitch(e) {
    const cell = cellAt(e);
    if (!cell) return;
    const { r, c } = cell;
    const idx = colorIdx(r, c);
    const k = key(r, c);
    if (idx < 0 || done.has(k)) return;
    if (idx !== current) {
      flash = { key: k, until: performance.now() + 250 };
      audio.wrong();
      wrongStreak++;
      if (wrongStreak === 3) say('try the ' + level.palette[idx].name + ' thread there~');
      draw();
      return;
    }
    wrongStreak = 0;
    const wasFinished = done.size >= targets.length;
    done.add(k);
    if (stroke) stroke.push(k);
    pops.set(k, performance.now());
    lastCell = k;
    if (hintCell && hintCell.key === k) hintCell = null;
    save();
    audio.pop(idx);

    const pct = done.size / targets.length * 100;
    [25, 50, 75].forEach(t => {
      if (pct >= t && !announced.has(t)) {
        announced.add(t);
        say(t === 25 ? 'nice start!' : t === 50 ? 'halfway there!' : 'almost done!');
      }
    });

    const finishedNow = !wasFinished && done.size >= targets.length;
    if (finishedNow) {
      if (levelIndex + 2 > unlocked) {
        unlocked = levelIndex + 2;
        localStorage.setItem(UNLOCK_KEY, unlocked);
        buildLevelButtons();
      }
      setTimeout(() => { audio.fanfare(); celebrate(); say('we did it!! so cute!', 4500); }, 150);
    } else if (remaining(current) === 0) {
      const name = level.palette[current].name;
      audio.chime();
      say('all the ' + name + ' is done!');
    }
    if (remaining(current) === 0) pickFirstUnfinished();
    buildPalette();
    draw();
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (moveMode) {
      panning = { x: e.clientX, y: e.clientY, left: board.scrollLeft, top: board.scrollTop };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('grabbing');
      return;
    }
    drawing = true;
    stroke = [];
    canvas.setPointerCapture(e.pointerId);
    stitch(e);
  });
  canvas.addEventListener('pointermove', e => {
    if (panning) {
      board.scrollLeft = panning.left - (e.clientX - panning.x);
      board.scrollTop = panning.top - (e.clientY - panning.y);
      return;
    }
    if (e.pointerType === 'mouse' && !moveMode) {
      needle.hidden = false;
      canvas.classList.add('has-needle');
      needle.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 31) + 'px)';
    }
    if (drawing) stitch(e);
  });
  function endStroke() {
    if (panning) { panning = null; canvas.classList.remove('grabbing'); return; }
    drawing = false;
    if (stroke && stroke.length) strokes.push(stroke);
    stroke = null;
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { needle.hidden = true; canvas.classList.remove('has-needle'); });

  /* ---------- tools ---------- */
  function undo() {
    const s = strokes.pop();
    if (!s) { say('nothing to undo yet~'); return; }
    s.forEach(k => done.delete(k));
    save();
    audio.undo();
    say(pick(['oops, no worries!', 'all fixed~']));
    if (remaining(current) === 0) pickFirstUnfinished();
    buildPalette();
    resetAnnounced();
    draw();
  }

  function giveHint() {
    let pool = targets.filter(k => !done.has(k));
    if (!pool.length) { say('nothing left to stitch!'); return; }
    const same = pool.filter(k => { const [r, c] = parse(k); return colorIdx(r, c) === current; });
    if (same.length) pool = same;
    let best = pool[0];
    if (lastCell) {
      const [lr, lc] = parse(lastCell);
      let bd = Infinity;
      pool.forEach(k => {
        const [r, c] = parse(k);
        const d = (r - lr) * (r - lr) + (c - lc) * (c - lc);
        if (d < bd) { bd = d; best = k; }
      });
    }
    const [r, c] = parse(best);
    if (!same.length) { current = colorIdx(r, c); buildPalette(); }
    hintCell = { key: best, until: performance.now() + 3200 };
    // scroll the zoomed cloth to the hinted cell
    if (board.classList.contains('zoomed')) {
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width / canvas.width;
      board.scrollTo({ left: (c + 0.5) * CELL * sx - board.clientWidth / 2, top: (r + 0.5) * CELL * sx - board.clientHeight / 2, behavior: 'smooth' });
    }
    audio.hint();
    say('psst, look here!');
    draw();
  }

  function restart() {
    done = new Set();
    strokes = [];
    pops.clear();
    save();
    resetAnnounced();
    pickFirstUnfinished();
    buildPalette();
    draw();
  }

  /* ---------- gallery ---------- */
  function openGallery() {
    const grid = $('galleryGrid');
    grid.innerHTML = '';
    LEVELS.forEach((L, i) => {
      const locked = i + 1 > unlocked;
      const doneSet = new Set(saved[L.id] || []);
      const card = document.createElement('button');
      const complete = doneSet.size >= L.total;
      card.className = 'gcard' + (complete ? ' complete' : '') + (locked ? ' locked' : '');
      card.disabled = locked;
      const name = (i + 1 === LEVELS.length ? 'Master: ' : (i + 1) + '. ') + L.title;
      if (locked) {
        card.innerHTML = '<img src="gifs/stitch/lock.png" alt="locked" /><span>' + name + '</span>';
      } else {
        const t = Math.max(2, Math.floor(130 / Math.max(L.cols, L.rows)));
        const cv = document.createElement('canvas');
        cv.width = L.cols * t; cv.height = L.rows * t;
        const c2 = cv.getContext('2d');
        c2.fillStyle = '#eaf2fb';
        c2.fillRect(0, 0, cv.width, cv.height);
        L.grid.forEach((row, r) => [...row].forEach((ch, c) => {
          if (ch === '.') return;
          c2.fillStyle = doneSet.has(key(r, c)) ? L.palette['0123456789abcdefghij'.indexOf(ch)].color : '#d3deec';
          c2.fillRect(c * t, r * t, t, t);
        }));
        const pct = Math.round(doneSet.size / L.total * 100);
        card.appendChild(cv);
        const label = document.createElement('span');
        label.textContent = name;
        const p = document.createElement('span');
        p.className = 'pct';
        p.textContent = complete ? 'finished!' : pct + '%';
        card.appendChild(label);
        card.appendChild(p);
      }
      card.addEventListener('click', () => { $('gallery').hidden = true; loadLevel(i); });
      grid.appendChild(card);
    });
    $('gallery').hidden = false;
  }

  /* ---------- save picture ---------- */
  function renderPicture() {
    const cell = Math.max(14, Math.floor(640 / Math.max(level.cols, level.rows)));
    const aw = level.cols * cell, ah = level.rows * cell;
    const pad = 36, head = 74, foot = 64;
    const cv = document.createElement('canvas');
    cv.width = aw + pad * 2;
    cv.height = ah + pad * 2 + head + foot;
    const c2 = cv.getContext('2d');
    const bg = c2.createLinearGradient(0, 0, 0, cv.height);
    bg.addColorStop(0, '#bfe3ff');
    bg.addColorStop(1, '#ffe3f1');
    c2.fillStyle = bg;
    c2.fillRect(0, 0, cv.width, cv.height);

    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.fillStyle = '#ff7eb6';
    c2.font = '800 30px Nunito, sans-serif';
    c2.fillText('Cinnamoroll Cross Stitch', cv.width / 2, head / 2 + 12);

    const x0 = pad, y0 = head + pad / 2;
    c2.fillStyle = '#fff';
    c2.beginPath();
    c2.roundRect(x0 - 12, y0 - 12, aw + 24, ah + 24, 22);
    c2.fill();
    c2.save();
    c2.translate(x0, y0);
    c2.fillStyle = '#fffdf8';
    c2.fillRect(0, 0, aw, ah);
    targets.forEach(k => {
      if (!done.has(k)) return;
      const [r, c] = parse(k);
      drawStitchOn(c2, cell, r, c, level.palette[colorIdx(r, c)].color, 1);
    });
    c2.restore();

    c2.fillStyle = '#5b7fa6';
    c2.font = '800 24px Nunito, sans-serif';
    c2.fillText((levelIndex + 1 === LEVELS.length ? 'Master Level' : 'Level ' + (levelIndex + 1)) + ': ' + level.title, cv.width / 2, cv.height - foot / 2 - 6);
    return cv;
  }

  function savePicture() {
    renderPicture().toBlob(async blob => {
      if (!blob) return;
      const file = new File([blob], 'cinnamoroll-stitch-' + level.id + '.png', { type: 'image/png' });
      if (window.matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'My Cinnamoroll cross stitch' }); return; } catch (err) { /* fall through to download */ }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      say('saved! show it off~');
    }, 'image/png');
  }

  /* ---------- wiring ---------- */
  let resetTimer = null;
  $('reset').addEventListener('click', () => {
    const btn = $('reset');
    const label = $('resetLabel');
    if (!resetTimer) {
      label.textContent = 'tap again to confirm';
      btn.classList.add('armed');
      resetTimer = setTimeout(() => { label.textContent = 'start over'; btn.classList.remove('armed'); resetTimer = null; }, 3000);
      return;
    }
    clearTimeout(resetTimer);
    resetTimer = null;
    label.textContent = 'start over';
    btn.classList.remove('armed');
    restart();
  });
  $('again').addEventListener('click', restart);
  nextBtn.addEventListener('click', () => loadLevel(levelIndex + 1));
  $('undo').addEventListener('click', undo);
  $('hintMe').addEventListener('click', giveHint);
  $('zoomIn').addEventListener('click', () => setZoom(zoomIdx + 1));
  $('zoomOut').addEventListener('click', () => setZoom(zoomIdx - 1));
  $('moveBtn').addEventListener('click', () => setMove(!moveMode));
  $('galleryBtn').addEventListener('click', openGallery);
  $('galleryClose').addEventListener('click', () => { $('gallery').hidden = true; });
  $('gallery').addEventListener('click', e => { if (e.target === $('gallery')) $('gallery').hidden = true; });
  $('savePic').addEventListener('click', savePicture);

  hintBtn.addEventListener('click', () => {
    showGuide = !showGuide;
    $('guideLabel').textContent = showGuide ? 'hide guide' : 'show guide';
    hintBtn.classList.toggle('off', !showGuide);
    hintBtn.setAttribute('aria-pressed', String(showGuide));
    draw();
  });

  function syncSoundButtons() {
    $('sfxBtn').classList.toggle('off', !audio.sfxOn);
    $('sfxBtn').setAttribute('aria-pressed', String(audio.sfxOn));
    $('sfxBtn').title = 'Sound effects: ' + (audio.sfxOn ? 'on' : 'off');
    $('musicBtn').classList.toggle('off', !audio.musicOn);
    $('musicBtn').setAttribute('aria-pressed', String(audio.musicOn));
    $('musicBtn').title = 'Music: ' + (audio.musicOn ? 'on' : 'off');
  }
  $('sfxBtn').addEventListener('click', () => {
    audio.sfxOn = !audio.sfxOn;
    localStorage.setItem(SFX_KEY, audio.sfxOn ? '1' : '0');
    syncSoundButtons();
    if (audio.sfxOn) audio.pop(0);
  });
  $('musicBtn').addEventListener('click', () => {
    audio.musicOn = !audio.musicOn;
    localStorage.setItem(MUSIC_KEY, audio.musicOn ? '1' : '0');
    syncSoundButtons();
    if (audio.musicOn) audio.startMusic(); else audio.stopMusic();
  });
  syncSoundButtons();

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Escape') $('gallery').hidden = true;
  });

  // jump to the first level that isn't finished yet
  const firstOpen = LEVELS.findIndex((L, i) => i + 1 <= unlocked && (saved[L.id] || []).length < 1);
  loadLevel(Math.min(Math.max(0, firstOpen === -1 ? unlocked - 1 : firstOpen), LEVELS.length - 1));

  // intro screen
  const intro = $('intro');
  $('play').addEventListener('click', () => {
    gameStarted = true;
    $('game').hidden = false;
    $('mascot').hidden = false;
    intro.classList.add('leaving');
    setTimeout(() => intro.remove(), 500);
    audio.ensure();
    if (audio.musicOn) audio.startMusic();
    audio.pop(2);
    setTimeout(() => say('hi hi! let\'s stitch together~', 3800), 500);
  });
  $('howBtn').addEventListener('click', () => {
    const steps = $('steps');
    steps.hidden = !steps.hidden;
  });
})();
