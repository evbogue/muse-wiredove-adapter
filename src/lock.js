// Cross-process publishing lock (work order 3; review finding 3).
//
// Protocol
// --------
// One lock file per identity directory: <dir>/publish.lock holding
// JSON { pid, token, createdAt }. `token` is a random value unique to
// each acquisition; ownership means "the lock file currently contains
// my token".
//
// - Claim: atomic exclusive create (write a complete temp file, then
//   hard-link it onto the lock path, which fails with EEXIST when the
//   path exists). The filesystem decides the winner: no
//   check-then-create race, and readers never observe a half-written
//   lock file.
// - Release: removes the lock file only when its token still matches
//   the releaser's token, so a stale release can never delete a newer
//   owner's lock.
// - Reclaim: a lock whose owner pid is dead (kill(pid, 0) fails with
//   anything but EPERM), or an empty file older than EMPTY_STALE_MS
//   (crashed between create and write), may be reclaimed. Reclaimers
//   are serialized by a marker file <lock>.reclaim, itself installed
//   by atomic exclusive link. Only the marker holder may replace the
//   stale lock (temp file + atomic rename, then a post-claim token
//   verification), so two reclaimers can never both win: the loser
//   either fails the marker race and backs off, or finds a live owner
//   and waits. A lock whose owner is alive is never touched.
// - Waiting is bounded: after timeoutMs the caller throws instead of
//   hanging forever.
//
// Assumptions (single machine, local filesystem)
// ----------------------------------------------
// - The identity directory is on a local filesystem where hard-link
//   creation is atomic and fails with EEXIST when the target exists,
//   and where rename is atomic.
// - Process liveness is meaningful: kill(pid, 0) tells whether the
//   locking process is alive. A recycled pid that happens to be alive
//   only delays acquisition until timeout (fail-safe: never steals).
// - A marker whose recorded pid is dead is taken over by the next
//   reclaimer (atomic rename + byte-compare, so exactly one take-over
//   wins), hence a crash mid-reclaim cannot deadlock. A live
//   reclaimer's marker is never taken: contenders back off and their
//   own acquireLock still times out rather than stealing.
// - Residual: the protocol assumes the marker race above is the only
//   serialization point needed. A pathological triple interleave (a
//   reclaimer acting on a stale read while a fresh claim lands in the
//   microsecond window of a third party's exclusive create) is not
//   fully excluded; it would require three processes to interleave
//   within microseconds and is not exercised by the acceptance tests.
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const lockPath = (dir) => path.join(dir, "publish.lock");
const markerPath = (lockFile) => `${lockFile}.reclaim`;
const EMPTY_STALE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newToken = () => randomBytes(16).toString("hex");

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, but not ours to signal
  }
}

function parseRecord(raw) {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") {
      return {
        pid: Number.isInteger(v.pid) ? v.pid : null,
        token: typeof v.token === "string" ? v.token : null,
      };
    }
  } catch {}
  return { pid: null, token: null };
}

// Atomic exclusive create: write a complete temp file, then hard-link
// it onto `target`. Returns true on success, false when the target
// already exists. Readers always see complete content or nothing.
async function atomicCreate(target, content) {
  const tmp = `${target}.tmp-${process.pid}-${newToken()}`;
  await writeFile(tmp, content, { mode: 0o600 });
  try {
    await link(tmp, target);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function tryClaim(lockFile, token) {
  return atomicCreate(
    lockFile,
    JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }) + "\n"
  );
}

// Remove the lock file only when it still holds `token`.
// Returns true when the file was removed by this call.
export async function _releaseIfMine(lockFile, token) {
  const cur = parseRecord(await readFile(lockFile, "utf8").catch(() => ""));
  if (cur.token !== token) return false; // released already, or a newer owner holds it
  await rm(lockFile, { force: true }).catch(() => {});
  return true;
}

// Attempt to reclaim an abandoned lock. Returns "won" when this call
// now owns the lock, "gone" when the lock vanished mid-attempt (caller
// should retry a plain claim), or false when there is nothing to
// reclaim or another reclaimer is active. Exported for deterministic
// scheduling tests; prefer acquireLock otherwise.
export async function _tryReclaimAbandoned(lockFile, token) {
  const marker = markerPath(lockFile);
  const myMarker = JSON.stringify({ pid: process.pid, token, at: Date.now() }) + "\n";
  if (!(await atomicCreate(marker, myMarker))) {
    // Another reclaimer may hold the marker. Take over only a dead owner's.
    const mraw = await readFile(marker, "utf8").catch(() => "");
    const other = parseRecord(mraw);
    if (other.pid !== null && pidAlive(other.pid)) return false; // live reclaimer: back off
    // Atomically move the stale marker aside: exactly one take-over wins.
    const moved = `${marker}.takeover-${process.pid}-${token}`;
    try {
      await rename(marker, moved);
    } catch {
      return false;
    }
    const mcontent = await readFile(moved, "utf8").catch(() => null);
    await rm(moved, { force: true }).catch(() => {});
    if (mcontent !== mraw) return false; // changed under us; do not proceed
    if (!(await atomicCreate(marker, myMarker))) return false; // someone installed first
  }
  try {
    return await _reclaimHoldingMarker(lockFile, token);
  } finally {
    // Only clear the marker when it is still ours.
    const cur = await readFile(marker, "utf8").catch(() => null);
    if (cur === myMarker) await rm(marker, { force: true }).catch(() => {});
  }
}

async function _reclaimHoldingMarker(lockFile, token) {
  let raw;
  try {
    raw = await readFile(lockFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "gone"; // released in the meantime
    throw err;
  }
  const { pid } = parseRecord(raw);
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(lockFile)).mtimeMs;
  } catch {}
  const ownerDead = pid !== null && !pidAlive(pid);
  const crashedMidWrite = raw.trim() === "" && Date.now() - mtimeMs > EMPTY_STALE_MS;
  if (!ownerDead && !crashedMidWrite) return false; // live owner: never steal
  // Marker held: no other reclaimer can interleave, no new owner can
  // appear (claims need the path absent; the owner is dead), so
  // replacing the stale lock here is safe. The path is never absent,
  // so no plain claimer can slip in mid-replace either.
  const tmp = `${lockFile}.claim-${process.pid}-${token}`;
  await writeFile(
    tmp,
    JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }) + "\n",
    { mode: 0o600 }
  );
  await rename(tmp, lockFile);
  // Post-claim verification: the lock file must contain our token.
  const cur = parseRecord(await readFile(lockFile, "utf8").catch(() => ""));
  return cur.token === token ? "won" : false;
}

export async function acquireLock(dir, { timeoutMs = 30000, pollMs = 50 } = {}) {
  await mkdir(dir, { recursive: true });
  const lockFile = lockPath(dir);
  const token = newToken();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryClaim(lockFile, token)) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await _releaseIfMine(lockFile, token);
      };
    }
    const reclaimed = await _tryReclaimAbandoned(lockFile, token);
    if (reclaimed === "won") {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await _releaseIfMine(lockFile, token);
      };
    }
    // "gone" loops straight back to the plain claim; false means a live
    // owner or an active reclaimer: wait, then time out rather than steal.
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the publishing lock at ${lockFile}; another publisher may be active`);
    }
    await sleep(pollMs);
  }
}

export async function withPublishLock(dir, fn, opts) {
  const release = await acquireLock(dir, opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}
