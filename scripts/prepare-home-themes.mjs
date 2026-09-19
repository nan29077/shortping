import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const themes = ['cinematic', 'bright', 'fantasy', 'classic', 'medieval'];

await mkdir(path.join(root, 'public', 'images'), { recursive: true });

for (const theme of themes) {
  await sharp(path.join(root, 'assets', 'source', `home-${theme}-original.png`))
    .resize(1920, 1080, { fit: 'cover', position: 'centre' })
    .webp({ quality: 86, effort: 6 })
    .toFile(path.join(root, 'public', 'images', `home-${theme}.webp`));
}

console.log(`Prepared ${themes.length} home wallpaper themes.`);
