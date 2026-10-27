import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishPost } from "../src/publish.js";
import { createIdentity, loadState, saveState } from "../src/identity.js";
import { acquireLock } from "../src/lock.js";

const run = promisify(execFile);
const throwing = async () => { throw new Error("no network"); };

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-state-"));
  process.env.MUSE_WIREDOVE_DIR = dir;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir, "State Test");
  return dir;
}

test("state: corrupt state blocks publication and is not discarded", async () => {
  const dir = await setup();
  await writeFile(path.join(dir, "state.json"), "{corrupt");
  await assert.rejects(() => publishPost({ text: "hi", dir, dryRun: true, fetchImpl: throwing }), /not valid JSON/);
  assert.deepEqual(await readFile(path.join(dir, "state.json")), Buffer.from("{corrupt"));
});

test("state: invalid previous reference blocks publication", async () => {
  const dir = await setup();
  const state = await loadState(dir);
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ ...state, previous: "not-a-post-id" }));
  await assert.rejects(() => publishPost({ text: "hi", dir, dryRun: true, fetchImpl: throwing }), /invalid previous/);
});

test("state: atomic saves leave no temp files and valid JSON", async () => {
  const dir = await setup();
  await Promise.all(Array.from({ length: 10 }, (_, i) => saveState(dir, { pubkey: "x", n: i })));
  const files = await readdir(dir);
  assert.equal(files.filter((f) => f.includes(".tmp-")).length, 0);
  const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
  assert.ok(Number.isInteger(state.n));
});

test("state: abandoned lock (dead pid) is reclaimed, live lock is not stolen", async () => {
  const dir = await setup();
  await writeFile(path.join(dir, "publish.lock"), JSON.stringify({ pid: 999999, createdAt: 1 }) + "\n");
  const release = await acquireLock(dir, { timeoutMs: 2000 });
  await release();
  // Live lock: hold it, and a second acquirer must time out, not steal.
  const held = await acquireLock(dir, { timeoutMs: 2000 });
  await assert.rejects(() => acquireLock(dir, { timeoutMs: 300, pollMs: 50 }), /Timed out/);
  await held();
  const again = await acquireLock(dir, { timeoutMs: 2000 });
  await again();
});

test("state: separate processes produce a serial chain, not a fork", async () => {
  const dir = await setup();
  const helper = path.join(import.meta.dirname, "helpers", "publish-child.mjs");
  const [a, b] = await Promise.all([
    run("node", [helper, dir, "first from process A"]),
    run("node", [helper, dir, "second from process B"]),
  ]);
  const ra = JSON.parse(a.stdout);
  const rb = JSON.parse(b.stdout);
  // One of the two posts must chain from the other:
  const chained = rb.content.includes(ra.id) || ra.content.includes(rb.id);
  assert.ok(chained, "neither post referenced the other");
  const finalState = await loadState(dir);
  assert.ok(finalState.previous === ra.id || finalState.previous === rb.id);
  // And the final state must point at the later post in the chain:
  const later = rb.content.includes(ra.id) ? rb : ra;
  assert.equal(finalState.previous, later.id);
});
