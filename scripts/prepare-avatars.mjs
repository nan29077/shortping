import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const source = 'assets/source/shortping-block-avatars-sheet.png';
const output = 'public/avatars';
const columns = 6;
const rows = 5;
const cell = 229;

await mkdir(output, { recursive: true });
const metadata = await sharp(source).metadata();
if (metadata.width !== columns * cell || metadata.height !== rows * cell)
  throw new Error(`Unexpected avatar sheet size: ${metadata.width}x${metadata.height}`);

for (let row = 0; row < rows; row++) {
  for (let column = 0; column < columns; column++) {
    const number = row * columns + column + 1;
    await sharp(source)
      .extract({ left: column * cell, top: row * cell, width: cell, height: cell })
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 90, smartSubsample: true })
      .toFile(`${output}/block-${String(number).padStart(2, '0')}.webp`);
  }
}

console.log('숏핑 블록 토이 아바타 30종 생성 완료');
