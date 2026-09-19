// Decode every delivered frame in Chromium, and sample the encoded animation.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, ROOT } from './runtime.mjs';

const directory = path.join(ROOT, 'docs/assets/demos');
const scratch = path.join(ROOT, 'tmp/readme-media/qa');
fs.mkdirSync(scratch, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://localhost:9876/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Media QA</title>' }));
  await page.goto('http://localhost:9876/');
  const names = process.argv.slice(2);
  const files = fs.readdirSync(directory).filter(f => f.endsWith('.webp') && (!names.length || names.includes(f.replace(/^demo-|\.webp$/g, ''))));
  if (!files.length) throw new Error('No WebP deliverables found');
  const reports = [];
  for (const file of files) {
    const result = await page.evaluate(async base64 => {
      const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const decoder = new ImageDecoder({ data, type: 'image/webp' });
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack.frameCount;
      if (count < 2) throw new Error('Expected animation');
      const last = (await decoder.decode({ frameIndex: count - 1 })).image;
      const duration = last.timestamp + last.duration;
      last.close();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let width, height, sample = 0;
      for (let i = 0; i < count; i++) {
        const { image, complete } = await decoder.decode({ frameIndex: i });
        if (!complete || !image.duration) throw new Error(`Incomplete frame ${i}`);
        if (i === 0) {
          width = image.displayWidth; height = image.displayHeight;
          canvas.width = 1680; canvas.height = Math.round(height/width*560)*2;
        }
        const h = canvas.height/2;
        while (sample < 6 && (image.timestamp + image.duration >= duration * sample/5 || i === count - 1)) {
          ctx.drawImage(image, (sample%3)*560, Math.floor(sample/3)*h, 560, h);
          sample++;
        }
        image.close();
      }
      decoder.close();
      return { frames: count, seconds: duration/1e6, width, height, png: canvas.toDataURL('image/png').split(',')[1] };
    }, fs.readFileSync(path.join(directory, file)).toString('base64'));
    const { png, ...report } = result;
    fs.writeFileSync(path.join(scratch, file.replace('.webp', '.png')), Buffer.from(png, 'base64'));
    reports.push({ file, ...report });
    console.log(JSON.stringify(reports.at(-1)));
  }
  fs.writeFileSync(path.join(scratch, 'decode.json'), JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}
