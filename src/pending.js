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
