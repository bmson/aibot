import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// SVG is the source of truth; export every platform size from the same geometry.
const root = new URL('../', import.meta.url);
const file = (path: string) => fileURLToPath(new URL(path, root));
const icons = 'apps/web/public/icons/';
const catalog = 'apps/ios/Assistant/Assets.xcassets/AppIcon.appiconset/';
const checkOnly = process.argv.includes('--check');
const outputs = new Map<string, Buffer>();
const collect = (destination: string, content: string | Buffer) => {
  outputs.set(destination, Buffer.isBuffer(content) ? content : Buffer.from(content));
};
const source = await readFile(file(`${icons}assistant-source.svg`), 'utf8');
const dark = source.replace('#217A4B', '#101712').replace('#F4FAF5', '#6FCB9C');
const darkArtwork = dark.replace(/<rect\s[^>]*\/>/, '');
const tinted = source.replace('#217A4B', '#000000').replace('#F4FAF5', '#EEEEEE');
const mark = source.match(/<path\s[\s\S]*?\/>/)?.[0];
if (!mark) throw new Error('The canonical logo must contain its vector path.');

async function png(svg: string, size: number, destination: string, transparent = false) {
  const raster = sharp(Buffer.from(svg), { density: 288 }).resize(size, size);
  if (!transparent) raster.removeAlpha();
  collect(destination, await raster.png().toBuffer());
}

await png(source, 1024, `${catalog}AppIcon-1024.png`);
await png(darkArtwork, 1024, `${catalog}AppIcon-dark-1024.png`, true);
await png(tinted, 1024, `${catalog}AppIcon-tinted-1024.png`);
await png(source, 180, 'apps/web/app/apple-icon.png');
await png(source, 192, `${icons}assistant-192.png`);
await png(source, 512, `${icons}assistant-512.png`);

// All meaningful artwork must survive the PWA maskable icon's 40% radius.
// Check the exported pixels, not a hand-maintained estimate of the path bounds.
const standard = outputs.get(`${catalog}AppIcon-1024.png`);
if (!standard) throw new Error('Missing standard app icon.');
const { data, info } = await sharp(standard).raw().toBuffer({ resolveWithObject: true });
const background = [...data.subarray(0, info.channels)];
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (Math.hypot(x - info.width / 2, y - info.height / 2) <= info.width * 0.4) continue;
    const offset = (y * info.width + x) * info.channels;
    if (background.some((channel, i) => Math.abs((data[offset + i] ?? 0) - channel) > 6)) {
      throw new Error(
        'The logo extends outside the maskable safe area; reduce or recenter the mark.',
      );
    }
  }
}
collect(
  'apps/web/app/icon.svg',
  source
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace('<rect width="1024" height="1024"', '<rect rx="224" width="1024" height="1024"'),
);
collect(
  `${icons}assistant-mark.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">\n  <title>Assistant</title>\n  ${mark.replace('#F4FAF5', 'currentColor')}\n</svg>\n`,
);
collect(
  `${catalog}Contents.json`,
  `${JSON.stringify(
    {
      images: [
        { filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
        ...['dark', 'tinted'].map((value) => ({
          appearances: [{ appearance: 'luminosity', value }],
          filename: `AppIcon-${value}-1024.png`,
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        })),
      ],
      info: { author: 'xcode', version: 1 },
    },
    null,
    2,
  )}\n`,
);

// Review actual raster outputs at home-screen and favicon sizes.
const appearances = [source, dark, tinted];
const labels = ['Standard', 'Dark preview', 'Tint source'];
let proof = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="650" viewBox="0 0 1200 650">
<rect width="1200" height="650" fill="#EEF5F0"/>
<text x="72" y="75" fill="#15201A" font-family="Helvetica, Arial, sans-serif" font-size="32" font-weight="600">Assistant</text>
<text x="72" y="109" fill="#5E7266" font-family="Helvetica, Arial, sans-serif" font-size="17">One continuous loop. A clearer identity.</text>`;
for (let i = 0; i < appearances.length; i++) {
  const svg = appearances[i];
  if (!svg) continue;
  const x = 72 + i * 372;
  for (const [size, offsetX, y] of [
    [256, 0, 153],
    [60, 0, 482],
    [32, 100, 496],
    [16, 176, 504],
  ] as const) {
    const rounded = svg.replace(
      '<rect width="1024" height="1024"',
      '<rect rx="224" width="1024" height="1024"',
    );
    const bitmap = await sharp(Buffer.from(rounded), { density: 288 })
      .resize(size, size)
      .png()
      .toBuffer();
    proof += `<image x="${x + offsetX}" y="${y}" width="${size}" height="${size}" href="data:image/png;base64,${bitmap.toString('base64')}"/>`;
  }
  proof += `<text x="${x}" y="448" fill="#15201A" font-family="Helvetica, Arial, sans-serif" font-size="20">${labels[i]}</text>
  <text x="${x}" y="581" fill="#5E7266" font-family="Helvetica, Arial, sans-serif" font-size="15">60 px</text>
  <text x="${x + 100}" y="581" fill="#5E7266" font-family="Helvetica, Arial, sans-serif" font-size="15">32 px</text>
  <text x="${x + 176}" y="581" fill="#5E7266" font-family="Helvetica, Arial, sans-serif" font-size="15">16 px</text>`;
}
proof += '</svg>';
// Font rasterization varies by host. The review sheet is not a shipping asset.
if (!checkOnly) collect('docs/brand/preview.png', await sharp(Buffer.from(proof)).png().toBuffer());

const stale: string[] = [];
let written = 0;
for (const [destination, expected] of outputs) {
  const current = await readFile(file(destination)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (current?.equals(expected)) continue;
  if (checkOnly) {
    stale.push(destination);
  } else {
    await mkdir(fileURLToPath(new URL('.', new URL(destination, root))), { recursive: true });
    await writeFile(file(destination), expected);
    written++;
  }
}
if (stale.length) {
  throw new Error(
    `Brand exports are missing or stale. Run pnpm brand:generate:\n${stale.join('\n')}`,
  );
}
console.log(
  checkOnly
    ? `Verified ${outputs.size} shipping brand assets against the canonical vector.`
    : `Generated brand assets (${written} updated; unchanged files preserved).`,
);
