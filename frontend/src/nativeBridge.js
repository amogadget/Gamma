// A narrow handoff, not a second library. Native independently validates the
// main-frame origin, current cookies/session and server-side document identity.
export function nativePDFRequest({pageID, docID, title, user}) {
  if (![pageID, docID, user].every(value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value))) return null;
  return {
    type: "openPDF", pageID, docID, user,
    title: Array.from(String(title || "PDF").replace(/\s+/g, " ").trim()).slice(0, 120).join("") || "PDF",
  };
}
