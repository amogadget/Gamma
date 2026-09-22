import fs from 'node:fs';
import { svgContent } from './svg-source.mjs';

const source = fs.readFileSync(new URL('../../design/brand/marks/favicon.svg', import.meta.url), 'utf8');

// `bleed` (in the mark's 32-unit grid) makes a full-bleed square plate with the
// mark inset by that much: home-screen icons get their corners masked by the
// OS, so the plate must reach every edge (iOS paints transparent corners
// black), and a maskable icon keeps the mark inside the inner 80%.
// Only presentation varies: all shapes, stroke weights and colors come from the favicon.
export function markSvg(size, { bare = false, disabled = false, bleed = null } = {}) {
  let artwork = svgContent(source);
  if (bare) artwork = artwork.replace(/<rect\b[^>]*\bid="gamma-background"[^>]*\/>/, '');
  if (bleed != null) {
    const plate = artwork.match(/<rect\b[^>]*\bid="gamma-background"[^>]*\/>/)[0];
    const fill = plate.match(/\bfill="([^"]+)"/)[1];
    const edge = 32 + 2 * bleed;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-bleed} ${-bleed} ${edge} ${edge}" fill="none">`
      + `<rect x="${-bleed}" y="${-bleed}" width="${edge}" height="${edge}" fill="${fill}"/>${artwork}</svg>`;
  }
  if (disabled) artwork = artwork.replace(/#[0-9a-f]{6}\b/gi, color => {
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const gray = Math.round(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722).toString(16).padStart(2, '0');
    return `#${gray.repeat(3)}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none">${artwork}</svg>`;
}
