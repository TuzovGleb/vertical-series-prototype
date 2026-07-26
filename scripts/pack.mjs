/* Шифрует data/content.json в data/content.enc.

   Сайт лежит на публичном хостинге, и парольный экран сам по себе ничего не
   закрывает — файлы доступны по прямым адресам. Поэтому весь авторский текст
   (названия, синопсисы, сорок хуков, структура каталога) уезжает в репозиторий
   уже зашифрованным: без пароля из него ничего не достать.

   PBKDF2-SHA256 (200 000 итераций) → AES-256-GCM.

       node scripts/pack.mjs <пароль>

   Плейнтекст data/content.json остаётся только локально — он в .gitignore.
   Обратная операция: node scripts/unpack.mjs <пароль>
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = 200_000;

const password = process.argv[2];
if (!password) {
  console.error('Укажите пароль:  node scripts/pack.mjs <пароль>');
  process.exit(1);
}

const plain = readFileSync(join(ROOT, 'data', 'content.json'));
JSON.parse(plain);                       // не шифруем заведомо битый JSON

const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');

const cipher = createCipheriv('aes-256-gcm', key, iv);
const body = Buffer.concat([cipher.update(plain), cipher.final()]);

// WebCrypto ждёт тег аутентификации приклеенным к шифротексту
const payload = Buffer.concat([body, cipher.getAuthTag()]);

writeFileSync(join(ROOT, 'data', 'content.enc'), JSON.stringify({
  v: 1,
  iter: ITERATIONS,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  ct: payload.toString('base64'),
}));

console.log(`Зашифровано: ${plain.length} Б → data/content.enc (${payload.length} Б)`);
