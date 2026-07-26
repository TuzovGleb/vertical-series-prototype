/* Витрина, состояние и переход в плеер. */

(function () {

  const STORE = 'sujet.state.v1';

  const state = {
    progress: {},     // id сериала → максимальный доиденный индекс серии
    audio: false,
    // Живёт только в памяти вкладки, в localStorage не уходит: иначе телефон,
    // на котором прототип уже открывали при подготовке, показал бы ленту без
    // подсказки — и горизонтальный свайп никто бы не нашёл.
    hintSeen: false,
    save() {
      try {
        localStorage.setItem(STORE, JSON.stringify({ progress: this.progress }));
      } catch (e) { /* приватный режим — переживём */ }
    },
    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
        this.progress = raw.progress || {};
      } catch (e) { /* ничего страшного */ }
    },
  };

  let content;

  /* ───────────────────────── витрина ───────────────────────── */

  function renderCatalog() {
    document.getElementById('brand').textContent = content.service.name;
    document.getElementById('tagline').textContent = content.service.tagline;
    document.getElementById('about').textContent = content.service.about;
    document.getElementById('hintV').textContent = content.service.hint.vertical;
    document.getElementById('hintH').textContent = content.service.hint.horizontal;

    const grid = document.getElementById('grid');
    grid.innerHTML = '';

    content.series.forEach((s, i) => {
      const done = state.progress[s.id] || 0;
      const card = document.createElement('button');
      card.className = 'card';
      card.style.setProperty('--c', s.accent);
      card.innerHTML = `
        <div class="card__fill"></div>
        <img class="card__img" alt="" loading="lazy">
        <div class="card__shade"></div>
        <div class="card__badge"></div>
        ${done > 0 ? '<div class="card__resume"></div>' : ''}
        <div class="card__body">
          <div class="card__title"></div>
          <div class="card__meta"></div>
        </div>`;

      card.querySelector('.card__badge').textContent = s.genre;
      card.querySelector('.card__title').textContent = s.title;
      card.querySelector('.card__meta').textContent =
        `${s.episodes.length} серий · по минуте`;
      if (done > 0) {
        card.querySelector('.card__resume').textContent = `${s.episodes[done].n} серия`;
      }

      // Постера может ещё не быть — тогда остаётся акцентная заливка
      const img = card.querySelector('.card__img');
      img.addEventListener('error', () => { img.remove(); });
      img.src = s.poster;

      card.addEventListener('click', () => openSeries(i));
      grid.appendChild(card);
    });
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
          urls.push(s.poster);
          s.episodes.forEach((e) => urls.push(e.src));
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
