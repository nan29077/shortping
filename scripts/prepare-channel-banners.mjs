import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const themes = ['neon', 'romance', 'noir', 'fantasy', 'atelier'];

await mkdir(path.join(root, 'public', 'images'), { recursive: true });

for (const theme of themes) {
  await sharp(path.join(root, 'assets', 'source', `channel-${theme}-original.png`))
    .resize(1800, 600, { fit: 'cover', position: 'centre' })
    .webp({ quality: 86, effort: 6 })
    .toFile(path.join(root, 'public', 'images', `channel-${theme}.webp`));
}

console.log(`Prepared ${themes.length} channel banner themes.`);
