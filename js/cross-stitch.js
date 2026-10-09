(() => {
  const LEVELS = window.STITCH_LEVELS;
  const SYMBOLS = ['●', '♥', '■', '▲', '◆', '★', '✿'];
  const PROGRESS_KEY = 'cinna-stitch-v2';
  const UNLOCK_KEY = 'cinna-stitch-unlocked';

  const canvas = document.getElementById('cloth');
  const ctx = canvas.getContext('2d');
  const levelsEl = document.getElementById('levels');
  const titleEl = document.getElementById('levelTitle');
  const paletteEl = document.getElementById('palette');
  const fillEl = document.getElementById('fill');
  const countEl = document.getElementById('count');
  const totalEl = document.getElementById('total');
  const doneEl = document.getElementById('done');
  const nextBtn = document.getElementById('next');
  const hintBtn = document.getElementById('hintBtn');

  let saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); // levelId -> ["r,c", ...]
  let unlocked = Number(localStorage.getItem(UNLOCK_KEY) || 1);
  let levelIndex = 0;
  let level, CELL, targets, done;
  let current = 0;
  let showGuide = true;
  let flash = null;
  let drawing = false;

  const key = (r, c) => r + ',' + c;
  const chAt = (r, c) => level.grid[r][c];
  const colorIdx = (r, c) => {
    const ch = chAt(r, c);
    return ch === '.' ? -1 : '0123456789abcdefghij'.indexOf(ch);
  };

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
    current = 0;
    titleEl.textContent = (i + 1 === LEVELS.length ? 'Master Level' : 'Level ' + (i + 1)) + ': ' + level.title;
    totalEl.textContent = targets.length;
    pickFirstUnfinished();
    buildLevelButtons();
    buildPalette();
    draw();
  }

  function remaining(idx) {
    let n = 0;
    targets.forEach(k => {
      const [r, c] = k.split(',').map(Number);
      if (colorIdx(r, c) === idx && !done.has(k)) n++;
    });
    return n;
  }

  function pickFirstUnfinished() {
    const first = level.palette.findIndex((_, i) => remaining(i) > 0);
    current = first >= 0 ? first : 0;
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
      b.addEventListener('click', () => { current = i; buildPalette(); draw(); });
      paletteEl.appendChild(b);
    });
  }

  function drawStitch(r, c, color) {
    const x = c * CELL;
    const y = r * CELL;
    const pad = Math.max(2, CELL * 0.15);
    ctx.lineCap = 'round';
    // soft shadow so pale threads stay visible on the cloth
    ctx.lineWidth = CELL * 0.26;
    ctx.strokeStyle = 'rgba(91,127,166,0.35)';
    ctx.beginPath();
    ctx.moveTo(x + pad, y + pad); ctx.lineTo(x + CELL - pad, y + CELL - pad);
    ctx.moveTo(x + CELL - pad, y + pad); ctx.lineTo(x + pad, y + CELL - pad);
    ctx.stroke();
    ctx.lineWidth = CELL * 0.18;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + pad, y + pad); ctx.lineTo(x + CELL - pad, y + CELL - pad);
    ctx.moveTo(x + CELL - pad, y + pad); ctx.lineTo(x + pad, y + CELL - pad);
    ctx.stroke();
  }

  function draw() {
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
      const [r, c] = k.split(',').map(Number);
      const idx = colorIdx(r, c);
      if (done.has(k)) {
        drawStitch(r, c, level.palette[idx].color);
      } else if (showGuide) {
        ctx.fillStyle = idx === current ? 'rgba(91,127,166,0.75)' : 'rgba(91,127,166,0.28)';
        ctx.fillText(SYMBOLS[idx % SYMBOLS.length], c * CELL + CELL / 2, r * CELL + CELL / 2 + 1);
      }
    });

    if (flash && Date.now() < flash.until) {
      const [r, c] = flash.key.split(',').map(Number);
      ctx.fillStyle = 'rgba(255, 120, 150, 0.35)';
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      requestAnimationFrame(draw);
    }

    const n = done.size;
    countEl.textContent = n;
    fillEl.style.width = (n / targets.length * 100) + '%';
    const finished = n >= targets.length;
    doneEl.hidden = !finished;
    nextBtn.hidden = levelIndex + 1 >= LEVELS.length;
  }

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
      flash = { key: k, until: Date.now() + 250 };
      draw();
      return;
    }
    done.add(k);
    save();
    if (done.size >= targets.length && levelIndex + 2 > unlocked) {
      unlocked = levelIndex + 2;
      localStorage.setItem(UNLOCK_KEY, unlocked);
      buildLevelButtons();
    }
    if (remaining(current) === 0) pickFirstUnfinished();
    buildPalette();
    draw();
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    stitch(e);
  });
  canvas.addEventListener('pointermove', e => { if (drawing) stitch(e); });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  canvas.addEventListener('pointercancel', () => { drawing = false; });

  function restart() {
    done = new Set();
    save();
    pickFirstUnfinished();
    buildPalette();
    draw();
  }
  document.getElementById('reset').addEventListener('click', restart);
  document.getElementById('again').addEventListener('click', restart);
  nextBtn.addEventListener('click', () => loadLevel(levelIndex + 1));

  hintBtn.addEventListener('click', () => {
    showGuide = !showGuide;
    hintBtn.textContent = showGuide ? 'hide guide' : 'show guide';
    draw();
  });

  // jump to the first level that isn't finished yet
  const firstOpen = LEVELS.findIndex((L, i) => i + 1 <= unlocked && (saved[L.id] || []).length < 1);
  loadLevel(Math.min(Math.max(0, firstOpen === -1 ? unlocked - 1 : firstOpen), LEVELS.length - 1));

  // intro screen
  const intro = document.getElementById('intro');
  document.getElementById('play').addEventListener('click', () => {
    document.getElementById('game').hidden = false;
    intro.classList.add('leaving');
    setTimeout(() => intro.remove(), 500);
  });
  document.getElementById('howBtn').addEventListener('click', () => {
    const steps = document.getElementById('steps');
    steps.hidden = !steps.hidden;
  });
})();
