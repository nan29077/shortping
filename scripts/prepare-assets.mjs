import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
mkdirSync('public/images', { recursive: true });
for (const name of ['hero', 'spring', 'shadow', 'moon', 'mascot', 'desktop-cinema']) {
  const source = `assets/source/${name}-original.png`;
  if (existsSync(source))
    await sharp(source)
      .resize({ width: 1440, withoutEnlargement: true })
      .webp({ quality: 86 })
      .toFile(`public/images/${name}.webp`);
}
for (const size of [192, 512])
  await sharp('public/icon.svg').resize(size, size).png().toFile(`public/icon-${size}.png`);
mkdirSync('public/demo', { recursive: true });
if (existsSync(ffmpeg) && existsSync('public/images/hero.webp')) {
  const r = spawnSync(
    ffmpeg,
    [
      '-y',
      '-loop',
      '1',
      '-i',
      'public/images/hero.webp',
      '-vf',
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0003,1.15)':d=300:s=540x960:fps=25,fade=t=in:st=0:d=1,fade=t=out:st=11:d=1",
      '-t',
      '12',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      'public/demo/preview.mp4',
    ],
    { stdio: 'pipe' },
  );
  if (r.status !== 0) throw new Error(r.stderr?.toString());
  console.log('12-second original image-based demo teaser generated.');
}
console.log('WebP images and PWA icons prepared.');
