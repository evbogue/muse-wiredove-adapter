import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishPost, publishProfile } from "../src/publish.js";
import { createIdentity, saveState } from "../src/identity.js";
import { loadPending, savePending } from "../src/pending.js";
import { prepareMedia, MAX_BYTES } from "../src/andfs.js";

// Work order 2: every network path is a throwing stub. A dry run must
// succeed, leave identity and state byte-for-byte unchanged, and
// clearly label calculated media as not uploaded.
const throwing = async () => { throw new Error("network must not be used"); };

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-dry-"));
  process.env.MUSE_WIREDOVE_DIR = dir;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir, "Dry Test");
  const imagePath = path.join(dir, "photo.png");
  await writeFile(imagePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return { dir, imagePath };
}
async function snapshot(dir) {
  return {
    identity: await readFile(path.join(dir, "identity.txt")),
    state: await readFile(path.join(dir, "state.json")),
  };
}

test("dry-run: text post uses no network and leaves identity/state unchanged", async () => {
  const { dir } = await setup();
  const before = await snapshot(dir);
  const result = await publishPost({ text: "hello dry", dir, dryRun: true, fetchImpl: throwing });
  assert.equal(result.dryRun, true);
  assert.equal(result.media, null);
  assert.deepEqual(await snapshot(dir), before);
});

