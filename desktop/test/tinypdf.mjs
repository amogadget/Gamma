// A real one-page PDF, built here rather than committed as a binary fixture.
// Small enough to read, and valid enough that pdf.js renders it and extracts
// its text — which is what the viewer smoke test actually checks.

/** @param {string} text drawn on the page in 24pt Helvetica */
export function tinyPdf(text = "Gamma") {
  const content = `BT /F1 24 Tf 30 120 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  body +=
    xref +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(body, "latin1");
}
