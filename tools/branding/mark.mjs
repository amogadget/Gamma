import fs from 'node:fs';
import { svgContent } from './svg-source.mjs';

const source = fs.readFileSync(new URL('../../design/brand/marks/favicon.svg', import.meta.url), 'utf8');

// Only presentation varies: all shapes, stroke weights and colors come from the favicon.
export function markSvg(size, { bare = false, disabled = false } = {}) {
  let artwork = svgContent(source);
  if (bare) artwork = artwork.replace(/<rect\b[^>]*\bid="gamma-background"[^>]*\/>/, '');
  if (disabled) artwork = artwork.replace(/#[0-9a-f]{6}\b/gi, color => {
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const gray = Math.round(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722).toString(16).padStart(2, '0');
    return `#${gray.repeat(3)}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none">${artwork}</svg>`;
}