test("dry-run: image post calculates media locally, labels it not uploaded", async () => {
  const { dir, imagePath } = await setup();
  const before = await snapshot(dir);
  let calls = 0;
  const result = await publishPost({
    text: "with photo", imagePath, dir, dryRun: true,
    fetchImpl: async () => { calls++; throw new Error("no network"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.media.uploaded, false);
  assert.ok(result.media.media_url.startsWith("https://wiredove.net/media/"));
  assert.ok(result.content.includes(result.media.media_url));
  assert.ok(!result.content.includes("uploaded"));
  assert.deepEqual(await snapshot(dir), before);
});

test("dry-run: profile with image uses no network and leaves state unchanged", async () => {
  const { dir, imagePath } = await setup();
  const before = await snapshot(dir);
  const result = await publishProfile({ name: "Dry Test", bio: "bio", imagePath, dir, dryRun: true, fetchImpl: throwing });
  assert.equal(result.dryRun, true);
  assert.equal(result.media.uploaded, false);
  assert.ok(result.content.includes(result.media.media_url));
  assert.deepEqual(await snapshot(dir), before);
});

test("real publish: oversized post is rejected before any network request", async () => {
  const { dir, imagePath } = await setup();
  const before = await snapshot(dir);
  let calls = 0;
  await assert.rejects(
    () => publishPost({
      text: "x".repeat(70000), imagePath, dir,
      fetchImpl: async () => { calls++; throw new Error("should not be reached"); },
    }),
    /size limit/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await snapshot(dir), before);
});

test("real publish: unknown media type is rejected before any network request", async () => {
  const { dir } = await setup();
  const badPath = path.join(dir, "notes.txt");
  await writeFile(badPath, "hello");
  let calls = 0;
  await assert.rejects(
    () => publishPost({ text: "hi", imagePath: badPath, dir, fetchImpl: async () => { calls++; throw new Error("no"); } }),
    /Unknown media type/,
  );
  assert.equal(calls, 0);
});

test("prepareMedia: oversized media is rejected locally", async () => {
  const bytes = new Uint8Array(MAX_BYTES + 1);
  await assert.rejects(() => prepareMedia({ bytes, mime: "image/png", name: "big.png" }), /32 MiB/);
});

// Review finding 2: a dry run must never invoke pending recovery. When a
// pending record exists, the dry run is refused with an actionable error,
// makes zero network requests, and leaves identity, state, and pending
// bytes unchanged — for post and profile, text and media, relay-confirmed,
// and already-saved pending records alike.
async function snapshotAll(dir) {
  const pending = await readFile(path.join(dir, "pending.json")).catch(() => null);
  return { ...(await snapshot(dir)), pending };
}

async function seedPendingText(dir) {
  const noConfirm = async () => ({ ok: true, json: async () => ({ messages: [] }) });
  let err;
  try {
    await publishPost({ text: "uncertain post", dir, sendNtfy: false, fetchImpl: noConfirm });
  } catch (e) { err = e; }
  assert.ok(err && err.pending, "expected a pending error to seed the record");
  return err;
}

test("dry-run: pending text post refuses the dry run, zero network calls, files unchanged", async () => {
  const { dir } = await setup();
  const seed = await seedPendingText(dir);
  const before = await snapshotAll(dir);
  let calls = 0;
  await assert.rejects(
    () => publishPost({ text: "new dry post", dir, dryRun: true, fetchImpl: async () => { calls++; throw new Error("network must not be used"); } }),
    /Dry run refused/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await snapshotAll(dir), before, "identity, state, and pending.json must be byte-identical");
  assert.equal((await loadPending(dir)).id, seed.postId, "pending record must be preserved");
});

test("dry-run: pending text post refuses profile dry runs too", async () => {
  const { dir } = await setup();
  await seedPendingText(dir);
  const before = await snapshotAll(dir);
  let calls = 0;
  await assert.rejects(
    () => publishProfile({ name: "Dry Test", dir, dryRun: true, fetchImpl: async () => { calls++; throw new Error("network must not be used"); } }),
    /Dry run refused/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await snapshotAll(dir), before);
});

test("dry-run: pending media post refuses the dry run without upload or relay requests", async () => {
  const { dir, imagePath } = await setup();
  // Seed a pending media record: upload confirms, relay never confirms.
  const mediaMock = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/api/media")) {
      const auth = JSON.parse(opts.headers["X-ANProto-Content"]);
      return { ok: true, json: async () => ({ andfs: auth.andfs, mime: auth.mime, media_size: auth.media_size }) };
    }
    return { ok: true, json: async () => ({ messages: [] }) };
  };
  let seed;
  try {
    await publishPost({ text: "media post", imagePath, dir, sendNtfy: false, fetchImpl: mediaMock });
  } catch (e) { seed = e; }
  assert.ok(seed && seed.pending);
  assert.equal((await loadPending(dir)).mediaUploaded, true);
  const before = await snapshotAll(dir);
  let calls = 0;
  await assert.rejects(
    () => publishPost({ text: "another dry post", dir, dryRun: true, fetchImpl: async () => { calls++; throw new Error("network must not be used"); } }),
    /Dry run refused/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await snapshotAll(dir), before);
});

test("dry-run: relay-confirmed pending is preserved, not finalized or deleted", async () => {
  const { dir } = await setup();
  const seed = await seedPendingText(dir);
  const pending = await loadPending(dir);
  pending.relayConfirmed = true; // as if relay confirmed but state saving crashed
  await savePending(dir, pending);
  const before = await snapshotAll(dir);
  let calls = 0;
  await assert.rejects(
    () => publishPost({ text: "dry", dir, dryRun: true, fetchImpl: async () => { calls++; throw new Error("network must not be used"); } }),
    /Dry run refused/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await snapshotAll(dir), before);
  assert.equal((await loadPending(dir)).id, seed.postId);
});

test("dry-run: already-saved pending is not deleted and history is not rolled back", async () => {
  const { dir } = await setup();
  const seed = await seedPendingText(dir);
  const pending = await loadPending(dir);
  await saveState(dir, pending.nextState); // crash between state save and pending deletion
  const before = await snapshotAll(dir);
  let calls = 0;
  await assert.rejects(
    () => publishPost({ text: "dry", dir, dryRun: true, fetchImpl: async () => { calls++; throw new Error("network must not be used"); } }),
    /Dry run refused/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await snapshotAll(dir), before, "pending.json must not be deleted as a cleanup side effect");
  const { loadState } = await import("../src/identity.js");
  assert.equal((await loadState(dir)).previous, seed.postId, "confirmed history must not move backward");
});
