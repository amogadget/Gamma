// First eligible contact with the composer, not merely mounting the dock.
// All copy, prerequisites and steps live here; the app only supplies facts.
export default {
  id: "ai-chat",
  version: 1,
  title: "Chat with your library",
  estimate: "1 min",
  trigger: {
    event: "chat.focused",
    requires: { aiConfigured: true, chatVisible: true, guideAvailable: true },
  },
  invitation: {
    anchor: "chat.composer",
    placement: "top",
    title: "A little context. Better answers.",
    body: "Your AI is ready. Take a quick look at adding papers, choosing a model, and asking your first question.",
  },
  steps: [
    {
      id: "chat-context",
      anchor: "chat.context",
      placement: "top",
      title: "Choose what to talk about",
      body: "On a page, chat uses that page as context. Use **+** to add pages from your library, images, or PDFs. You can also type `@` in your message to mention a paper.\n\nSelected PDF passages and attached notes appear above your message, so you can ask about a specific detail.",
    },
    {
      id: "chat-settings",
      anchor: "chat.settings",
      placement: "left",
      title: "Make the model your own",
      body: "The gear opens **Chat settings**: choose a model, adjust reasoning effort, and set how much PDF text to include. These settings apply across your chats.\n\nTo add or switch providers, open **Settings → Provider and models** from your account menu.",
    },
    {
      id: "chat-tools",
      anchor: "chat.tools",
      placement: "left",
      title: "Let chat look things up",
      body: "**Tools** lets the assistant search and read beyond the text already attached. Chat settings lets you choose which actions it can take for library, PDF, and notes chats.\n\nReview those permissions before asking it to organize pages or edit notes.",
    },
    {
      id: "chat-question",
      anchor: "chat.composer",
      placement: "top",
      title: "Start with a question",
      body: "With a paper attached or open, try: **“Summarize the main result and cite the supporting pages.”**\n\nPress **Enter** to send, or **Shift + Enter** for a new line. Follow page citations in the reply back to the PDF. You can revisit this guide from the info button in the chat header.",
      advanceOn: { event: "chat.sent" },
      next: "Got it",
    },
  ],
};
