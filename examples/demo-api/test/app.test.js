import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createApp } from "../src/app.js";

let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("GET /health reports ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("notes can be created, listed and fetched", async () => {
  const created = await fetch(`${base}/notes`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
  assert.equal(created.status, 201);
  const note = await created.json();
  assert.equal(note.text, "hello");

  const list = await (await fetch(`${base}/notes`)).json();
  assert.ok(list.some((n) => n.id === note.id));

  const one = await fetch(`${base}/notes/${note.id}`);
  assert.equal(one.status, 200);
});

test("creating a note without text is rejected", async () => {
  const res = await fetch(`${base}/notes`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});

test("unknown notes are 404", async () => {
  const res = await fetch(`${base}/notes/999`);
  assert.equal(res.status, 404);
});
