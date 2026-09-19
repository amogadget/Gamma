// Owned by App, not the dock: navigation can unmount the view while its
// request keeps running. Keep the transcript and Stop control together.
export function createChatSession(save) {
  let snapshot = { replies: new Map(), activeKey: "" };
  let controller = null;
  const listeners = new Set();
  const timers = new Map();
  const writes = new Map();
  const saved = new WeakSet();
  const emit = () => { for (const listener of listeners) listener(); };
  const flush = (key) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    const reply = snapshot.replies.get(key);
    if (!reply || saved.has(reply.messages)) return writes.get(key) || Promise.resolve();
    // Serialize checkpoints and completion so a slow partial save can never
    // overwrite the final answer. A failed checkpoint must not block retries.
    const pending = (writes.get(key) || Promise.resolve()).catch(() => {})
      .then(() => save(key, reply.messages))
      .then(() => { saved.add(reply.messages); });
    writes.set(key, pending);
    return pending;
  };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    isSaved: (key) => snapshot.activeKey !== key && saved.has(snapshot.replies.get(key)?.messages),
    start(key, messages, title, ctrl) {
      if (snapshot.activeKey) return false;
      controller = ctrl;
      snapshot = { replies: new Map(snapshot.replies).set(key, { messages, title }), activeKey: key };
      emit();
      flush(key).catch(() => {});
      return true;
    },
    update(key, messages, final = false) {
      snapshot = { ...snapshot, replies: new Map(snapshot.replies).set(key, {
        ...snapshot.replies.get(key), messages,
      }) };
      emit();
      if (final) return flush(key);
      if (!timers.has(key)) timers.set(key, setTimeout(() => { flush(key).catch(() => {}); }, 500));
    },
    finish() {
      controller = null;
      snapshot = { ...snapshot, activeKey: "" };
      emit();
    },
    stop() { controller?.abort(); },
    flush,
    forget(key) {
      clearTimeout(timers.get(key));
      timers.delete(key);
      const replies = new Map(snapshot.replies);
      replies.delete(key);
      snapshot = { ...snapshot, replies };
      emit();
    },
  };
}
