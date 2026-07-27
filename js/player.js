/* Плеер: две оси навигации.
   Вертикаль — серии внутри сериала, отдана нативному scroll-snap.
   Горизонталь — переключение сериалов, своя обработка касаний поверх.
   Смешивать их нельзя, поэтому ось жеста фиксируется на первых пикселях
   и до конца жеста не меняется. */

window.Player = (function () {

  const HOOK_LEAD   = 3.0;   // за сколько секунд до конца показывать клиффхэнгер
  const PREVIEW_MS  = 3000;  // сколько превью ждёт перед автостартом
  const OPENING_MS  = 5000;  // при открытии из витрины — дольше, описание читают
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

  /* Сериал открывается со своей карточки-описания, а не сразу с первой серии:
     иначе суть истории нигде не показывается — из витрины зритель попадал
     прямо в середину действия. Карточка сама уезжает через несколько секунд. */
  function open(si) {
    seriesIndex = si;
    epIndex = 0;
    panels = [];
    feed.innerHTML = '';
    feed.style.transform = '';
    dots.innerHTML = '';
    el('player').hidden = false;

    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncActive, 250);

    fillPreview(si);
    preview.style.transition = 'none';
    preview.style.transform = 'translateX(0px)';
    startPreviewTimer(OPENING_MS);
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
    dots.hidden = false;
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
    if (!Paywall.allowed(series(), i)) return;   // платные заранее не тянем
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
    paintDots();

    // Упёрлись в порог бесплатных — не играем, показываем разблокировку.
    if (!Paywall.allowed(series(), i)) {
      pauseAll();
      Paywall.open(seriesIndex, i, () => setActive(i, true));
      return;
    }

    // текущая и две соседние — заранее, остальные лениво
    [i - 1, i, i + 1, i + 2].forEach(ensureSrc);

    pauseAll(currentVideo());
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

    /* Платность видна прямо на карточке: метка у жанра, замок на кнопке,
       строка про порог и замки в полоске серий. Иначе закрытый сериал
       выглядел бы обычным, и монетизация всплывала бы только после нажатия. */
    const money = content.service.monetization || {};
    const done = state.progress[s.id] || 0;

    el('previewPaid').hidden = !s.locked;
    el('previewPlay').classList.toggle('preview__play--locked', !!s.locked);
    el('previewNote').hidden = !s.locked;
    if (s.locked) {
      el('previewNote').textContent =
        `Первые ${money.freeEpisodes} серий бесплатно, дальше — ${money.price} или просмотр рекламы.`;
    }

    el('previewCta').textContent = s.locked
      ? 'Открыть доступ'
      : (done > 0 ? `Продолжить с ${s.episodes[done].n} серии` : 'Смотреть');
    el('previewTimer').style.width = '0%';
    paintEpStrip(s);
    // У закрытого ленты нет — чужие точки прогресса рядом с его карточкой
    // сбивали бы с толку.
    dots.hidden = !!s.locked;
    preview.hidden = false;
  }

  /* Полоска серий — как в каталогах конкурентов: сразу видно объём сезона
     и где начинается платная часть. */
  function paintEpStrip(s) {
    const strip = el('epstrip');
    const seen = state.progress[s.id] || 0;
    strip.innerHTML = '';

    if (s.locked) {
      // Сезон у закрытых на несколько десятков серий — целиком полоска
      // не влезет. Показываем начало и остаток числом.
      const free = (content.service.monetization || {}).freeEpisodes || 8;
      const shown = Math.min(s.episodeCount, free + 3);
      for (let i = 0; i < shown; i++) {
        const cell = document.createElement('i');
        cell.className = i < free ? '' : 'paid';
        cell.innerHTML = `<span>${i + 1}</span>`;
        strip.appendChild(cell);
      }
      if (s.episodeCount > shown) {
        const rest = document.createElement('i');
        rest.className = 'more';
        rest.textContent = `+${s.episodeCount - shown}`;
        strip.appendChild(rest);
      }
      strip.hidden = false;
      return;
    }

    s.episodes.forEach((ep, i) => {
      const cell = document.createElement('i');
      const paid = !Paywall.allowed(s, i);
      cell.className = paid ? 'paid' : (i <= seen ? 'seen' : '');
      cell.innerHTML = `<span>${ep.n}</span>`;
      strip.appendChild(cell);
    });
    strip.hidden = false;
  }

  /* Отсчёт до автостарта: полоска едет CSS-переходом, а решение о старте
     принимает setTimeout. Раньше и то и другое висело на requestAnimationFrame —
     он останавливается вместе с отрисовкой, и превью зависало навсегда. */
  function startPreviewTimer(ms) {
    stopPreviewTimer();
    // У закрытого сериала запускать нечего: карточка ждёт действия зрителя,
    // а сама собой открывать оплату — навязчиво.
    if (previewTarget !== null && content.series[previewTarget].locked) return;
    const wait = ms || PREVIEW_MS;
    const bar = el('previewTimer');
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;                     // reflow, иначе перехода не будет
    bar.style.transition = `width ${wait}ms linear`;
    bar.style.width = '100%';
    previewTimer = setTimeout(commitPreview, wait);
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

    // Смотреть нечего — вместо ленты показываем разблокировку,
    // а карточка остаётся под ней.
    if (s.locked) {
      Paywall.open(si, null);
      return;
    }

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
    // Жест с открытого превью работает иначе, чем из ленты: лента в этот
    // момент уже уехала за экран, тянуть надо само превью. Режим фиксируется
    // в начале жеста и до конца не меняется.
    let fromPreview = false;

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
      fromPreview = previewTarget !== null;
      feed.style.transition = 'none';
      preview.style.transition = 'none';
      stopPreviewTimer();                  // палец на экране — отсчёт не идёт
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
          if (!fromPreview) fillPreview(neighbour(seriesIndex, dx < 0 ? 1 : -1));
        }
      }

      if (!dragging) return;
      e.preventDefault();
      const dir = dx < 0 ? 1 : -1;

      if (fromPreview) {
        preview.style.transform = `translateX(${dx}px)`;
        return;
      }

      // палец сменил направление — перекладываем превью на другую сторону
      const want = neighbour(seriesIndex, dir);
      if (previewTarget !== want) fillPreview(want);
      if (preview.hidden) return;
      feed.style.transform = `translateX(${dx}px)`;
      preview.style.transform = `translateX(${dx + dir * w}px)`;
    }, { passive: false });

    stage.addEventListener('touchend', (e) => {
      const touch = e.changedTouches && e.changedTouches[0];
      const dx = touch ? touch.clientX - x0 : 0;

      if (!dragging) {
        // Именно !== null: индекс сериала бывает нулём, и проверка на
        // истинность приняла бы открытое превью первого сериала за его отсутствие.
        if (!moved && previewTarget === null) togglePause();
        // Палец ушёл, ничего не выбрав — отсчёт превью надо вернуть,
        // иначе оно зависнет навсегда.
        if (previewTarget !== null) startPreviewTimer();
        reset();
        return;
      }

      const dir = dx < 0 ? 1 : -1;
      const enough = Math.abs(dx) > w * SWIPE_PART;
      feed.style.transition = 'transform .28s cubic-bezier(.22,.61,.36,1)';
      preview.style.transition = feed.style.transition;

      if (fromPreview) {
        if (enough) goSeries(dir);           // листаем на соседнее описание
        else { preview.style.transform = 'translateX(0px)'; startPreviewTimer(); }
      } else if (enough) {
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

  /* Свайп идёт по всему каталогу, включая закрытые: у них есть своя
     карточка с описанием, а ленту им никто не строит. */
  function neighbour(from, dir) {
    const n = content.series.length;
    return ((from + dir) % n + n) % n;
  }

  /** Переход к соседнему сериалу без жеста (конец сериала, клавиатура). */
  function goSeries(dir) {
    const w = stage.clientWidth;

    // Уже стоим в превью — лента отъехала, двигать её незачем. Считаем
    // соседа от previewTarget, а не от seriesIndex: тот ещё не сменился, и
    // листание топталось бы между двумя одними и теми же сериалами.
    if (previewTarget !== null) {
      const next = neighbour(previewTarget, dir);
      preview.style.transition = 'transform .15s ease-in';
      preview.style.transform = `translateX(${-dir * w * 0.4}px)`;
      setTimeout(() => {
        fillPreview(next);
        preview.style.transition = 'none';
        preview.style.transform = `translateX(${dir * w}px)`;
        void preview.offsetWidth;
        preview.style.transition = 'transform .26s cubic-bezier(.22,.61,.36,1)';
        preview.style.transform = 'translateX(0px)';
        startPreviewTimer();
      }, 150);
      return;
    }

    fillPreview(neighbour(seriesIndex, dir));
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
