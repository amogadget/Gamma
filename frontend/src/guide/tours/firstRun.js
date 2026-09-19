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
      body: "Let's read a paper together. I'll fetch one for you, then you take over. About a minute. **Esc** leaves at any time.",
      next: "Start",
    },
    {
      id: "add-demo",
      anchor: "header.add",
      placement: "left",
      title: "Adding a paper",
      body: "Watch: a paste of the arXiv link for *Attention Is All You Need*, then Enter. A DOI, an arXiv id, a PDF link or a dropped file all work the same way.",
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
      id: "highlight",
      anchor: "pdf.viewer",
      placement: "inside",
      title: "Now you: highlight something",
      body: "The paper is on the left, your notes on the right. Select any sentence in the PDF and pick a colour. The highlight becomes a note block you can write under.",
      advanceOn: { event: "highlight.created" },
    },
    {
      id: "notes",
      anchor: "dock.notes",
      placement: "left",
      title: "Notes are an outline",
      body: "Every highlight and thought is a block. **Enter** adds one, **Tab** nests it, the ⋮⋮ handle drags it. Markdown and `$math$` render as you type.",
    },
    {
      id: "share",
      anchor: "header.share",
      title: "Share when you're ready",
      body: "One link shares this page with its highlights. Viewers read; editors can annotate with you, live.",
      advanceOn: { event: "popover.opened", match: { name: "share" } },
    },
    {
      id: "done",
      anchor: null,
      title: "That's it",
      body: "**Ctrl+F** finds anything across notes and PDFs, the chat dock answers questions about the open paper once an AI key is set. Run this again from the account menu.",
      next: "Done",
    },
  ],
};
