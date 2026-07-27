/* Оффлайн-кэш прототипа.

   Смысл один: демонстрация идёт с телефона в переговорке, и если там ляжет
   вай-фай, показывать будет нечего. Открыли сайт заранее — дальше он работает
   без сети.

   Оболочка (html/css/js/json) — network-first: правки кода всегда доезжают.
   Медиа — cache-first: файлы неизменны и тяжелы, тянуть их повторно незачем. */

const CACHE = 'sujet-v4';

const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/player.js',
  'js/paywall.js',
  'data/content.enc',
];

/* Видео и картинки кэшируются по-разному, и это не придирка.

   Видео за всю жизнь прототипа не меняется, зато весит десятки мегабайт —
   ему подходит cache-first: взяли из кэша и в сеть не ходим.

   Обложки, наоборот, перерисовываются на каждой итерации, а имя файла
   остаётся прежним. При cache-first такая картинка застревала в кэше
   навсегда, и обычная перезагрузка её не пробивала. Поэтому у картинок
   stale-while-revalidate: отдаём кэш сразу, а следом тихо тянем свежую
   и кладём на место — на следующем открытии будет новая. */
const isVideo = (url) => /\.mp4$/i.test(url);
const isImage = (url) => /\.(jpg|jpeg|png|webp|svg)$/i.test(url);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})            // не даём установке упасть из-за одного файла
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Запросы с Range класть в кэш нельзя — ответ будет частичным (206),
  // и отданный из кэша кусок сломает воспроизведение.
  const ranged = req.headers.has('range');

  const store = (res) => {
    if (res && res.status === 200 && !ranged) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  };

  if (isVideo(url.pathname)) {
    e.respondWith(
      caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then(store))
    );
    return;
  }

  if (isImage(url.pathname)) {
    e.respondWith(
      caches.match(req, { ignoreVary: true }).then((hit) => {
        const fresh = fetch(req).then(store).catch(() => hit);
        if (hit) e.waitUntil(fresh);   // обновляем в фоне, ответ не задерживаем
        return hit || fresh;
      })
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreVary: true }))
  );
});

/* Прогрев: страница просит заранее утащить в кэш всё видео, чтобы к показу
   ничего не догружалось. Тянем по одному, чтобы не забить канал. */
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'warm' || !Array.isArray(e.data.urls)) return;

  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let done = 0;
    for (const u of e.data.urls) {
      try {
        if (!(await cache.match(u, { ignoreVary: true }))) {
          const res = await fetch(u);
          if (res.status === 200) await cache.put(u, res);
        }
        done++;
      } catch (err) { /* пропускаем — прогрев не обязан быть полным */ }
    }
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.postMessage({ type: 'warm-done', done, total: e.data.urls.length }));
  })());
});
