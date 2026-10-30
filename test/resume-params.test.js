import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishPost, resumePending } from "../src/publish.js";
import { createIdentity, loadState } from "../src/identity.js";
import { loadPending, savePending } from "../src/pending.js";
import { an } from "../src/an.js";

// Review finding 4: resume must reuse the pending record's ORIGINAL
// media and transport parameters, not the caller's current ones.
function networkMock({ confirm = true, log = [], uploadOk = true } = {}) {
  let lastSignature = null;
  return async (url, opts) => {
    log.push({ url, opts });
    if (String(url).endsWith("/api/media")) {
      if (!uploadOk) return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
      const auth = JSON.parse(opts.headers["X-ANProto-Content"]);
      return { ok: true, json: async () => ({ andfs: auth.andfs, mime: auth.mime, media_size: auth.media_size }) };
    }
    const body = String(opts?.body ?? "");
    if (body.length === 208) lastSignature = body;
    const isId = body.length === 44 && !body.includes("---");
    return { ok: true, json: async () => ({ messages: isId && confirm && lastSignature ? [lastSignature] : [] }) };
  };
}

async function setup(name = "Resume Params Test") {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-rp-"));
  delete process.env.MUSE_WIREDOVE_DIR;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir, name);
  return dir;
}

async function writePng(dir, name, content) {
  const p = path.join(dir, name);
  await writeFile(p, new TextEncoder().encode(content));
  return p;
}

async function craftMediaPending(dir, { origin, reply, replyto, sendNtfy = false } = {}) {
  const img = await writePng(dir, "photo.png", "fake-png-bytes-1234");
  let err;
  try {
    await publishPost({
      text: "media post", imagePath: img, origin, reply, replyto,
      dir, sendNtfy, fetchImpl: networkMock({ confirm: false, uploadOk: false }),
    });
  } catch (e) { err = e; }
  assert.ok(err, "expected the interrupted publish to throw");
  const pending = await loadPending(dir);
  assert.ok(pending, "expected a pending record after the interrupted upload");
  assert.equal(pending.mediaUploaded, false);
  return { pending, img };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

test("resume: interrupted upload resumes against the ORIGINAL origin, not the caller's", async () => {
  const dir = await setup();
  const origin = "https://example.test";
  const { img } = await craftMediaPending(dir, { origin });
  const log = [];
  const resumed = await resumePending({ dir, imagePath: img, sendNtfy: false, fetchImpl: networkMock({ confirm: true, log }) });
  const upload = log.find((c) => String(c.url).endsWith("/api/media"));
  assert.ok(upload, "expected an upload request on resume");
  assert.ok(String(upload.url).startsWith("https://example.test/api/media"),
    `upload must go to the original origin, got ${upload.url}`);
  assert.ok(resumed.media.media_url.startsWith("https://example.test/media/"));
  assert.equal(resumed.id.length, 44);
});

test("resume: reply references are preserved in the resumed upload authorization", async () => {
  const dir = await setup();
  const keypair = (await readFile(path.join(dir, "identity.txt"), "utf8")).trim();
  const replyId = "R".repeat(43) + "=";
  const replyto = an.pubkeyOf(keypair);
  const { img } = await craftMediaPending(dir, { reply: replyId, replyto });
  const log = [];
  await resumePending({ dir, imagePath: img, sendNtfy: false, fetchImpl: networkMock({ confirm: true, log }) });
  const upload = log.find((c) => String(c.url).endsWith("/api/media"));
  assert.ok(upload, "expected an upload request on resume");
  const auth = JSON.parse(upload.opts.headers["X-ANProto-Content"]);
  assert.equal(auth.reply, replyId);
  assert.equal(auth.replyto, replyto);
});

test("resume: a wrong image file is rejected locally with no upload or relay request", async () => {
  const dir = await setup();
  await craftMediaPending(dir);
  const other = await writePng(dir, "other.png", "different-bytes-entirely");
  const log = [];
  let err;
  try {
    await resumePending({ dir, imagePath: other, sendNtfy: false, fetchImpl: networkMock({ confirm: true, log }) });
  } catch (e) { err = e; }
  assert.ok(err?.pending, "expected a pendingError");
  assert.match(err.message, /does not match/);
  assert.equal(log.length, 0, "no network request may happen before local validation");
  assert.ok(await exists(path.join(dir, "pending.json")), "record must be preserved for diagnosis");
});

test("resume: notifications stay disabled when the original post disabled them", async () => {
  const dir = await setup();
  await craftMediaPending(dir, { sendNtfy: false });
  const log = [];
  // Even with a caller asking for notifications, the record's own
  // preference rules.
  const resumed = await resumePending({ dir, imagePath: path.join(dir, "photo.png"), sendNtfy: true, fetchImpl: networkMock({ confirm: true, log }) });
  assert.equal(resumed.notification.attempted, false);
  assert.equal(resumed.notification.reason, "disabled");
  assert.ok(!log.some((c) => String(c.url).startsWith("https://ntfy.sh")), "ntfy must not be contacted");
});

test("resume: explicit sendNtfy=false overrides a record that had them enabled", async () => {
  const dir = await setup();
  await craftMediaPending(dir, { sendNtfy: true });
  const log = [];
  const resumed = await resumePending({ dir, imagePath: path.join(dir, "photo.png"), sendNtfy: false, fetchImpl: networkMock({ confirm: true, log }) });
  assert.equal(resumed.notification.attempted, false);
  assert.equal(resumed.notification.reason, "disabled");
});

test("resume: old record missing sendNtfy falls back to the kind default, keeps original origin", async () => {
  const dir = await setup();
  await craftMediaPending(dir, { origin: "https://example.test" });
  const pending = await loadPending(dir);
  // Records written before sendNtfy existed lack only that field;
  // origin/relayURL have always been written, so a record missing
  // them is rejected as foreign/corrupt (see validatePending).
  delete pending.sendNtfy;
  await savePending(dir, pending);
  const log = [];
  const resumed = await resumePending({ dir, imagePath: path.join(dir, "photo.png"), fetchImpl: networkMock({ confirm: true, log }) });
  const upload = log.find((c) => String(c.url).endsWith("/api/media"));
  assert.ok(upload, "expected an upload request on resume");
  assert.ok(String(upload.url).startsWith("https://example.test/api/media"), `got ${upload.url}`);
  // Post default is notifications enabled when the record predates the field.
  assert.equal(resumed.notification.attempted, true);
});
