/* Рисует обложки для сериалов без видео.

   Ключа для генерации изображений нет, а брать чужие кадры для собственных
   русских сюжетов бессмысленно — это ровно то, от чего сервис уходит.
   Поэтому обложки векторные: шесть разных композиций, палитра из акцента
   сериала, название набрано прямо в картинке.

       node scripts/make_covers.mjs

   Кладёт media/covers/<id>.svg для каждого сериала с locked: true.
*/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 720, H = 1176;

/* ── палитра из одного акцента ── */

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v)))
  .toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => rgb2hex(hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * t));

const shade = (accent) => ({
  deep:  mix(accent, '#07070c', 0.62),
  base:  mix(accent, '#0d0d14', 0.28),
  lift:  mix(accent, '#ffffff', 0.20),
  glow:  mix(accent, '#ffffff', 0.42),
  ink:   mix(accent, '#05050a', 0.80),
});

/* ── перенос названия по строкам ── */

function wrap(text, perLine) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > perLine && line) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── шесть композиций ── */

const motifs = {
  // Диагональные полосы — «движение», для дороги и возвращения
  stripes: (c) => `
    <g opacity=".5">
      ${[0, 1, 2, 3, 4, 5].map((i) => `
      <rect x="${-260 + i * 150}" y="-200" width="54" height="1700"
            fill="${i % 2 ? c.glow : c.lift}" opacity="${0.10 + i * 0.045}"
            transform="rotate(24 360 588)"/>`).join('')}
    </g>`,

  // Светило за горизонтом — для мистики и севера
  orb: (c) => `
    <circle cx="360" cy="430" r="215" fill="url(#orb)"/>
    <circle cx="360" cy="430" r="215" fill="none" stroke="${c.glow}" stroke-width="1.5" opacity=".55"/>
    <circle cx="360" cy="430" r="290" fill="none" stroke="${c.lift}" stroke-width="1" opacity=".25"/>`,

  // Горизонтальные жалюзи — для больницы, гостиницы, общежития
  blinds: (c) => `
    <g opacity=".42">
      ${Array.from({ length: 17 }, (_, i) => `
      <rect x="0" y="${120 + i * 40}" width="720" height="13"
            fill="${c.lift}" opacity="${0.5 - i * 0.026}"/>`).join('')}
    </g>`,

  // Концентрические арки — для семейных историй
  arcs: (c) => `
    <g fill="none" opacity=".5">
      ${[130, 210, 290, 370, 450].map((r, i) => `
      <path d="M ${360 - r} 560 A ${r} ${r} 0 0 1 ${360 + r} 560"
            stroke="${i % 2 ? c.glow : c.lift}" stroke-width="${2.5 - i * 0.3}"
            opacity="${0.65 - i * 0.1}"/>`).join('')}
    </g>`,

  // Уходящая перспектива — для стройки, завода, провинции
  grid: (c) => `
    <g opacity=".38">
      ${Array.from({ length: 11 }, (_, i) => `
      <line x1="${-200 + i * 112}" y1="760" x2="360" y2="300"
            stroke="${c.lift}" stroke-width="1.4" opacity="${0.7 - Math.abs(i - 5) * 0.09}"/>`).join('')}
      ${[300, 360, 440, 545, 680].map((y, i) => `
      <line x1="0" y1="${y}" x2="720" y2="${y}"
            stroke="${c.glow}" stroke-width="1" opacity="${0.2 + i * 0.09}"/>`).join('')}
    </g>`,

  // Мягкие пятна — силуэт, для романтики
  blobs: (c) => `
    <g opacity=".62" filter="url(#soft)">
      <ellipse cx="250" cy="420" rx="150" ry="205" fill="${c.lift}" opacity=".5"/>
      <ellipse cx="470" cy="520" rx="120" ry="175" fill="${c.glow}" opacity=".38"/>
      <ellipse cx="360" cy="300" rx="200" ry="120" fill="${c.lift}" opacity=".22"/>
    </g>`,
};

const ORDER = ['grid', 'orb', 'blinds', 'grid', 'orb', 'arcs',
               'blinds', 'blobs', 'stripes', 'grid', 'stripes', 'blinds', 'blobs'];

/* ── сборка ── */

function cover(s, i) {
  const c = shade(s.accent);
  const motif = motifs[ORDER[i % ORDER.length]] || motifs.orb;

  const lines = wrap(s.title.toUpperCase(), 12);

  // Кегль подбирается под самую длинную строку: заглавная кириллица шире
  // латиницы, и на фиксированном размере длинные названия уезжали за край.
  // 0.74 — замеренная в браузере ширина заглавной кириллицы в долях кегля
  // для системного шрифта сайта; худший случай дают Ж, Ю, Щ, М.
  const MARGIN = 52, CAP = 0.74;
  let size = 78;
  while (size > 32 &&
         Math.max(...lines.map((l) => l.length * CAP * size)) > W - MARGIN * 2) {
    size -= 2;
  }

  // Текст держим в средней трети: низ перекрывают затемнение карточки
  // и её собственные подписи.
  const top = 648 - (lines.length - 1) * (size + 8);

  const title = lines.map((ln, k) => `
    <text x="${MARGIN}" y="${top + k * (size + 8)}" font-size="${size}" font-weight="800"
          letter-spacing="-1" fill="#fff">${esc(ln)}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"
     font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${c.base}"/>
      <stop offset="1" stop-color="${c.deep}"/>
    </linearGradient>
    <radialGradient id="orb" cx="50%" cy="50%">
      <stop offset="0" stop-color="${c.glow}" stop-opacity=".85"/>
      <stop offset="1" stop-color="${c.glow}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.ink}" stop-opacity="0"/>
      <stop offset="0.55" stop-color="${c.ink}" stop-opacity=".72"/>
      <stop offset="1" stop-color="${c.ink}" stop-opacity=".97"/>
    </linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="55"/></filter>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${motif(c)}
  <rect width="${W}" height="${H}" filter="url(#grain)" opacity=".05"/>
  <rect y="${Math.round(H * 0.42)}" width="${W}" height="${Math.round(H * 0.58)}" fill="url(#fade)"/>

  ${title}
</svg>
`;
}

const content = JSON.parse(readFileSync(join(ROOT, 'data', 'content.json'), 'utf8'));
const dir = join(ROOT, 'media', 'covers');
mkdirSync(dir, { recursive: true });

let made = 0;
content.series.filter((s) => s.locked).forEach((s, i) => {
  writeFileSync(join(dir, `${s.id}.svg`), cover(s, i));
  made++;
  console.log(`  ${s.id}  ${ORDER[i % ORDER.length].padEnd(8)} ${s.title}`);
});
console.log(`\nОбложек нарисовано: ${made}`);
