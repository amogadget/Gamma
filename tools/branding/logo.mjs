import fs from 'node:fs';
import { markSvg } from './mark.mjs';

// Shared icon-and-name layout for the standalone logo, heroes and Store posters.
export function logoSvg({ dark = false, width = 680 } = {}) {
  return fs.readFileSync(new URL('../../design/brand/compositions/logo.svg', import.meta.url), 'utf8')
    .replace('{{gamma-mark}}', markSvg(48))
    .replace('{{logo-text}}', dark ? '#f0ede6' : '#1a1a18')
    .replace('width="680" height="112"', `width="${width}" height="${width * 112 / 680}"`);
}
