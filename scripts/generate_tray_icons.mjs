import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hubPublic = path.join(root, '..', 'quavence_app', 'public');
const sourceCandidates = [
  path.join(hubPublic, 'images', 'Logo1-centered-1024.png'),
  path.join(hubPublic, 'images', 'Logo1-centered-512.png'),
  path.join(hubPublic, 'images', 'Logo1.png'),
];
const sourcePath = sourceCandidates.find((candidate) => fs.existsSync(candidate));
const assetsDir = path.join(root, 'assets');

const ALPHA_THRESHOLD = 8;
const APP_PADDING = 0.10; // mark fills ~90% (10% total margin)
const TRAY_PADDING = 0.06; // mark fills ~94% (6% total margin)

const APP_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZES = [16, 20, 24, 32, 48];
const TRAY_PREVIEW_SIZES = [16, 24, 32];

function findAlphaBoundingBox(data, width, height, threshold = ALPHA_THRESHOLD) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error('No opaque pixels found in source icon');
  }

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export async function auditSourceIcon() {
  if (!sourcePath) {
    throw new Error(
      `Canonical Logo1 icon source not found. Tried:\n${sourceCandidates.map((p) => `  - ${p}`).join('\n')}\nRun quavence_app/scripts/normalize_logo1.py first.`,
    );
  }

  const meta = await sharp(sourcePath).metadata();
  const { data, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bbox = findAlphaBoundingBox(data, info.width, info.height);
  const fillW = (bbox.width / info.width) * 100;
  const fillH = (bbox.height / info.height) * 100;
  const fillMin = Math.min(fillW, fillH);
  const paddingPct = 100 - fillMin;

  const audit = {
    sourcePath,
    canvas: { width: info.width, height: info.height },
    boundingBox: bbox,
    fillPercent: {
      width: Number(fillW.toFixed(1)),
      height: Number(fillH.toFixed(1)),
      min: Number(fillMin.toFixed(1)),
    },
    transparentPaddingPercent: Number(paddingPct.toFixed(1)),
    needsTrim: fillMin < 65,
  };

  console.log('Icon source audit:');
  console.log(`  Canvas: ${audit.canvas.width}x${audit.canvas.height}`);
  console.log(`  Visible mark bbox: ${bbox.width}x${bbox.height} at (${bbox.left}, ${bbox.top})`);
  console.log(`  Mark fill: ${audit.fillPercent.min}% of canvas (padding ~${audit.transparentPaddingPercent}%)`);
  console.log(`  Trim required: ${audit.needsTrim ? 'yes' : 'no'}`);

  return { audit, bbox };
}

async function loadTrimmedMark() {
  const { audit, bbox } = await auditSourceIcon();

  if (!audit.needsTrim) {
    return sharp(sourcePath)
      .ensureAlpha()
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: sharp.kernel.lanczos3,
      });
  }

  const side = Math.max(bbox.width, bbox.height);
  const padTop = Math.floor((side - bbox.height) / 2);
  const padLeft = Math.floor((side - bbox.width) / 2);

  // Square-normalize trimmed mark, then upscale for crisp downscales.
  return sharp(sourcePath)
    .ensureAlpha()
    .extract({
      left: bbox.left,
      top: bbox.top,
      width: bbox.width,
      height: bbox.height,
    })
    .extend({
      top: padTop,
      bottom: side - bbox.height - padTop,
      left: padLeft,
      right: side - bbox.width - padLeft,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(512, 512, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    });
}

async function renderSizedIcon(trimmedMark, targetSize, paddingRatio) {
  const markSize = Math.min(
    targetSize,
    Math.max(1, Math.round(targetSize * (1 - paddingRatio))),
  );
  const resized = await trimmedMark
    .clone()
    .resize(markSize, markSize, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();

  const offset = Math.floor((targetSize - markSize) / 2);
  return sharp({
    create: {
      width: targetSize,
      height: targetSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, left: offset, top: offset }])
    .png()
    .toBuffer();
}

async function writePng(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

async function generateIcons() {
  const trimmedMark = await loadTrimmedMark();

  const appPngPaths = [];
  for (const size of APP_SIZES) {
    const buffer = await renderSizedIcon(trimmedMark, size, APP_PADDING);
    const filePath = path.join(assetsDir, `app-${size}.png`);
    await writePng(filePath, buffer);
    appPngPaths.push(filePath);
  }

  const trayPngPaths = [];
  for (const size of TRAY_SIZES) {
    const buffer = await renderSizedIcon(trimmedMark, size, TRAY_PADDING);
    const filePath = path.join(assetsDir, `tray-${size}.png`);
    await writePng(filePath, buffer);
    trayPngPaths.push(filePath);
  }

  const appIcon256 = await renderSizedIcon(trimmedMark, 256, APP_PADDING);
  await writePng(path.join(assetsDir, 'app-icon.png'), appIcon256);

  const appIcoBuffer = await pngToIco(appPngPaths);
  const trayIcoBuffer = await pngToIco(trayPngPaths);

  fs.writeFileSync(path.join(assetsDir, 'app.ico'), appIcoBuffer);
  fs.writeFileSync(path.join(assetsDir, 'tray.ico'), trayIcoBuffer);

  console.log('');
  console.log(`Wrote ${path.join(assetsDir, 'app.ico')} (${appIcoBuffer.length} bytes, sizes: ${APP_SIZES.join('/')})`);
  console.log(`Wrote ${path.join(assetsDir, 'tray.ico')} (${trayIcoBuffer.length} bytes, sizes: ${TRAY_SIZES.join('/')})`);
  console.log(`Wrote app-icon.png + tray previews (${TRAY_PREVIEW_SIZES.map((s) => `tray-${s}.png`).join(', ')})`);
}

export async function buildIconPreviewSheet() {
  const previewPath = path.join(assetsDir, 'icon-preview.png');
  const entries = [
    { label: '16 tray', size: 16, kind: 'tray' },
    { label: '20 tray', size: 20, kind: 'tray' },
    { label: '24 tray', size: 24, kind: 'tray' },
    { label: '32 tray', size: 32, kind: 'tray' },
    { label: '48 app', size: 48, kind: 'app' },
    { label: '256 app', size: 256, kind: 'app' },
  ];

  const cellPad = 16;
  const labelHeight = 28;
  const maxCell = 256 + cellPad * 2;
  const sheetWidth = entries.length * maxCell;
  const sheetHeight = maxCell + labelHeight;

  const trimmedMark = await loadTrimmedMark();
  const composites = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const padding = entry.kind === 'tray' ? TRAY_PADDING : APP_PADDING;
    const iconBuffer = await renderSizedIcon(trimmedMark, entry.size, padding);
    const cellX = i * maxCell;
    const iconOffset = Math.floor((maxCell - entry.size) / 2);
    composites.push({
      input: iconBuffer,
      left: cellX + iconOffset,
      top: iconOffset,
    });
  }

  const sheet = await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: { r: 15, g: 23, b: 42, alpha: 255 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  await writePng(previewPath, sheet);
  console.log(`Wrote ${previewPath}`);
  console.log('Preview layout: 16 tray | 20 tray | 24 tray | 32 tray -> 48 app | 256 app');
  return previewPath;
}

const mode = process.argv[2] || 'generate';

try {
  if (mode === 'preview') {
    await buildIconPreviewSheet();
  } else {
    await generateIcons();
  }
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}
