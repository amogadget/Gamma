// Keep editable marks valid standalone SVGs; embed their children in layouts.
export function svgContent(svg) {
  const match = svg.trim().match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/);
  if (!match) throw new Error('Expected a complete SVG source document');
  return match[1].trim();
}
