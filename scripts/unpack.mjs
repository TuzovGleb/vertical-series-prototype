/* Восстанавливает data/content.json из зашифрованного data/content.enc.

   Нужно после свежего клонирования: плейнтекст в репозиторий не попадает,
   а скриптам подготовки видео он необходим.

       node scripts/unpack.mjs <пароль>
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const password = process.argv[2];
if (!password) {
  console.error('Укажите пароль:  node scripts/unpack.mjs <пароль>');
  process.exit(1);
}

const env = JSON.parse(readFileSync(join(ROOT, 'data', 'content.enc'), 'utf8'));
const salt = Buffer.from(env.salt, 'base64');
const iv = Buffer.from(env.iv, 'base64');
const payload = Buffer.from(env.ct, 'base64');

const body = payload.subarray(0, payload.length - 16);
const tag = payload.subarray(payload.length - 16);

const key = pbkdf2Sync(password, salt, env.iter, 32, 'sha256');
const decipher = createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);

let plain;
try {
  plain = Buffer.concat([decipher.update(body), decipher.final()]);
} catch {
  console.error('Не расшифровалось — неверный пароль.');
  process.exit(1);
}

writeFileSync(join(ROOT, 'data', 'content.json'), plain);
console.log(`Восстановлено: data/content.json (${plain.length} Б)`);
