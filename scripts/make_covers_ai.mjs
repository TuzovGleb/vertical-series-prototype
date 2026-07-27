/* Генерирует обложки для сериалов без видео.

   Ключа ни к одному платному генератору в системе нет, поэтому берём сервис,
   работающий по обычному URL без регистрации. Заодно это ровно то, о чём
   кейс: контент генерируется, а не снимается.

       node scripts/make_covers_ai.mjs          # чего не хватает
       node scripts/make_covers_ai.mjs --force  # перерисовать всё
       node scripts/make_covers_ai.mjs p04 p09  # только указанные

   Готовые кадры нормализуются под 720x1176 — тот же размер, что у обложек
   сериалов с видео. Если генерация не удалась, остаётся векторная обложка
   от scripts/make_covers.mjs.
*/
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const W = 720, H = 1176;
const MIN_BYTES = 20_000;
const TRIES = 3;

/* Сцена под каждый сюжет. Людей держим на среднем плане или силуэтом:
   лица у бесплатных моделей выходят неровно, а пустая фактурная сцена
   для постера драмы работает не хуже. */
const PROMPTS = {
  p01: 'unfinished concrete high-rise construction site at golden hour, scaffolding and tower crane, dust in the air, worker silhouette in hard hat far away, cinematic film still, moody warm light, shallow depth of field',
  p02: 'arctic oilfield camp at night in a blizzard, orange floodlight, container housing on stilts, deep snow, lonely figure walking away, cinematic film still, cold blue and amber',
  p03: 'dim soviet dormitory corridor at night, one door slightly ajar with warm light spilling onto worn linoleum, painted walls, cinematic film still, quiet and unsettling',
  p04: 'small russian village grocery store at dusk, lit shop window, wooden houses, dirt road, birch trees, cinematic film still, warm light against blue evening',
  p05: 'abandoned soviet sanatorium in thick morning fog, colonnade and empty swimming pool, wet tiles, cinematic film still, eerie pale light',
  p06: 'old russian wooden house with carved window frames, overgrown autumn garden, fallen leaves, warm evening light in the windows, cinematic film still',
  p07: 'hospital emergency corridor at night, empty gurney, cold fluorescent ceiling lights, glossy floor reflections, motion blur, cinematic film still, tense',
  p08: 'car repair garage at night, sedan raised on a lift, bright work lamp, tools and oil stains, open roller door to a wet street, cinematic film still',
  p09: 'russian factory gate at night in the rain, headlights cutting through, brick industrial buildings, 1990s mood, cinematic film still, noir',
  p10: 'empty russian school classroom at dusk, rows of desks, tall windows with snow outside, chalkboard, cinematic film still, melancholic blue light',
  p11: 'night train compartment interior, window with passing city lights, two tea glasses in metal holders on the table, cinematic film still, intimate warm lamp',
  p12: 'old hotel corridor with a long red carpet runner, floor attendant desk with a board of room keys, warm table lamp, cinematic film still',
  p13: 'two plain wedding rings resting on a stack of documents, kitchen table in morning light, calendar and a duty roster on the fridge behind, cinematic film still, warm',
};

const NEGATIVE = 'no text, no letters, no watermark, no logo, no caption';

function ffmpegPath() {
  // тот же бинарник, которым режется видео
  const out = execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
    { encoding: 'utf8' });
  return out.trim();
}

async function generate(prompt, seed, dest) {
  const url = 'https://image.pollinations.ai/prompt/'
    + encodeURIComponent(`${prompt}. ${NEGATIVE}`)
    + `?width=${W}&height=${H}&nologo=true&seed=${seed}`;

  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_BYTES) throw new Error('слишком маленький ответ');
      writeFileSync(dest, buf);
      return true;
    } catch (e) {
      console.log(`      попытка ${attempt}/${TRIES}: ${e.message}`);
      if (attempt < TRIES) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  return false;
}

function normalize(ff, src, dest) {
  execFileSync(ff, [
    '-hide_banner', '-loglevel', 'error', '-i', src,
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
    '-q:v', '4', '-y', dest,
  ]);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = new Set(args.filter((a) => !a.startsWith('--')));

const content = JSON.parse(readFileSync(join(ROOT, 'data', 'content.json'), 'utf8'));
const dir = join(ROOT, 'media', 'covers');
mkdirSync(dir, { recursive: true });
const ff = ffmpegPath();

let ok = 0, skipped = 0, failed = [];
const targets = content.series.filter((s) => s.locked && (!only.size || only.has(s.id)));

for (const s of targets) {
  const dest = join(dir, `${s.id}.jpg`);
  if (!force && existsSync(dest) && statSync(dest).size > MIN_BYTES) {
    skipped++;
    continue;
  }
  const prompt = PROMPTS[s.id];
  if (!prompt) { failed.push(`${s.id} (нет промпта)`); continue; }

  process.stdout.write(`  ${s.id}  ${s.title}\n`);
  const raw = join(dir, `_${s.id}.raw`);
  // сид из id — чтобы перезапуск давал тот же кадр
  const seed = [...s.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100000;

  if (await generate(prompt, seed, raw)) {
    normalize(ff, raw, dest);
    unlinkSync(raw);
    console.log(`      готово — ${(statSync(dest).size / 1024).toFixed(0)} КБ`);
    ok++;
  } else {
    failed.push(s.id);
  }
}

console.log(`\nСгенерировано ${ok}, пропущено готовых ${skipped}` +
            (failed.length ? `, не удалось: ${failed.join(', ')}` : ''));
