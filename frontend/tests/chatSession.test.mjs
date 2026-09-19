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
    assert.equal(session.getSnapshot().activeKey, key);
    assert.equal(session.getSnapshot().replies.get(key).messages.at(-1).text, "Read this link and its explanation");
    session.stop();
    assert.equal(ctrl.signal.aborted, true);
    await session.update(key, answer("Read this link and its explanation (stopped)"), true);
    session.finish();
    assert.equal(session.getSnapshot().activeKey, "");
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
  session.finish();
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
  session.finish();
  assert.deepEqual(session.getSnapshot().replies.get("home").messages, final);
  failing = false;
  await session.flush("home");
  session.forget("home");
  assert.deepEqual(persisted, final);
  assert.equal(session.getSnapshot().replies.has("home"), false);
});
