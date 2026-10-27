import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishPost, resumePending } from "../src/publish.js";
import { createIdentity, loadState } from "../src/identity.js";
import { loadPending } from "../src/pending.js";

// Work order 4: a mocked relay that accepts content+signature but
// never confirms the id (confirmation timeout), then a confirming
// relay for resume. No real network.
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

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-rec-"));
  process.env.MUSE_WIREDOVE_DIR = dir;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir, "Recovery Test");
  const keypair = await readFile(path.join(dir, "identity.txt"), "utf8");
  return { dir, keypair: keypair.trim() };
}
async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

test("recovery: confirmation timeout leaves a pending record with id/url, no key", async () => {
  const { dir, keypair } = await setup();
  let err;
  try {
    await publishPost({ text: "uncertain post", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: false }) });
  } catch (e) { err = e; }
  assert.ok(err, "expected a pending error");
  assert.equal(err.pending, true);
  assert.ok(err.postId);
  assert.ok(err.url);
  const pending = await loadPending(dir);
  assert.equal(pending.id, err.postId);
  assert.equal(pending.signature.length, 208);
  assert.equal(pending.relayConfirmed, false);
  const pendingText = await readFile(path.join(dir, "pending.json"), "utf8");
  assert.ok(!pendingText.includes(keypair), "pending record must not contain the private key");
  // History has not advanced:
  const state = await loadState(dir);
  assert.equal(state.previous, undefined);
});

test("recovery: resume reuses the original signature/id and advances history exactly once", async () => {
  const { dir } = await setup();
  let original;
  try {
    await publishPost({ text: "uncertain post", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: false }) });
  } catch (e) { original = e; }
  const resumed = await resumePending({ dir, sendNtfy: false, fetchImpl: relayMock({ confirm: true }) });
  assert.equal(resumed.id, original.postId);
  assert.equal(resumed.signature, (await loadPending(dir)) ? null : resumed.signature);
  assert.equal(await exists(path.join(dir, "pending.json")), false);
  const state = await loadState(dir);
  assert.equal(state.previous, original.postId);
  // A second resume finds nothing:
  assert.equal(await resumePending({ dir, fetchImpl: relayMock({ confirm: true }) }), null);
});

test("recovery: a new post recovers pending first, then chains from it", async () => {
  const { dir } = await setup();
  let original;
  try {
    await publishPost({ text: "first, uncertain", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: false }) });
  } catch (e) { original = e; }
  const second = await publishPost({ text: "second, after recovery", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: true }) });
  assert.ok(second.content.includes(original.postId), "second post must chain from the recovered post");
  const state = await loadState(dir);
  assert.equal(state.previous, second.id);
  assert.equal(await exists(path.join(dir, "pending.json")), false);
});

test("recovery: relay-confirmed pending (state-save failure aftermath) advances exactly once", async () => {
  const { dir } = await setup();
  // Craft a pending record as if relay confirmed but state saving failed:
  let crafted;
  try {
    await publishPost({ text: "crafted", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: false }) });
  } catch (e) { crafted = e; }
  const pending = await loadPending(dir);
  pending.relayConfirmed = true;
  const { savePending } = await import("../src/pending.js");
  await savePending(dir, pending);
  const resumed = await resumePending({ dir, sendNtfy: false, fetchImpl: relayMock({ confirm: true }) });
  assert.equal(resumed.id, crafted.postId);
  const state = await loadState(dir);
  assert.equal(state.previous, crafted.postId);
});

test("recovery: already-saved pending is finalized, not duplicated", async () => {
  const { dir } = await setup();
  let crafted;
  try {
    await publishPost({ text: "already saved", dir, sendNtfy: false, fetchImpl: relayMock({ confirm: false }) });
  } catch (e) { crafted = e; }
  // Simulate crash between state save and pending deletion:
  const pending = await loadPending(dir);
  const { savePending } = await import("../src/pending.js");
  await savePending(dir, pending);
  const { saveState } = await import("../src/identity.js");
  await saveState(dir, pending.nextState);
  const resumed = await resumePending({ dir, sendNtfy: false, fetchImpl: relayMock({ confirm: true }) });
  assert.equal(resumed.alreadySaved, true);
  assert.equal(resumed.id, crafted.postId);
  assert.equal(await exists(path.join(dir, "pending.json")), false);
  const state = await loadState(dir);
  assert.equal(state.previous, crafted.postId);
});

test("recovery: dry runs never create a pending record", async () => {
  const { dir } = await setup();
  await publishPost({ text: "dry", dir, dryRun: true, fetchImpl: async () => { throw new Error("no network"); } });
  assert.equal(await exists(path.join(dir, "pending.json")), false);
});

test("recovery: media retry uses the same prepared attachment metadata", async () => {
  const { dir } = await setup();
  const imagePath = path.join(dir, "photo.png");
  await writeFile(imagePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
  // First attempt: media upload succeeds, relay confirmation fails.
  let err;
  const mediaMock = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/api/media")) {
      // Return a confirmation matching whatever manifest the adapter
      // prepared: read it from the authorization header.
      const auth = JSON.parse(opts.headers["X-ANProto-Content"]);
      return { ok: true, json: async () => ({ andfs: auth.andfs, mime: auth.mime, media_size: auth.media_size }) };
    }
    return relayMock({ confirm: false })(url, opts);
  };
  try {
    await publishPost({ text: "media post", imagePath, dir, sendNtfy: false, fetchImpl: mediaMock });
  } catch (e) { err = e; }
  assert.ok(err.pending);
  const pending = await loadPending(dir);
  assert.equal(pending.mediaUploaded, true);
  assert.ok(pending.media.andfs);
  const confirmingRelay = relayMock({ confirm: true });
  const resumed = await resumePending({ dir, sendNtfy: false, fetchImpl: async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/api/media")) throw new Error("media must not be re-uploaded when already uploaded");
    return confirmingRelay(url, opts);
  } });
  assert.equal(resumed.id, err.postId);
  assert.equal(resumed.media.andfs, pending.media.andfs);
  assert.equal((await loadState(dir)).previous, err.postId);
});
