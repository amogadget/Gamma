// The first-run tour. Data only: anchors from guide/anchors.js, events from
// guide/events.js. A step with no anchor is a centred card. A step with `do`
// is a demo: the guide performs the actions itself (click / type / press /
// waitFor / wait), then moves on — or, with `advanceOn`, hands over to the
// user. `{demoUrl}` in typed text comes from `vars` (overridable through the
// localStorage key gamma-guide-vars). Start it from the
// account menu's Tours > Your first paper.

export default {
  id: "first-run",
  version: 2,
  title: "Your first paper",
  vars: {
    demoUrl: "https://arxiv.org/abs/1706.03762", // Attention Is All You Need
  },
  steps: [
    {
      id: "welcome",
      anchor: null,
      title: "Welcome to Gamma",
      next: "Start",
    },
    {
      id: "add-demo",
      anchor: "header.add",
      placement: "left",
      title: "Adding a paper",
      do: [
        { click: "header.add" },
        { wait: 500 },
        { type: "add.urlInput", text: "{demoUrl}" },
        { wait: 500 },
        { press: "Enter", on: "add.urlInput" },
        { waitFor: { event: "page.opened" } },
        { wait: 800 },
      ],
    },
    {
      id: "highlight-demo",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Highlight a passage",
      do: [{ previewHighlight: true }],
    },
    {
      id: "highlight",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Select text, then choose a colour",
      advanceOn: { event: "highlight.created", match: { kind: "text" } },
    },
    {
      id: "area-demo",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Highlight a figure or equation",
      do: [{ previewArea: true }],
    },
    {
      id: "area",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Ctrl-drag a box, then choose a colour",
      advanceOn: { event: "highlight.created", match: { kind: "area" } },
    },
    {
      id: "notes",
      anchor: "dock.notes",
      placement: "left",
      title: "Add a note",
      do: [{ note: "Attention compares queries with keys, then uses those scores to combine the values. Scaling keeps the scores stable." }],
    },
    {
      id: "label",
      anchor: "page.labels",
      placement: "left",
      title: "Add the llm label",
      do: [
        { click: "page.labels" },
        { type: "page.labelInput", text: "llm" },
        { press: "Enter", on: "page.labelInput" },
        { wait: 900 },
      ],
    },
    {
      id: "home",
      anchor: "header.home",
      placement: "bottom",
      title: "Back to your library",
      advanceOn: { event: "home.opened" },
      next: "Finish",
    },
  ],
};
