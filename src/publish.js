// Publish a Wiredove post without a browser, following wiredove's
// composer.js flow: compose -> verify -> relay gossip(content, signature),
// confirmed by gossip(id) -> state -> ntfy(signed) + ntfy(content).
// Media goes through AndFS first (see andfs.js), then its media_url is
// appended to the body if it is not already there, exactly like the
// website composer does.
//
// Work order 2 ordering: local preparation and composition/verification
// happen before any network access. A dry run therefore never uploads,
// contacts a relay, or sends a notification, and never advances history.
// A real publish composes and verifies the final post first, so a
// known-invalid post never uploads its attachment.
//
// Work order 4 ordering: a pending record (src/pending.js) is written
// before the first publishing side effect and removed only after the
// confirmed history is durably saved. Relay confirmation, state
// completion, and notification delivery are tracked separately, and a
// pending post is recovered — with its original signature and id —
// before a later post is allowed to chain from stale state.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { protocol } from "./protocol.js";
import { createWiredoveRelay } from "./relay.js";
import { uploadMedia, prepareMedia } from "./andfs.js";
import { an } from "./an.js";
import { loadIdentity, loadState, saveState, defaultDir, assertStateBelongsToIdentity } from "./identity.js";
import { withPublishLock } from "./lock.js";
import { loadPending, savePending, deletePending, pendingError, validatePending } from "./pending.js";

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "audio/ogg", ".wav": "audio/wav" };

