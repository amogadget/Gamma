import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatSession } from "../src/chat/chatSession.js";

const question = [{ role: "user", text: "Find a paper" }];
const answer = (text, partial = false) => [...question, { role: "ai", text, partial }];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

for (const key of ["home", "home:Physics/Optics", "pdf-page"]) {
  test(`${key}: a reply and its Stop control survive losing every subscriber`, async () => {
    const saved = [];
    const session = createChatSession(async (key, messages) => saved.push({ key, messages }));
    const ctrl = new AbortController();
    const unmount = session.subscribe(() => {});
    session.start(key, question, "Research", ctrl);
    session.update(key, answer("Read this link", true));
    unmount();
    session.update(key, answer("Read this link and its explanation", true));
    const remount = session.subscribe(() => {});
    assert.equal(session.isActive(key), true);
    assert.equal(session.getSnapshot().replies.get(key).messages.at(-1).text, "Read this link and its explanation");
    session.stop(key);
    assert.equal(ctrl.signal.aborted, true);
    await session.update(key, answer("Read this link and its explanation (stopped)"), true);
    session.finish(key);
    assert.equal(session.isActive(key), false);
    assert.equal(saved.at(-1).key, key);
    assert.deepEqual(saved.at(-1).messages, session.getSnapshot().replies.get(key).messages);
    remount();
  });
}

test("a delayed checkpoint finishes before the final save, even with no mounted dock", async () => {
  const initialSave = deferred();
  const saved = [];
  const session = createChatSession(async (key, messages) => {
    if (messages === question) await initialSave.promise;
    saved.push(messages);
  });
  session.start("home", question, "", new AbortController());
  session.update("home", answer("partial", true));
  const final = answer("complete");
  const finished = session.update("home", final, true);
  session.finish("home");
  assert.equal(session.isSaved("home"), false);
  await Promise.resolve();
  assert.equal(saved.length, 0);
  initialSave.resolve();
  await finished;
  assert.equal(session.isSaved("home"), true);
  assert.deepEqual(saved, [question, final]);
  assert.deepEqual(session.getSnapshot().replies.get("home").messages, final);
});

test("failed saves leave the answer available and can be retried before archiving", async () => {
  let failing = true;
  let persisted;
  const session = createChatSession(async (_, messages) => {
    if (failing) throw new Error("offline");
    persisted = messages;
  });
  session.start("home", question, "", new AbortController());
  const final = answer("complete");
  await assert.rejects(session.update("home", final, true), /offline/);
  session.finish("home");
  assert.deepEqual(session.getSnapshot().replies.get("home").messages, final);
  failing = false;
  await session.flush("home");
  session.forget("home");
  assert.deepEqual(persisted, final);
  assert.equal(session.getSnapshot().replies.has("home"), false);
});

test("two papers answer at the same time, each with its own Stop", async () => {
  const saved = [];
  const session = createChatSession(async (key, messages) => saved.push({ key, messages }));
  const a = new AbortController();
  const b = new AbortController();
  assert.equal(session.start("paper-a", question, "", a), true);
  assert.equal(session.start("paper-b", question, "", b), true);
  assert.equal(session.start("paper-a", question, "", new AbortController()), false, "one reply per conversation");
  assert.equal(session.isActive("paper-a"), true);
  assert.equal(session.isActive("paper-b"), true);
  session.update("paper-a", answer("A says", true));
  session.update("paper-b", answer("B says", true));
  session.stop("paper-b");
  assert.equal(a.signal.aborted, false, "stopping one paper leaves the other streaming");
  assert.equal(b.signal.aborted, true);
  await session.update("paper-b", answer("B says (stopped)"), true);
  session.finish("paper-b");
  assert.equal(session.isActive("paper-a"), true);
  assert.equal(session.isActive("paper-b"), false);
  assert.equal(session.isSaved("paper-b"), true);
  assert.equal(session.getSnapshot().replies.get("paper-a").messages.at(-1).text, "A says");
  await session.update("paper-a", answer("A says more"), true);
  session.finish("paper-a");
  assert.equal(session.getSnapshot().active.size, 0);
  assert.deepEqual(saved.filter((s) => s.key === "paper-a").at(-1).messages, answer("A says more"));
});
