/* Витрина, состояние и переход в плеер. */

(function () {

  /* Аварийный сброс: ?reset в адресе снимает service worker, чистит кэши
     и хранилище. Нужен потому, что медиа кэшируется надолго, и на телефоне
     без инструментов разработчика вычистить его иначе нечем. */
  if (/[?&]reset\b/.test(location.search)) {
    (async () => {
      try {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) { /* всё равно перезагружаемся */ }
      location.replace(location.pathname);   // без ?reset — повтора не будет
    })();
    return;
  }

  const STORE = 'sujet.state.v1';

  const state = {
    progress: {},     // id сериала → максимальный доиденный индекс серии
    unlocked: {},     // id сериала → максимальный индекс, открытый за рекламу
    allAccess: false, // куплен полный доступ
    audio: false,
    // Живёт только в памяти вкладки, в localStorage не уходит: иначе телефон,
    // на котором прототип уже открывали при подготовке, показал бы ленту без
    // подсказки — и горизонтальный свайп никто бы не нашёл.
    hintSeen: false,
    save() {
      try {
        localStorage.setItem(STORE, JSON.stringify({
          progress: this.progress, unlocked: this.unlocked, allAccess: this.allAccess,
        }));
      } catch (e) { /* приватный режим — переживём */ }
    },
    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
        this.progress = raw.progress || {};
        this.unlocked = raw.unlocked || {};
        this.allAccess = !!raw.allAccess;
      } catch (e) { /* ничего страшного */ }
    },
  };

  let content;

  /* ───────────────────────── витрина ───────────────────────── */

  let activeTrope = null;

  /* Витрина устроена как у ReelShort и DramaBox: рубрики по тропам и ряды
     подборок. Ни у того, ни у другого нет блоков «о сервисе» и преимуществ —
     каталог и есть главная страница. */

  const isOpen = (s) => !s.locked;

  function makeCard(s, index) {
    const done = state.progress[s.id] || 0;
    const card = document.createElement('button');
    card.className = 'card' + (s.locked ? ' card--locked' : '');
    card.style.setProperty('--c', s.accent);

    card.innerHTML = `
      <div class="card__fill"></div>
      <img class="card__img" alt="" loading="lazy">
      <div class="card__shade"></div>
      <div class="card__badge"></div>
      ${s.locked ? '<div class="card__lock"></div>'
                 : (done > 0 ? '<div class="card__resume"></div>' : '')}
      <div class="card__body">
        <div class="card__title"></div>
        <div class="card__meta"></div>
      </div>`;

    card.querySelector('.card__badge').textContent = s.trope || s.genre;

    card.querySelector('.card__title').textContent = s.title;
    card.querySelector('.card__meta').textContent =
      `${s.locked ? s.episodeCount : s.episodes.length} серий`;
    if (!s.locked && done > 0) {
      card.querySelector('.card__resume').textContent = `${s.episodes[done].n} серия`;
    }

    const img = card.querySelector('.card__img');
    img.addEventListener('error', () => { img.remove(); });
    img.src = s.poster;

    // Закрытые открываются так же, как остальные: у них есть своя карточка
    // с описанием, а разблокировка предлагается уже с неё.
    card.addEventListener('click', () => openSeries(index));
    return card;
  }

  function pickSeries(kind) {
    const all = content.series.map((s, i) => ({ s, i }));
    const locked = all.filter((x) => x.s.locked);
    if (kind === 'open')   return all.filter((x) => isOpen(x.s));
    if (kind === 'fresh')  return locked.slice(0, 6);
    if (kind === 'locked') return locked.slice(6);
    return all;
  }

  function renderChips() {
    const chips = document.getElementById('chips');
    const tropes = [];
    content.series.forEach((s) => {
      if (s.trope && tropes.indexOf(s.trope) === -1) tropes.push(s.trope);
    });

    chips.innerHTML = '';
    [null].concat(tropes).forEach((t) => {
      const b = document.createElement('button');
      b.className = 'chip' + (activeTrope === t ? ' on' : '');
      b.textContent = t || 'Все';
      b.addEventListener('click', () => {
        activeTrope = t;
        renderCatalog();
        document.getElementById('catalog').scrollTop = 0;
      });
      chips.appendChild(b);
    });
  }

  function renderRows() {
    const rows = document.getElementById('rows');
    const grid = document.getElementById('grid');
    rows.innerHTML = '';
    grid.innerHTML = '';

    // Выбрана рубрика — показываем плоскую сетку, иначе ряды подборок.
    if (activeTrope) {
      rows.hidden = true;
      grid.hidden = false;
      content.series.forEach((s, i) => {
        if (s.trope === activeTrope) grid.appendChild(makeCard(s, i));
      });
      return;
    }

    rows.hidden = false;
    grid.hidden = true;
    (content.service.rows || []).forEach((def) => {
      const items = pickSeries(def.pick);
      if (!items.length) return;
      const row = document.createElement('section');
      row.className = 'row';
      row.innerHTML = `
        <div class="row__head">
          <div class="row__title"></div>
          <div class="row__count"></div>
        </div>
        <div class="row__track"></div>`;
      row.querySelector('.row__title').textContent = def.title;
      row.querySelector('.row__count').textContent = `${items.length}`;
      const track = row.querySelector('.row__track');
      items.forEach((x) => track.appendChild(makeCard(x.s, x.i)));
      rows.appendChild(row);
    });
  }

  function renderCatalog() {
    document.getElementById('brand').textContent = content.service.name;
    document.getElementById('tagline').textContent = content.service.tagline;
    document.getElementById('about').textContent = content.service.about;
    document.getElementById('hintV').textContent = content.service.hint.vertical;
    document.getElementById('hintH').textContent = content.service.hint.horizontal;
    renderChips();
    renderRows();
  }

  /* ───────────────────────── переходы ───────────────────────── */

  function openSeries(i) {
    // Тап — это и есть жест, разрешающий звук. Дальше play() идёт внутри него;
    // если браузер всё равно откажет, плеер сам предложит кнопку «включить звук».
    state.audio = true;
    document.getElementById('catalog').hidden = true;
    Player.open(i);
  }

  function backToCatalog() {
    document.getElementById('catalog').hidden = false;
    renderCatalog();
  }

  /* ───────────────────────── оффлайн ───────────────────────── */

  /* Показ идёт с телефона в переговорке, где вай-фай может лечь. Поэтому после
     первой загрузки сайт утаскивает всё видео в кэш и дальше живёт без сети.
     По http в локальной сети service worker не поднимется — это нормально,
     просто останется обычная сетевая загрузка. */
  function setupOffline() {
    if (!('serviceWorker' in navigator)) return;

    const net = navigator.connection || {};
    const stingy = net.saveData || /^(slow-)?2g$/.test(net.effectiveType || '');

    navigator.serviceWorker.register('sw.js').then((reg) => {
      if (stingy) return;                    // экономия трафика — не тянем 90 МБ
      const warm = () => {
        const sw = navigator.serviceWorker.controller || reg.active;
        if (!sw) return;
        const urls = [];
        content.series.forEach((s) => {
          if (s.poster) urls.push(s.poster);
          // У закрытых сериалов серий нет — обходим без обращения к списку.
          (s.episodes || []).forEach((e) => urls.push(e.src));
        });
        sw.postMessage({ type: 'warm', urls });
      };
      if (navigator.serviceWorker.controller) warm();
      else navigator.serviceWorker.addEventListener('controllerchange', warm, { once: true });

      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'warm-done') {
          console.info(`Оффлайн-кэш готов: ${e.data.done}/${e.data.total}`);
        }
      });
    }).catch(() => { /* не поднялся — работаем по сети */ });
  }

  /* ───────────────────────── вход ───────────────────────── */

  /* Сайт лежит на публичном хостинге, поэтому парольный экран сам по себе
     ничего не закрывал бы — файлы доступны по прямым адресам. Закрыт весь
     авторский текст: каталог уезжает на сервер зашифрованным (PBKDF2 +
     AES-GCM), и пароль здесь не сверяется со строкой, а служит ключом
     расшифровки. Не подошёл — расшифровать нечем.
     Видео этим не защищено и защищено быть не может: оно лежит файлами. */

  const PASS_KEY = 'sujet.pass';
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function decryptContent(password, env) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: fromB64(env.salt), iterations: env.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function unlock(password) {
    const res = await fetch('data/content.enc');
    if (!res.ok) throw new Error('content.enc: ' + res.status);
    content = await decryptContent(password, await res.json());
    start();
  }

  function start() {
    state.load();
    document.getElementById('gate').hidden = true;
    document.getElementById('catalog').hidden = false;
    document.title = `${content.service.name} — вертикальные мини-сериалы`;
    renderCatalog();
    Paywall.init({ content, state });
    Player.init({ content, state, onExit: backToCatalog });
    setupOffline();
  }

  const form  = document.getElementById('gateForm');
  const input = document.getElementById('gatePass');
  const btn   = document.getElementById('gateBtn');
  const msg   = document.getElementById('gateMsg');

  function fail(text) {
    msg.textContent = text;
    msg.hidden = false;
    form.classList.add('is-wrong');
    setTimeout(() => form.classList.remove('is-wrong'), 400);
    btn.disabled = false;
    btn.textContent = 'Войти';
    input.select();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = input.value.trim();
    if (!pass) return;
    btn.disabled = true;
    btn.textContent = 'Проверяю…';
    msg.hidden = true;
    try {
      await unlock(pass);
      sessionStorage.setItem(PASS_KEY, pass);
    } catch (err) {
      // WebCrypto недоступен вне защищённого контекста — по http в локальной
      // сети расшифровать нечем, и дело не в пароле.
      fail(window.isSecureContext
        ? 'Неверный пароль'
        : 'Нужен https или localhost — по обычному http браузер не даёт расшифровать.');
      console.error(err);
    }
  });

  // Пароль живёт до закрытия вкладки: перезагрузка во время показа
  // не заставит вводить его заново, а на чужом устройстве он не останется.
  (async () => {
    const saved = sessionStorage.getItem(PASS_KEY);
    if (!saved) { input.focus(); return; }
    try {
      await unlock(saved);
    } catch (err) {
      sessionStorage.removeItem(PASS_KEY);
      input.focus();
    }
  })();

})();
