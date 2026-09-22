export default {
  id: "ai-chat",
  version: 2,
  title: "AI chat",
  steps: [
    { id: "chat-question", anchor: "chat.input", placement: "top", title: "Ask about your paper",
      do: [{ type: "chat.input", text: "summarize the paper for me", preserveDraft: true }, { wait: 1000 }] },
    { id: "chat-voice", anchor: "chat.voice", placement: "top", title: "Or use your voice" },
    { id: "chat-box", anchor: "pdf.viewer", placement: "inside", title: "Ctrl-drag a box for context",
      requires: { pdfChatVisible: true }, do: [{ previewArea: true, context: true }] },
    { id: "chat-box-context", anchor: "chat.imageContext", placement: "top", title: "Your selection is now chat context",
      requires: { pdfChatVisible: true }, next: "Done" },
  ],
};
