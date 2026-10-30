import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishPost, resumePending } from "../src/publish.js";
import { createIdentity, loadState } from "../src/identity.js";
import { loadPending, savePending } from "../src/pending.js";

// Review finding 5: pending records must be authenticated before any
// use. All of these crafted attacks must be refused BEFORE any
// network request, with the record preserved for diagnosis.
function noNetworkFetch() {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(url);
    throw new Error(`network request made to ${url}`);
  };
  impl.calls = calls;
  return impl;
}

function relayMock({ confirm = true } = {}) {
  let lastSignature = null;
  return async (url, opts) => {
    const body = String(opts?.body ?? "");
    if (body.length === 208) lastSignature = body;
    const isId = body.length === 44 && !body.includes("---");
    return {
      ok: true,
      json: async () => ({ messages: isId && confirm && lastSignature ? [lastSignature] : [] }),
    };
  };
}

async function setup(name = "Pending Test") {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-pend-"));
  delete process.env.MUSE_WIREDOVE_DIR;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir, name);
  return dir;
}

async function craftPending(dir) {
  let err;
  try {
    await publishPost({ text: "pending candidate post", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: false }) });
  } catch (e) { err = e; }
  assert.ok(err?.pending, "expected a pending publication error");
  const pending = await loadPending(dir);
  assert.ok(pending, "expected a pending record");
  return pending;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function assertRefused(fn, fetchImpl) {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, "expected the pending record to be refused");
  assert.ok(err.pending, "expected a pendingError");
  assert.equal(fetchImpl.calls.length, 0, "no network request may happen before validation");
  return err;
}

test("pending auth: another identity's record is refused, record preserved, state untouched", async () => {
  const dirA = await setup("Identity A");
  const dirB = await setup("Identity B");
  const pending = await craftPending(dirA);
  const beforeA = await readFile(path.join(dirA, "pending.json"), "utf8");
  await copyFile(path.join(dirA, "pending.json"), path.join(dirB, "pending.json"));
  const fetchImpl = noNetworkFetch();
  const err = await assertRefused(() => resumePending({ dir: dirB, sendNtfy: false, fetchImpl }), fetchImpl);
  assert.match(err.message, /different identity/);
  // Record preserved byte-for-byte in both dirs; B's state untouched:
  assert.equal(await readFile(path.join(dirB, "pending.json"), "utf8"), beforeA);
  assert.equal((await loadState(dirB)).previous, undefined);
  assert.equal(pending.id !== undefined, true);
});

test("pending auth: tampered content fails signature verification before any network", async () => {
  const dir = await setup();
  const pending = await craftPending(dir);
  pending.content += "\n\ntampered";
  await savePending(dir, pending);
  const fetchImpl = noNetworkFetch();
  const err = await assertRefused(() => resumePending({ dir, sendNtfy: false, fetchImpl }), fetchImpl);
  assert.match(err.message, /signature verification/);
  assert.ok(!err.message.includes("tampered"), "error must not print unpublished body material");
  assert.ok(await exists(path.join(dir, "pending.json")), "record must be preserved for diagnosis");
});

test("pending auth: tampered id is rejected against the recomputed id", async () => {
  const dir = await setup();
  const pending = await craftPending(dir);
  pending.id = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  pending.url = "https://wiredove.net/#" + pending.signature;
  await savePending(dir, pending);
  const fetchImpl = noNetworkFetch();
  const err = await assertRefused(() => resumePending({ dir, sendNtfy: false, fetchImpl }), fetchImpl);
  assert.match(err.message, /recomputed/);
});

test("pending auth: nextState bound to a different post id is rejected", async () => {
  const dir = await setup();
  const pending = await craftPending(dir);
  pending.nextState.previous = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
  await savePending(dir, pending);
  const fetchImpl = noNetworkFetch();
  const err = await assertRefused(() => resumePending({ dir, sendNtfy: false, fetchImpl }), fetchImpl);
  assert.match(err.message, /nextState/);
});

test("pending auth: stale record (signed previous older than saved history) is rejected", async () => {
  const dir1 = await setup("Identity S");
  await publishPost({ text: "first confirmed post", dir: dir1, sendNtfy: false, fetchImpl: relayMock({ confirm: true }) });
  const state1 = await loadState(dir1);
  assert.ok(state1.previous, "state should advance after the confirmed post");
  // Craft a pending record signed by the same identity but with an
  // older `previous` (undefined), in a second directory.
  const dir2 = await mkdtemp(path.join(tmpdir(), "muse-wiredove-pend-"));
  await copyFile(path.join(dir1, "identity.txt"), path.join(dir2, "identity.txt"));
  const pending = await craftPending(dir2);
  await copyFile(path.join(dir2, "pending.json"), path.join(dir1, "pending.json"));
  const fetchImpl = noNetworkFetch();
  const err = await assertRefused(() => resumePending({ dir: dir1, sendNtfy: false, fetchImpl }), fetchImpl);
  assert.match(err.message, /stale/);
  const stateAfter = await loadState(dir1);
  assert.equal(stateAfter.previous, state1.previous, "saved history must not move on a stale record");
});

test("pending auth: media metadata inconsistent with the signed post is rejected", async () => {
  const dir = await setup();
  const pending = await craftPending(dir);
  pending.media = { andfs: "x", media_url: "https://wiredove.net/media/fake", media_name: "fake.png", mime: "image/png", byte_count: 1 };
  await savePending(dir, pending);
  const fetchImpl = noNetworkFetch();
  const err = await assertRefused(() => resumePending({ dir, sendNtfy: false, fetchImpl }), fetchImpl);
  assert.match(err.message, /andfs/);
});

test("pending auth: a valid pending record still resumes normally", async () => {
  const dir = await setup();
  let original;
  try {
    await publishPost({ text: "valid pending post", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: false }) });
  } catch (e) { original = e; }
  const resumed = await resumePending({ dir, sendNtfy: false, fetchImpl: relayMock({ confirm: true }) });
  assert.equal(resumed.id, original.postId);
  assert.equal(await exists(path.join(dir, "pending.json")), false);
  const state = await loadState(dir);
  assert.equal(state.previous, original.postId);
});
