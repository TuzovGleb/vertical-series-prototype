/* Плеер: две оси навигации.
   Вертикаль — серии внутри сериала, отдана нативному scroll-snap.
   Горизонталь — переключение сериалов, своя обработка касаний поверх.
   Смешивать их нельзя, поэтому ось жеста фиксируется на первых пикселях
   и до конца жеста не меняется. */

window.Player = (function () {

  const HOOK_LEAD   = 3.0;   // за сколько секунд до конца показывать клиффхэнгер
  const PREVIEW_MS  = 3000;  // сколько превью ждёт перед автостартом
  const AXIS_BIAS   = 1.4;   // насколько горизонталь должна перевесить вертикаль
  const SWIPE_PART  = 0.22;  // доля ширины, после которой свайп засчитан

  let content, state, onExit;
  let stage, feed, preview, dots, soundBtn, hintEl;

  let seriesIndex = 0;
  let epIndex     = 0;
  let panels      = [];
  let scrollTimer = null;
  let syncTimer   = null;
  let glideTimer  = null;

  let previewTarget = null;   // индекс сериала, показанного в превью
  let previewTimer  = null;

  const el = (id) => document.getElementById(id);
  const series = () => content.series[seriesIndex];

  /* ───────────────────────── инициализация ───────────────────────── */

  function init(opts) {
    content = opts.content;
    state   = opts.state;
    onExit  = opts.onExit;

    stage    = el('stage');
    feed     = el('feed');
    preview  = el('preview');
    dots     = el('dots');
    soundBtn = el('sound');
    hintEl   = el('hint');

    el('back').addEventListener('click', close);
    el('previewPlay').addEventListener('click', (e) => {
      e.stopPropagation();
      commitPreview();
    });
    // stopPropagation обязателен: без него клик всплывёт до stage уже после
    // того, как commitPreview обнулит previewTarget, и обработчик паузы
    // немедленно остановит только что запущенную серию.
    preview.addEventListener('click', (e) => {
      e.stopPropagation();
      commitPreview();
    });
    soundBtn.addEventListener('click', () => {
      state.audio = true;
      soundBtn.hidden = true;
      const v = currentVideo();
      if (v) { v.muted = false; v.play().catch(() => {}); }
    });

    // Активная серия считается по позиции скролла: со scroll-snap она кратна
    // высоте панели, то есть это точный расчёт, а не эвристика.
    // Событие scroll — основной путь, оно мгновенное и бесплатное. Но и scroll,
    // и IntersectionObserver диспатчатся в цикле отрисовки и замолкают, если
    // вкладка не композитит кадры. Для демонстрации, которую нельзя переиграть,
    // одного такого пути мало — поэтому позиция ещё и опрашивается по таймеру.
    feed.addEventListener('scroll', () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(syncActive, 80);
    }, { passive: true });

    bindGestures();
    document.addEventListener('keydown', onKey);
  }

  /* ───────────────────────── открытие и закрытие ───────────────────────── */

  function open(si, ei) {
    seriesIndex = si;
    epIndex = ei || 0;
    el('player').hidden = false;
    buildFeed();
    scrollToEpisode(epIndex, 'instant');
    setActive(epIndex, true);
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncActive, 250);
    if (!state.hintSeen) showHint();
  }

  /** Приводит активную серию в соответствие с позицией ленты. */
  function syncActive() {
    if (el('player').hidden || previewTarget !== null) return;
    const h = feed.clientHeight;
    if (h) setActive(Math.round(feed.scrollTop / h));
  }

  function close() {
    stopPreview();
    pauseAll();
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    el('player').hidden = true;
    feed.innerHTML = '';
    panels = [];
    onExit && onExit();
  }

  /* ───────────────────────── лента серий ───────────────────────── */

  function buildFeed() {
    const s = series();
    feed.style.setProperty('--c', s.accent);
    feed.innerHTML = '';

    panels = s.episodes.map((ep, i) => {
      const node = document.createElement('article');
      node.className = 'ep';
      node.innerHTML = `
        <video class="ep__video" playsinline preload="none" muted></video>
        <div class="ep__shade"></div>
        <div class="ep__pause"></div>
        <div class="ep__hook"><span></span></div>
        <div class="ep__meta">
          <div class="ep__series"></div>
          <div class="ep__title"></div>
        </div>
        <div class="ep__bar"><i></i></div>`;
      node.querySelector('.ep__hook span').textContent = ep.hook;
      node.querySelector('.ep__series').textContent = s.title;
      node.querySelector('.ep__title').textContent = `Серия ${ep.n} · ${ep.title}`;

      const v = node.querySelector('video');
      v.dataset.src = ep.src;
      const paint = () => onTime(node, v);
      v.addEventListener('timeupdate', paint);
      v.addEventListener('seeked', paint);
      v.addEventListener('loadedmetadata', paint);
      v.addEventListener('ended', () => onEnded(i));
      // Если файл не открылся, лента не должна вставать — уходим дальше.
      v.addEventListener('error', () => {
        if (panels.indexOf(node) !== epIndex) return;
        setTimeout(() => { if (panels.indexOf(node) === epIndex) onEnded(epIndex); }, 600);
      });

      feed.appendChild(node);
      return node;
    });

    buildDots(s.episodes.length);
  }

  function buildDots(n) {
    dots.innerHTML = '';
    for (let i = 0; i < n; i++) dots.appendChild(document.createElement('i'));
  }

  function paintDots() {
    [...dots.children].forEach((d, i) => {
      d.classList.toggle('on', i === epIndex);
      d.classList.toggle('seen', i < epIndex);
    });
  }

  /* ───────────────────────── воспроизведение ───────────────────────── */

  function ensureSrc(i) {
    const p = panels[i];
    if (!p) return;
    const v = p.querySelector('video');
    if (!v.src && v.dataset.src) {
      v.src = v.dataset.src;
      v.preload = 'auto';
    }
  }

  function currentVideo() {
    return panels[epIndex] ? panels[epIndex].querySelector('video') : null;
  }

  function pauseAll(except) {
    panels.forEach((p) => {
      const v = p.querySelector('video');
      if (v !== except && !v.paused) v.pause();
      p.classList.remove('is-hooked', 'is-paused');
    });
  }

  function setActive(i, force) {
    if (i < 0 || i >= panels.length) return;
    // Тот же индекс — выходим молча. Иначе повторный вызов от скролла
    // перемотал бы уже идущую серию на начало.
    if (i === epIndex && !force) return;
    epIndex = i;

    // текущая и две соседние — заранее, остальные лениво
    [i - 1, i, i + 1, i + 2].forEach(ensureSrc);

    pauseAll(currentVideo());
    paintDots();
    restart();

    const id = series().id;
    state.progress[id] = Math.max(state.progress[id] || 0, i);
    state.save && state.save();
  }

  /** Ставит серию на начало и запускает — при переходе на неё. */
  function restart() {
    const v = currentVideo();
    if (!v) return;
    if (v.currentTime > 0.2) v.currentTime = 0;
    panels[epIndex].classList.remove('is-hooked', 'is-paused');
    play();
  }

  function play() {
    const v = currentVideo();
    if (!v) return;
    v.muted = !state.audio;
    const p = v.play();
    if (p && p.catch) {
      p.catch(() => {
        // Браузер не пустил со звуком — играем без него и предлагаем включить
        v.muted = true;
        state.audio = false;
        soundBtn.hidden = false;
        v.play().catch(() => {});
      });
    }
  }

  function onTime(node, v) {
    if (!v.duration) return;
    const bar = node.querySelector('.ep__bar i');
    bar.style.width = (v.currentTime / v.duration * 100) + '%';
    node.classList.toggle('is-hooked', v.duration - v.currentTime <= HOOK_LEAD);
  }

  function onEnded(i) {
    if (i !== epIndex) return;
    if (i + 1 < panels.length) scrollToEpisode(i + 1, 'smooth');
    else goSeries(1);                    // сериал кончился — предлагаем следующий
  }

  function scrollToEpisode(i, behavior) {
    const target = Math.max(0, Math.min(i, panels.length - 1)) * feed.clientHeight;
    feed.scrollTo({ top: target, behavior: behavior || 'smooth' });
    if (behavior === 'instant') { syncActive(); return; }

    // Плавный скролл проигрывается в цикле отрисовки и может не тронуться
    // с места, если кадры не рисуются. Автопереход между сериями — сердце
    // формата, поэтому если через 420 мс лента не доехала, доводим жёстко.
    clearTimeout(glideTimer);
    glideTimer = setTimeout(() => {
      if (Math.abs(feed.scrollTop - target) > 4) feed.scrollTop = target;
      syncActive();
    }, 420);
  }

  function togglePause() {
    const v = currentVideo();
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); panels[epIndex].classList.remove('is-paused'); }
    else          { v.pause();                panels[epIndex].classList.add('is-paused'); }
  }

  /* ───────────────────────── превью сериала ───────────────────────── */

  function fillPreview(si) {
    const s = content.series[si];
    previewTarget = si;
    preview.style.setProperty('--c', s.accent);
    // Постер — верхним слоем, акцентный градиент под ним: он виден только
    // если постера ещё нет. В обратном порядке градиент закрыл бы картинку.
    el('previewBg').style.backgroundImage =
      `url("${s.poster}"), linear-gradient(160deg, ${s.accent}, #101016)`;
    el('previewGenre').textContent = s.genre;
    el('previewTitle').textContent = s.title;
    el('previewSynopsis').textContent = s.synopsis;

    const done = state.progress[s.id] || 0;
    el('previewCta').textContent = done > 0
      ? `Продолжить с ${s.episodes[done].n} серии`
      : 'Смотреть';
    el('previewTimer').style.width = '0%';
    preview.hidden = false;
  }

  /* Отсчёт до автостарта: полоска едет CSS-переходом, а решение о старте
     принимает setTimeout. Раньше и то и другое висело на requestAnimationFrame —
     он останавливается вместе с отрисовкой, и превью зависало навсегда. */
  function startPreviewTimer() {
    stopPreviewTimer();
    const bar = el('previewTimer');
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;                     // reflow, иначе перехода не будет
    bar.style.transition = `width ${PREVIEW_MS}ms linear`;
    bar.style.width = '100%';
    previewTimer = setTimeout(commitPreview, PREVIEW_MS);
  }

  function stopPreviewTimer() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    const bar = el('previewTimer');
    bar.style.transition = 'none';
    bar.style.width = '0%';
  }

  function stopPreview() {
    stopPreviewTimer();
    preview.hidden = true;
    preview.style.transform = '';
    previewTarget = null;
  }

  /** Превью отработало — показываем сериал. */
  function commitPreview() {
    if (previewTarget === null) return;
    stopPreviewTimer();
    const si = previewTarget;
    const s = content.series[si];
    const start = state.progress[s.id] || 0;

    seriesIndex = si;
    buildFeed();
    feed.style.transform = '';
    scrollToEpisode(start, 'instant');
    setActive(start, true);

    preview.hidden = true;
    preview.style.transform = '';
    previewTarget = null;
  }

  /* ───────────────────────── жесты ───────────────────────── */

  function bindGestures() {
    let x0 = 0, y0 = 0, axis = null, dragging = false, moved = false, w = 0;

    const reset = () => {
      axis = null; dragging = false;
      feed.style.touchAction = '';
      feed.style.transition = '';
      preview.style.transition = '';
    };

    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      w = stage.clientWidth;
      axis = null; dragging = false; moved = false;
      feed.style.transition = 'none';
      preview.style.transition = 'none';
      stopPreviewTimer();
    }, { passive: true });

    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;

      if (axis === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        axis = Math.abs(dx) > Math.abs(dy) * AXIS_BIAS ? 'x' : 'y';
        if (axis === 'x') {
          dragging = true;
          feed.style.touchAction = 'none';   // дальше вертикаль не вмешивается
          const dir = dx < 0 ? 1 : -1;
          fillPreview(wrap(seriesIndex + dir));
        }
      }

      if (!dragging) return;
      e.preventDefault();
      const dir = dx < 0 ? 1 : -1;
      // если палец сменил направление — перекладываем превью на другую сторону
      if ((dir === 1 && previewTarget !== wrap(seriesIndex + 1)) ||
          (dir === -1 && previewTarget !== wrap(seriesIndex - 1))) {
        fillPreview(wrap(seriesIndex + dir));
      }
      if (preview.hidden) return;
      feed.style.transform = `translateX(${dx}px)`;
      preview.style.transform = `translateX(${dx + dir * w}px)`;
    }, { passive: false });

    stage.addEventListener('touchend', (e) => {
      if (!dragging) {
        // Именно !== null: индекс сериала бывает нулём, и проверка на
        // истинность приняла бы открытое превью первого сериала за его отсутствие.
        if (!moved && previewTarget === null) togglePause();
        reset();
        return;
      }
      const dx = (e.changedTouches[0] || {}).clientX - x0;
      const dir = dx < 0 ? 1 : -1;
      feed.style.transition = 'transform .28s cubic-bezier(.22,.61,.36,1)';
      preview.style.transition = feed.style.transition;

      if (Math.abs(dx) > w * SWIPE_PART) {
        feed.style.transform = `translateX(${-dir * w}px)`;
        preview.style.transform = 'translateX(0px)';
        pauseAll();
        startPreviewTimer();
      } else {
        feed.style.transform = 'translateX(0px)';
        preview.style.transform = `translateX(${dir * w}px)`;
        setTimeout(() => { if (!previewTimer) stopPreview(); }, 280);
      }
      dragging = false;
      feed.style.touchAction = '';
    });

    stage.addEventListener('click', (e) => {
      if (previewTarget !== null || moved) return;
      if (e.target.closest('button')) return;
      togglePause();
    });
  }

  const wrap = (i) => (i + content.series.length) % content.series.length;

  /** Переход к соседнему сериалу без жеста (конец сериала, клавиатура). */
  function goSeries(dir) {
    const w = stage.clientWidth;

    // Уже стоим в превью — лента отъехала, двигать её незачем.
    // Просто перекладываем превью на соседний сериал и заводим отсчёт заново.
    if (previewTarget !== null) {
      fillPreview(wrap(previewTarget + dir));
      preview.style.transition = 'none';
      preview.style.transform = 'translateX(0px)';
      startPreviewTimer();
      return;
    }

    fillPreview(wrap(seriesIndex + dir));
    preview.style.transition = 'none';
    preview.style.transform = `translateX(${dir * w}px)`;
    void preview.offsetWidth;      // reflow: разводит стартовое и конечное состояние

    feed.style.transition = 'transform .3s cubic-bezier(.22,.61,.36,1)';
    preview.style.transition = feed.style.transition;
    feed.style.transform = `translateX(${-dir * w}px)`;
    preview.style.transform = 'translateX(0px)';
    pauseAll();
    startPreviewTimer();
  }

  /* ───────────────────────── подсказка и клавиатура ───────────────────────── */

  function showHint() {
    hintEl.hidden = false;
    hintEl.classList.remove('is-out');
    setTimeout(() => {
      hintEl.classList.add('is-out');
      setTimeout(() => { hintEl.hidden = true; }, 400);
    }, 2600);
    state.hintSeen = true;
    state.save && state.save();
  }

  function onKey(e) {
    if (el('player').hidden) return;
    const k = e.key;
    if (k === 'Escape')     { close(); }
    else if (k === 'ArrowDown')  { previewTarget !== null ? commitPreview() : scrollToEpisode(epIndex + 1); }
    else if (k === 'ArrowUp')    { previewTarget !== null ? commitPreview() : scrollToEpisode(epIndex - 1); }
    else if (k === 'ArrowRight') { goSeries(1); }
    else if (k === 'ArrowLeft')  { goSeries(-1); }
    else if (k === ' ')          { e.preventDefault(); previewTarget !== null ? commitPreview() : togglePause(); }
  }

  /** Внутреннее состояние — для проверки на устройстве, где отладчика нет. */
  function debug() {
    const v = currentVideo();
    return {
      series: seriesIndex, episode: epIndex, previewTarget,
      scrollTop: feed.scrollTop, panelH: feed.clientHeight,
      panels: panels.length,
      video: v ? { t: +v.currentTime.toFixed(2), dur: v.duration, paused: v.paused, muted: v.muted } : null,
    };
  }

  return { init, open, close, debug };
})();
