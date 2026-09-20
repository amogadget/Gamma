// The first-run tour. Data only: anchors from guide/anchors.js, events from
// guide/events.js. A step with no anchor is a centred card. A step with `do`
// is a demo: the guide performs the actions itself (click / type / press /
// waitFor / wait), then moves on — or, with `advanceOn`, hands over to the
// user. `{demoUrl}` in typed text comes from `vars` (overridable through the
// localStorage key gamma-guide-vars). Start it with /?guide=first-run or the
// account menu's "Take the tour".

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
      body: "Let's read a paper together. I'll open one for you, then you take over. About a minute. **Esc** leaves at any time.",
      next: "Start",
    },
    {
      id: "add-demo",
      anchor: "header.add",
      placement: "left",
      title: "Adding a paper",
      body: "Watch: paste the arXiv link for *Attention Is All You Need*, then Enter. If it's already in your library, we'll open your copy. You can also add a DOI, a PDF link or a dropped file.",
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
      body: "Watch the pointer drag across the text, then move to a colour. Choosing a colour saves the passage as a highlight and a note you can write under.",
      do: [{ previewHighlight: true }],
    },
    {
      id: "highlight",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Now you: highlight something",
      body: "The paper is on the left, your notes on the right. Select any sentence in the PDF and pick a colour. The highlight becomes a note block you can write under.",
      advanceOn: { event: "highlight.created", match: { kind: "text" } },
    },
    {
      id: "area-demo",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Highlight a figure or equation",
      body: "Watch the pointer frame the attention equation. Hold **Ctrl** and drag a box, then choose a colour to save a figure or formula. On a phone, switch to rectangle mode first.",
      do: [{ previewArea: true }],
    },
    {
      id: "area",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Now you: draw a box",
      body: "Hold **Ctrl**, drag a box on the PDF, release, and pick a colour. Use it for figures, equations, or text in scanned papers. On a phone, use rectangle mode.",
      advanceOn: { event: "highlight.created", match: { kind: "area" } },
    },
    {
      id: "notes",
      anchor: "dock.notes",
      placement: "left",
      title: "Notes are an outline",
      do: [{ note: "Attention compares queries with keys, then uses those scores to combine the values. Scaling keeps the scores stable." }],
      body: "Every highlight and thought is a block. **Enter** adds one, **Tab** nests it, the ⋮⋮ handle drags it. Markdown and `$math$` render as you type.",
    },
    {
      id: "label",
      anchor: "page.labels",
      placement: "left",
      title: "Organise with labels",
      body: "Let's add **llm** to this paper. Labels help you find related papers together in your library.",
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
      body: "This house button takes you to the homepage, where all your papers live. Click it to return to your library. You can take this tour again from the account menu.",
      advanceOn: { event: "home.opened" },
      next: "Finish",
    },
  ],
};
