// Pending publish records (work order 4).
//
// A pending record is written atomically before the first publishing
// side effect (media upload, relay gossip) and removed only after the
// confirmed history is durably saved. It contains the exact prepared
// content, signature, post id, author, and transport/media information
// needed to resume — never the private key. If a record ever contained
// a key field, it is rejected rather than used.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { protocol } from "./protocol.js";

export const pendingPath = (dir) => path.join(dir, "pending.json");

export async function loadPending(dir) {
  let raw;
  try {
    raw = await readFile(pendingPath(dir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`Cannot read pending record at ${pendingPath(dir)}: ${err.message}`);
  }
  let pending;
  try {
    pending = JSON.parse(raw);
  } catch {
    throw new Error(`Pending record at ${pendingPath(dir)} is not valid JSON; refusing to discard it`);
  }
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    throw new Error(`Pending record at ${pendingPath(dir)} has an invalid shape`);
  }
  if ("keypair" in pending || "secret" in pending || "privateKey" in pending) {
    throw new Error("Pending record contains key material; refusing to use it");
  }
  for (const field of ["id", "signature", "content", "author", "url"]) {
    if (typeof pending[field] !== "string" || !pending[field]) {
      throw new Error(`Pending record at ${pendingPath(dir)} is missing ${field}`);
    }
  }
  return pending;
}

export async function savePending(dir, pending) {
  const target = pendingPath(dir);
  await mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(pending, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}

export async function deletePending(dir) {
  await rm(pendingPath(dir), { force: true });
}

// Review finding 5: authenticate and validate a pending record before
// it is ever resumed, relayed, written to state, or deleted. The
// failure that motivated this: identity A's valid pending record
// copied into identity B's directory caused B to relay A's post and
// replace B's saved state with A's state. Verification rules:
//  - supported version and known kind;
//  - the saved signature opens and verifies against the saved
//    content (recomputed id must match; no tampered records);
//  - the signature's author must equal the loaded identity's pubkey;
//  - the proposed nextState is bound to the verified post
//    (pubkey == author, previous == post id);
//  - the record is not stale against saved history: the signed
//    `previous` must match state.previous, unless state already
//    reflects this post (the already-saved reconcile case);
//  - pending attachment metadata matches the signed content
//    (post: andfs + media_url; profile: image).
// Any violation throws a pendingError: no network request, no state
// write, no deletion — the record is preserved for diagnosis. Error
// messages never include the full unpublished body or key material.
export async function validatePending(pending, { pubkey, state } = {}) {
  const refuse = (message) => { throw pendingError(message, pending); };
  if (pending.version !== 1) refuse(`Pending record has unsupported version; refusing to use it`);
  if (pending.kind !== "post" && pending.kind !== "profile") refuse(`Pending record has unknown kind; refusing to use it`);
  if (typeof pending.relayURL !== "string" || !pending.relayURL) refuse(`Pending record has an invalid relayURL`);
  if (typeof pending.origin !== "string" || !pending.origin) refuse(`Pending record has an invalid origin`);
  if (typeof pending.createdAt !== "number") refuse(`Pending record has an invalid createdAt`);
  if (pending.mediaUploaded !== undefined && typeof pending.mediaUploaded !== "boolean") refuse(`Pending record has an invalid mediaUploaded flag`);
  if (pending.relayConfirmed !== undefined && typeof pending.relayConfirmed !== "boolean") refuse(`Pending record has an invalid relayConfirmed flag`);
  if (pending.url !== `https://wiredove.net/#${pending.signature}`) refuse(`Pending record url does not match its signature`);

  let verified;
  try {
    verified = await protocol.verify(pending.signature, pending.content);
  } catch (err) {
    refuse(`Pending ${pending.kind} record failed signature verification (${err.message}); the record is preserved for diagnosis`);
  }
  if (verified.id !== pending.id) refuse(`Pending record id does not match the id recomputed from its signature; the record is preserved for diagnosis`);
  if (verified.author !== pending.author) refuse(`Pending record author does not match its signature's author; the record is preserved for diagnosis`);
  if (pubkey && verified.author !== pubkey) refuse(`Pending ${pending.kind} was signed by a different identity than the loaded one; refusing to publish another identity's ${pending.kind}`);

  const nextState = pending.nextState;
  if (!nextState || typeof nextState !== "object" || Array.isArray(nextState)) refuse(`Pending record has an invalid nextState`);
  if (nextState.pubkey !== verified.author) refuse(`Pending nextState is not bound to the pending ${pending.kind}'s author; refusing to write it`);
  if (nextState.previous !== verified.id) refuse(`Pending nextState does not point at the pending ${pending.kind}'s id; refusing to write it`);

  const meta = verified.parsed || {};
  if (state && typeof state === "object") {
    const savedPrevious = state.previous === undefined ? undefined : state.previous;
    if (savedPrevious !== verified.id && (meta.previous || undefined) !== savedPrevious) {
      refuse(`Pending ${pending.kind} is stale: its signed previous no longer matches saved history; refusing to roll history backward`);
    }
  }

  const pendingMedia = pending.media || null;
  if (pending.kind === "post") {
    if ((meta.andfs || null) !== (pendingMedia?.andfs || null)) refuse(`Pending media andfs does not match the signed post's metadata`);
    if ((meta.media_url || null) !== (pendingMedia?.media_url || null)) refuse(`Pending media_url does not match the signed post's metadata`);
  } else {
    if ((meta.image || null) !== (pendingMedia?.media_url || null)) refuse(`Pending media_url does not match the signed profile's metadata`);
  }
  return verified;
}

// An error that carries the pending post's identity, so a caller can
// report an uncertain outcome instead of losing the post entirely.
export function pendingError(message, pending) {
  const err = new Error(message);
  err.pending = true;
  err.postId = pending.id;
  err.url = pending.url;
  err.pendingRecord = pending;
  return err;
}
