// thumbs.js - small preview images for project cards (browser only). Failure is fine: the card shows an icon instead.
const W = 160;

async function toJpeg(canvas) {
  return new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.7));
}

export async function makeThumb(item, engines) {
  if (!item?.file) return null;
  if (item.isImage) {
    const bmp = await createImageBitmap(item.file, { resizeWidth: W, resizeQuality: 'medium' });
    try {
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0);
      return await toJpeg(c);
    } finally { bmp.close?.(); }
  }
  const doc = await engines.pdf.open(new Uint8Array(await item.file.arrayBuffer()));
  try {
    const canvas = await doc.renderPage(0, { rotation: 0, maxPixels: 60_000 });
    return await toJpeg(canvas);
  } finally { await doc.destroy?.(); }
}
