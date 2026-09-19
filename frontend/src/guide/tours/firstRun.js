// The first-run tour. Data only: anchors from guide/anchors.js, events from
// guide/events.js. A step with no anchor is a centred card. `advanceOn` is a
// convenience — Next always works too. Start it with /?guide=first-run.

export default {
  id: "first-run",
  version: 1,
  title: "A one-minute tour",
  steps: [
    {
      id: "welcome",
      anchor: null,
      title: "Welcome to Gamma",
      body: "Papers, highlights and notes live together. Four stops, one minute. Press **Esc** at any time to leave.",
      next: "Start",
    },
    {
      id: "add",
      anchor: "header.add",
      title: "Bring in a paper",
      body: "Paste a URL, an arXiv id or a DOI, or upload a PDF. Each paper becomes a page in your library.\n\nOpen it to check this off.",
      advanceOn: { event: "popover.opened", match: { name: "add" } },
    },
    {
      id: "search",
      anchor: "header.search",
      title: "Find anything",
      body: "**Ctrl+F** searches your notes, the text inside every PDF and page titles, all at once.\n\nClick it to check this off.",
      advanceOn: { event: "popover.opened", match: { name: "search" } },
    },
    {
      id: "account",
      anchor: "header.account",
      title: "Settings and workspaces",
      body: "Themes, AI providers, workspaces and backups all start here.\n\nOpen it to check this off.",
      advanceOn: { event: "popover.opened", match: { name: "user" } },
    },
    {
      id: "done",
      anchor: null,
      title: "That's the tour",
      body: "Open a paper, select text in the PDF, and the highlight becomes a note. Run this again any time with `?guide=first-run`.",
      next: "Done",
    },
  ],
};
