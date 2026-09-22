// Owned by App, not the dock: navigation can unmount the view while its
// request keeps running. Keep the transcript and Stop control together.
// Conversations stream independently: one reply per bucket may be in flight,
// so a question asked on one paper keeps running while another paper is
// asked its own. `active` lists the buckets with a reply in flight.
export function createChatSession(save) {
  let snapshot = { replies: new Map(), active: new Set() };
  const controllers = new Map();
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
    isActive: (key) => snapshot.active.has(key),
    isSaved: (key) => !snapshot.active.has(key) && saved.has(snapshot.replies.get(key)?.messages),
    start(key, messages, title, ctrl) {
      if (snapshot.active.has(key)) return false;
      controllers.set(key, ctrl);
      snapshot = {
        replies: new Map(snapshot.replies).set(key, { messages, title }),
        active: new Set(snapshot.active).add(key),
      };
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
    finish(key) {
      controllers.delete(key);
      const active = new Set(snapshot.active);
      active.delete(key);
      snapshot = { ...snapshot, active };
      emit();
    },
    stop(key) { controllers.get(key)?.abort(); },
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
