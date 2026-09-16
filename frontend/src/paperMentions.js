// Only trigger at a word boundary, with a collapsed caret. Queries may contain
// spaces; a completed mention uses curly quotes, which close the query.
export function mentionAt(text, start, end = start) {
  if (start !== end) return null;
  const match = /(?:^|[\s(])@([^@\n“”]*)$/.exec(text.slice(0, start));
  return match ? { start: start - match[1].length - 1, end: start, query: match[1] } : null;
}

export function insertMention(text, mention, title) {
  const label = `@“${title.replace(/[\r\n“”]+/g, " ")}” `;
  return { text: text.slice(0, mention.start) + label + text.slice(mention.end),
    caret: mention.start + label.length };
}
