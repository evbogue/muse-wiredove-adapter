import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishPost } from "../src/publish.js";
import { createIdentity, loadState } from "../src/identity.js";

// Work order 5: relay confirms, ntfy is mocked separately, and no
// global fetch is ever used (fetchImpl is the only network path).
function makeFetch({ ntfyMode = "ok", ntfyDelayMs = 0 } = {}) {
  let lastSignature = null;
  let ntfyRequests = 0;
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.includes("ntfy.sh")) {
      ntfyRequests++;
      if (ntfyMode === "throw") throw new Error("ntfy boom");
      if (ntfyMode === "http-error") return { ok: false, status: 500 };
      if (ntfyMode === "stall") {
        // Respect the abort signal, so the configured timeout ends it.
        await new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (ntfyDelayMs) await new Promise((r) => setTimeout(r, ntfyDelayMs));
      return { ok: true, status: 200 };
    }
    if (u.endsWith("/api/media")) {
      const auth = JSON.parse(opts.headers["X-ANProto-Content"]);
      return { ok: true, json: async () => ({ andfs: auth.andfs, mime: auth.mime, media_size: auth.media_size }) };
    }
    const body = String(opts?.body ?? "");
    if (body.length === 208) lastSignature = body;
    const isId = body.length === 44 && !body.includes("---");
    return { ok: true, json: async () => ({ messages: isId && lastSignature ? [lastSignature] : [] }) };
  };
  return { fetchImpl, get ntfyRequests() { return ntfyRequests; } };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-notif-"));
  process.env.MUSE_WIREDOVE_DIR = dir;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir, "Notif Test");
  return dir;
}

test("notifications: HTTP error leaves confirmed state intact, with failure details", async () => {
  const dir = await setup();
  const { fetchImpl } = makeFetch({ ntfyMode: "http-error" });
  const result = await publishPost({ text: "with bad ntfy", dir, fetchImpl });
  assert.equal(result.notification.attempted, true);
  assert.equal(result.notification.delivered, false);
  assert.ok(result.notification.failures.some((f) => f.status === 500));
  assert.equal((await loadState(dir)).previous, result.id);
});

test("notifications: thrown ntfy error does not fail the publish", async () => {
  const dir = await setup();
  const { fetchImpl } = makeFetch({ ntfyMode: "throw" });
  const result = await publishPost({ text: "ntfy throws", dir, fetchImpl });
  assert.equal(result.notification.delivered, false);
  assert.equal((await loadState(dir)).previous, result.id);
});

test("notifications: stalled ntfy terminates within the configured bound", async () => {
  const dir = await setup();
  const { fetchImpl } = makeFetch({ ntfyMode: "stall" });
  const start = Date.now();
  const result = await publishPost({ text: "ntfy stalls", dir, fetchImpl, ntfyTimeoutMs: 100 });
  assert.ok(Date.now() - start < 5000, "stalled ntfy must not hang the publish");
  assert.equal(result.notification.delivered, false);
  assert.equal((await loadState(dir)).previous, result.id);
});

test("notifications: sendNtfy false makes zero ntfy requests", async () => {
  const dir = await setup();
  const mock = makeFetch({ ntfyMode: "throw" });
  const result = await publishPost({ text: "no ntfy", dir, sendNtfy: false, fetchImpl: mock.fetchImpl });
  assert.equal(mock.ntfyRequests, 0);
  assert.equal(result.notification.attempted, false);
  assert.equal(result.notification.reason, "disabled");
  assert.equal((await loadState(dir)).previous, result.id);
});

test("notifications: stalled upload terminates within the configured bound, pending preserved", async () => {
  const dir = await setup();
  const imagePath = path.join(dir, "photo.png");
  await writeFile(imagePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]));
  const stalledUpload = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/api/media")) {
      await new Promise((_, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("upload aborted")));
      });
    }
    throw new Error("relay must not be reached after a failed upload");
  };
  const start = Date.now();
  await assert.rejects(
    () => publishPost({ text: "stalled upload", imagePath, dir, sendNtfy: false, fetchImpl: stalledUpload, uploadTimeoutMs: 100 }),
    /abort|timeout/i,
  );
  assert.ok(Date.now() - start < 5000);
  // Pending record preserved for resume, history not advanced:
  const pending = JSON.parse(await readFile(path.join(dir, "pending.json"), "utf8"));
  assert.equal(pending.mediaUploaded, false);
  assert.equal((await loadState(dir)).previous, undefined);
});