// Work order 5: all HTTP, including ntfy, goes through the supplied
// fetchImpl (never the global fetch), with an explicit timeout, and a
// notification failure is returned as structured status — never thrown
// as a publishing failure, since state was already saved before this.
async function sendNotifications({ signature, content, fetchImpl, timeoutMs = 10000, sendNtfy = true }) {
  if (!sendNtfy) return { attempted: false, delivered: false, reason: "disabled", requests: 0, failures: [] };
  const failures = [];
  let requests = 0;
  for (const value of [signature, content]) {
    requests++;
    try {
      const response = await fetchImpl("https://ntfy.sh/wiredove", {
        method: "POST",
        body: `https://wiredove.net/#${value}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) failures.push({ value: value === signature ? "signature" : "content", status: response.status });
    } catch (err) {
      failures.push({ value: value === signature ? "signature" : "content", error: err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : err.message });
    }
  }
  return { attempted: true, delivered: failures.length === 0, requests, failures };
}

async function readAndPrepareMedia(imagePath, origin, reply, replyto) {
  const bytes = new Uint8Array(await readFile(imagePath));
  const ext = path.extname(imagePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`Unknown media type for ${imagePath}`);
  const prepared = await prepareMedia({ bytes, mime, name: path.basename(imagePath), origin, reply, replyto });
  return { bytes, mime, prepared };
}

function stripUploaded(media) {
  if (!media) return null;
  const { uploaded: _uploaded, ...rest } = media;
  return rest;
}

// Review finding 2: a dry run must never invoke pending recovery. When a
// pending record exists, the dry run is refused with an actionable error
// instead — no upload, relay, or notification request, and identity,
// state, and pending files stay byte-for-byte unchanged.
function pendingBlocksDryRun(pending) {
  const err = new Error(
    `Dry run refused: a pending ${pending.kind} publication (${pending.id}) exists. ` +
    `Resume it first, or clear it only after confirming its outcome, then retry the dry run. ` +
    `No network requests were made and the pending record was left unchanged.`
  );
  err.code = "pending-exists";
  err.postId = pending.id;
  err.url = pending.url;
  return err;
}

// Complete a pending post/profile with its original signature and id.
// Returns { recovered, alreadySaved, author, id, signature, url, content, media }.
// Throws a pendingError (pending record preserved) on relay or state
// failure, so the caller can report the id/url instead of losing it.
async function completePending(pending, { dir, keypair, state, fetchImpl, relayURL, origin, sendNtfy, mediaBytes, ntfyTimeoutMs, relayTimeoutMs, uploadTimeoutMs }) {
  // Review finding 5: authenticate the pending record before any
  // network request, state write, or deletion. Throws a pendingError
  // with the record preserved on any failure.
  const verified = await validatePending(pending, { pubkey: an.pubkeyOf(keypair), state });

  // Review finding 4: resume reuses the pending record's ORIGINAL
  // media and transport parameters, not the caller's current ones.
  // Records written by the current version always carry relayURL and
  // origin; a missing sendNtfy (older record) falls back to the
  // caller, then to the kind default. Reply references are recovered
  // from the signed content — the trustworthy source — not from a
  // re-supplied file or current flags.
  const effRelayURL = pending.relayURL || relayURL;
  const effOrigin = pending.origin || origin;
  // Notification preference: the record's original setting rules,
  // except an explicitly passed sendNtfy=false (e.g. CLI --no-ntfy)
  // disables them. A record that predates the field (sendNtfy
  // undefined) falls back to the caller, then to the kind default.
  const effSendNtfy = sendNtfy === false ? false
    : (pending.sendNtfy !== undefined ? pending.sendNtfy
      : (sendNtfy !== undefined ? sendNtfy : pending.kind === "post"));
  const meta = verified.parsed || {};

  if (state.previous === pending.id) {
    await deletePending(dir);
    return { recovered: true, alreadySaved: true, author: pending.author, id: pending.id, signature: pending.signature, url: pending.url, content: pending.content, media: pending.media || null, notification: { attempted: false, delivered: false, reason: "already-saved", requests: 0, failures: [] } };
  }

  let media = pending.media || null;
  if (media && !pending.mediaUploaded) {
    if (!mediaBytes) {
      throw pendingError(`Pending ${pending.kind} ${pending.id} has media that was not uploaded yet; resume with the original image file so the same prepared attachment can be retried`, pending);
    }
    // Validate the supplied resume file against the signed attachment
    // fields locally, before any upload request.
    if (mediaBytes.prepared.andfs !== media.andfs) {
      throw pendingError(`Resume image does not match the pending ${pending.kind}'s prepared attachment (andfs hash); refusing to upload a different file`, pending);
    }
    if (mediaBytes.prepared.mime !== media.mime) {
      throw pendingError(`Resume image MIME does not match the pending ${pending.kind}'s prepared attachment; refusing to upload a different file`, pending);
    }
    if (mediaBytes.prepared.media_size !== media.media_size) {
      throw pendingError(`Resume image size does not match the pending ${pending.kind}'s prepared attachment; refusing to upload a different file`, pending);
    }
    const uploaded = await uploadMedia({ bytes: mediaBytes.bytes, mime: mediaBytes.mime, name: media.media_name, keypair, origin: effOrigin, fetchImpl, reply: meta.reply, replyto: meta.replyto, timeoutMs: uploadTimeoutMs });
    if (uploaded.andfs !== media.andfs || uploaded.media_url !== media.media_url) {
      throw pendingError(`Resume image does not match the pending ${pending.kind}'s prepared attachment; refusing to publish with different media`, pending);
    }
    media = uploaded;
    pending.media = stripUploaded(uploaded);
    pending.mediaUploaded = true;
    await savePending(dir, pending);
  }

  const relay = createWiredoveRelay({ baseURL: effRelayURL, fetchImpl, timeoutMs: relayTimeoutMs });
  try {
    await relay.publish({ content: pending.content, signature: pending.signature, id: pending.id });
  } catch (err) {
    throw pendingError(`Relay confirmation failed for pending ${pending.kind} ${pending.id} (${pending.url}); the relay may have accepted it, so the pending record is preserved for resume`, pending);
  }
  pending.relayConfirmed = true;
  await savePending(dir, pending);

  try {
    await saveState(dir, pending.nextState);
  } catch (err) {
    const wrapped = pendingError(`Relay confirmed ${pending.kind} ${pending.id}, but saving state failed (${err.message}); pending record preserved for resume`, pending);
    wrapped.cause = err;
    throw wrapped;
  }
  await deletePending(dir);
  const notification = pending.kind === "post"
    ? await sendNotifications({ signature: pending.signature, content: pending.content, fetchImpl, timeoutMs: ntfyTimeoutMs, sendNtfy: effSendNtfy })
    : { attempted: false, delivered: false, reason: "profile", requests: 0, failures: [] };
  return { recovered: true, alreadySaved: false, author: pending.author, id: pending.id, signature: pending.signature, url: pending.url, content: pending.content, media, notification };
}

export async function resumePending({ dir = defaultDir(), relayURL = "https://pub.wiredove.net", origin = "https://wiredove.net", sendNtfy, fetchImpl = fetch, imagePath, ntfyTimeoutMs = 10000, relayTimeoutMs = 10000, uploadTimeoutMs = 60000 } = {}) {
  const dirPath = dir || defaultDir();
  return withPublishLock(dirPath, async () => {
    const keypair = await loadIdentity(dirPath);
    const state = await loadState(dirPath);
    assertStateBelongsToIdentity(state, an.pubkeyOf(keypair));
    const pending = await loadPending(dirPath);
    if (!pending) return null;
    // Review finding 4: the resume file is prepared against the
    // pending record's ORIGINAL origin, not the caller's current one,
    // and completePending prefers the record's relay/origin/sendNtfy.
    // An explicit sendNtfy here overrides the record; otherwise the
    // record's own preference rules (it does not silently default
    // to enabled).
    let mediaBytes = null;
    if (pending.media && !pending.mediaUploaded && imagePath) {
      mediaBytes = await readAndPrepareMedia(imagePath, pending.origin || origin);
      if (mediaBytes.prepared.andfs !== pending.media.andfs) {
        throw pendingError("Resume image does not match the pending post's prepared attachment", pending);
      }
    }
    return completePending(pending, { dir: dirPath, keypair, state, fetchImpl, relayURL: pending.relayURL || relayURL, origin, sendNtfy, mediaBytes, ntfyTimeoutMs, relayTimeoutMs, uploadTimeoutMs });
  });
}

// The whole read/compose/publish/state-update operation runs under
// the per-identity publishing lock (work order 3), including dry runs,
// so two processes cannot read the same `previous` and fork history.
export async function publishPost(opts = {}) {
  const dir = opts.dir || defaultDir();
  return withPublishLock(dir, () => publishPostInner(opts), { timeoutMs: opts.lockTimeoutMs });
}

async function publishPostInner({
  text = "", imagePath, name, reply, replyto, previous,
  dir = defaultDir(), relayURL = "https://pub.wiredove.net",
  origin = "https://wiredove.net", dryRun = false, sendNtfy = true,
  fetchImpl = fetch, ntfyTimeoutMs = 10000, relayTimeoutMs = 10000, uploadTimeoutMs = 60000,
} = {}) {
  const keypair = await loadIdentity(dir);
  let state = await loadState(dir);
  assertStateBelongsToIdentity(state, an.pubkeyOf(keypair));

  // Recover any pending post before chaining a new one from stale state.
  // Review finding 2: a dry run never recovers — it is refused outright,
  // so no upload, relay, or notification request can happen and identity,
  // state, and pending files stay byte-for-byte unchanged.
  const existingPending = await loadPending(dir);
  if (existingPending) {
    if (dryRun) throw pendingBlocksDryRun(existingPending);
    await completePending(existingPending, { dir, keypair, state, fetchImpl, relayURL: existingPending.relayURL || relayURL, origin, sendNtfy, mediaBytes: null, ntfyTimeoutMs, relayTimeoutMs, uploadTimeoutMs });
    state = await loadState(dir);
  }

  // Local preparation only: no network yet.
  let mediaFile = null;
  let media = null;
  if (imagePath) {
    mediaFile = await readAndPrepareMedia(imagePath, origin, reply, replyto);
    media = mediaFile.prepared;
  }
  let body = text;
  if (media && !body.includes(media.media_url)) body = [body.trim(), media.media_url].filter(Boolean).join("\n\n");
  if (!body.trim() && !media) throw new Error("Nothing to post: give --text and/or --image");

  const meta = {};
  const displayName = name || state.name;
  if (displayName) meta.name = displayName;
  const prev = previous || state.previous;
  if (prev) meta.previous = prev;
  if (reply) meta.reply = reply;
  if (replyto) meta.replyto = replyto;
  if (media) Object.assign(meta, stripUploaded(media));

  // Compose and verify the final post locally before any upload.
  // protocol.compose enforces the 65,536-byte post cap.
  const post = await protocol.compose(keypair, body, meta);
  const result = {
    author: post.author, id: post.id, signature: post.signature,
    url: `https://wiredove.net/#${post.signature}`, content: post.content, media,
  };
  if (dryRun) {
    // media.media_url is calculated, not uploaded: media.uploaded is false.
    // Dry runs never create a pending record or send notifications.
    return { ...result, dryRun: true, notification: { attempted: false, delivered: false, reason: "dryRun", requests: 0, failures: [] } };
  }

  const nextState = { ...state, pubkey: post.author, ...(displayName ? { name: displayName } : {}), previous: post.id };
  const pending = {
    version: 1, kind: "post", author: post.author, id: post.id, signature: post.signature,
    url: result.url, content: post.content, relayURL, origin, sendNtfy, media: stripUploaded(media),
    mediaUploaded: false, relayConfirmed: false, nextState, createdAt: Date.now(),
  };
  await savePending(dir, pending);

  // Real publish: upload only after the post is known-valid, then
  // confirm the upload matches the prepared attachment in the post.
  if (mediaFile) {
    const uploaded = await uploadMedia({ bytes: mediaFile.bytes, mime: mediaFile.mime, name: path.basename(imagePath), keypair, origin, fetchImpl, reply, replyto, timeoutMs: uploadTimeoutMs });
    if (uploaded.andfs !== media.andfs || uploaded.media_url !== media.media_url) {
      throw pendingError("Upload did not confirm the prepared attachment; pending record preserved", pending);
    }
    result.media = uploaded;
    pending.media = stripUploaded(uploaded);
    pending.mediaUploaded = true;
    await savePending(dir, pending);
  }

  const relay = createWiredoveRelay({ baseURL: relayURL, fetchImpl, timeoutMs: relayTimeoutMs });
  try {
    await relay.publish({ content: post.content, signature: post.signature, id: post.id });
  } catch (err) {
    throw pendingError(`Relay confirmation failed for post ${post.id} (${result.url}); the relay may have accepted it, so the pending record is preserved for resume`, pending);
  }
  pending.relayConfirmed = true;
  await savePending(dir, pending);

  try {
    await saveState(dir, nextState);
  } catch (err) {
    const wrapped = pendingError(`Relay confirmed post ${post.id}, but saving state failed (${err.message}); pending record preserved for resume`, pending);
    wrapped.cause = err;
    throw wrapped;
  }
  await deletePending(dir);
  result.notification = await sendNotifications({ signature: post.signature, content: post.content, fetchImpl, timeoutMs: ntfyTimeoutMs, sendNtfy });
  return result;
}

export async function publishProfile(opts = {}) {
  const dir = opts.dir || defaultDir();
  return withPublishLock(dir, () => publishProfileInner(opts), { timeoutMs: opts.lockTimeoutMs });
}

async function publishProfileInner({ name, bio, imagePath, dir = defaultDir(), relayURL = "https://pub.wiredove.net", origin = "https://wiredove.net", dryRun = false, sendNtfy = false, fetchImpl = fetch, ntfyTimeoutMs = 10000, relayTimeoutMs = 10000, uploadTimeoutMs = 60000 } = {}) {
  const keypair = await loadIdentity(dir);
  let state = await loadState(dir);
  assertStateBelongsToIdentity(state, an.pubkeyOf(keypair));

  const existingPending = await loadPending(dir);
  if (existingPending) {
    if (dryRun) throw pendingBlocksDryRun(existingPending);
    await completePending(existingPending, { dir, keypair, state, fetchImpl, relayURL: existingPending.relayURL || relayURL, origin, sendNtfy, mediaBytes: null, ntfyTimeoutMs, relayTimeoutMs, uploadTimeoutMs });
    state = await loadState(dir);
  }

  let mediaFile = null;
  let media = null;
  if (imagePath) {
    mediaFile = await readAndPrepareMedia(imagePath, origin);
    media = mediaFile.prepared;
  }
  const meta = {};
  if (bio !== undefined) meta.bio = bio;
  if (name || state.name) meta.name = name || state.name;
  if (media) meta.image = media.media_url;
  if (state.previous) meta.previous = state.previous;
  const post = await protocol.compose(keypair, "", meta);
  const result = { author: post.author, id: post.id, signature: post.signature, url: `https://wiredove.net/#${post.signature}`, content: post.content, media };
  if (dryRun) return { ...result, dryRun: true, notification: { attempted: false, delivered: false, reason: "dryRun", requests: 0, failures: [] } };

  const nextState = { ...state, pubkey: post.author, ...(meta.name ? { name: meta.name } : {}), previous: post.id };
  const pending = {
    version: 1, kind: "profile", author: post.author, id: post.id, signature: post.signature,
    url: result.url, content: post.content, relayURL, origin, sendNtfy, media: stripUploaded(media),
    mediaUploaded: false, relayConfirmed: false, nextState, createdAt: Date.now(),
  };
  await savePending(dir, pending);

  if (mediaFile) {
    const uploaded = await uploadMedia({ bytes: mediaFile.bytes, mime: mediaFile.mime, name: path.basename(imagePath), keypair, origin, fetchImpl, timeoutMs: uploadTimeoutMs });
    if (uploaded.andfs !== media.andfs || uploaded.media_url !== media.media_url) {
      throw pendingError("Upload did not confirm the prepared attachment; pending record preserved", pending);
    }
    result.media = uploaded;
    pending.media = stripUploaded(uploaded);
    pending.mediaUploaded = true;
    await savePending(dir, pending);
  }
  const relay = createWiredoveRelay({ baseURL: relayURL, fetchImpl, timeoutMs: relayTimeoutMs });
  try {
    await relay.publish({ content: post.content, signature: post.signature, id: post.id });
  } catch (err) {
    throw pendingError(`Relay confirmation failed for profile ${post.id} (${result.url}); the relay may have accepted it, so the pending record is preserved for resume`, pending);
  }
  pending.relayConfirmed = true;
  await savePending(dir, pending);
  try {
    await saveState(dir, nextState);
  } catch (err) {
    const wrapped = pendingError(`Relay confirmed profile ${post.id}, but saving state failed (${err.message}); pending record preserved for resume`, pending);
    wrapped.cause = err;
    throw wrapped;
  }
  await deletePending(dir);
  result.notification = await sendNotifications({ signature: post.signature, content: post.content, fetchImpl, timeoutMs: ntfyTimeoutMs, sendNtfy });
  return result;
}

export { an };
