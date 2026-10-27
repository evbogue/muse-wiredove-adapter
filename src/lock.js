// Cross-process publishing lock (work order 3).
//
// One lock file per identity directory, created exclusively ('wx') so
// the filesystem decides the winner — no check-then-create race.
// The lock file holds the owner's pid, so a lock whose owner is dead
// can be reclaimed; a lock whose owner is alive is never stolen.
// Waiting is bounded: after lockTimeoutMs the caller fails instead of
// hanging forever. Abandoned-lock reclamation is itself atomic
// (rename the stale file out of the way, then try 'wx' again), so two
// reclaimers cannot both win.
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const lockPath = (dir) => path.join(dir, "publish.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, but not ours to signal
  }
}

async function tryClaim(lockFile) {
  try {
    const handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n", "utf8");
    await handle.close();
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
}

async function tryReclaimAbandoned(lockFile) {
  let raw;
  try {
    raw = await readFile(lockFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return true; // released in the meantime
    throw err;
  }
  let ownerPid = null;
  try { ownerPid = JSON.parse(raw).pid; } catch {}
  const info = await stat(lockFile).catch(() => null);
  const ageMs = info ? Date.now() - info.mtimeMs : 0;
  const ownerDead = ownerPid !== null && !pidAlive(ownerPid);
  const emptyAndStale = raw.trim() === "" && ageMs > 2000;
  if (!ownerDead && !emptyAndStale) return false;
  // Atomic move: only one reclaimer can rename the stale file away.
  const staleName = `${lockFile}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockFile, staleName);
  } catch {
    return false;
  }
  await rm(staleName, { force: true }).catch(() => {});
  return true;
}

export async function acquireLock(dir, { timeoutMs = 30000, pollMs = 50 } = {}) {
  await mkdir(dir, { recursive: true });
  const lockFile = lockPath(dir);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryClaim(lockFile)) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockFile, { force: true }).catch(() => {});
      };
    }
    if (await tryReclaimAbandoned(lockFile)) continue;
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
