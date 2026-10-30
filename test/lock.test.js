import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  acquireLock,
  lockPath,
  withPublishLock,
  _releaseIfMine,
  _tryReclaimAbandoned,
} from "../src/lock.js";

const run = promisify(execFile);
const freshDir = () => mkdtemp(path.join(tmpdir(), "muse-wiredove-lock-"));
const DEAD_PID = 999999; // assumed not alive on the test machine
const staleLock = (over = {}) =>
  JSON.stringify({ pid: DEAD_PID, token: "dead-owner", createdAt: 1, ...over }) + "\n";

test("lock: second reclaimer backs off while the first holds the marker", async () => {
  const dir = await freshDir();
  const lockFile = lockPath(dir);
  await writeFile(lockFile, staleLock());
  // Simulate a first reclaimer mid-reclaim: a live marker installed directly.
  const marker = `${lockFile}.reclaim`;
  await writeFile(marker, JSON.stringify({ pid: process.pid, token: "r1", at: Date.now() }) + "\n");
  const before = await readFile(lockFile, "utf8");

  const res = await _tryReclaimAbandoned(lockFile, "r2");
  assert.equal(res, false, "second reclaimer must back off, not win");
  assert.equal(await readFile(lockFile, "utf8"), before, "stale lock must be untouched");

  // First reclaimer finishes; the second now deterministically wins.
  await rm(marker, { force: true });
  const res2 = await _tryReclaimAbandoned(lockFile, "r2");
  assert.equal(res2, "won");
  assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, "r2");
  assert.equal(await _releaseIfMine(lockFile, "r2"), true);
});

test("lock: dead marker is taken over, live marker is not", async () => {
  const dir = await freshDir();
  const lockFile = lockPath(dir);
  await writeFile(lockFile, staleLock());
  const marker = `${lockFile}.reclaim`;
  // Dead owner's marker: take-over must succeed.
  await writeFile(marker, JSON.stringify({ pid: DEAD_PID, token: "gone", at: 1 }) + "\n");
  assert.equal(await _tryReclaimAbandoned(lockFile, "r3"), "won");
  assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, "r3");
  assert.equal(await _releaseIfMine(lockFile, "r3"), true);
});

test("lock: release never removes a newer owner's lock", async () => {
  const dir = await freshDir();
  const lockFile = lockPath(dir);
  const release = await acquireLock(dir, { timeoutMs: 2000 });
  // Simulate a newer owner taking the path (e.g. after a reclaim race).
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, token: "newer", createdAt: Date.now() }) + "\n");
  await release();
  assert.equal(
    JSON.parse(await readFile(lockFile, "utf8")).token,
    "newer",
    "stale release deleted a newer owner's lock"
  );
  // Releasing twice, or releasing an already-removed lock, is a safe no-op.
  await release();
  assert.equal(await _releaseIfMine(lockFile, "nope"), false);
  assert.equal(await _releaseIfMine(lockFile, "newer"), true);
});

test("lock: live lock is never stolen; waiter times out", async () => {
  const dir = await freshDir();
  const lockFile = lockPath(dir);
  const release = await acquireLock(dir, { timeoutMs: 2000 });
  const mine = JSON.parse(await readFile(lockFile, "utf8")).token;
  await assert.rejects(() => acquireLock(dir, { timeoutMs: 300, pollMs: 25 }), /Timed out/);
  assert.equal(
    JSON.parse(await readFile(lockFile, "utf8")).token,
    mine,
    "live lock was stolen while held"
  );
  await release();
});

test("lock: empty file from a crashed writer is reclaimed once stale", async () => {
  const dir = await freshDir();
  const lockFile = lockPath(dir);
  await writeFile(lockFile, "");
  await utimes(lockFile, new Date(0), new Date(0)); // ancient mtime: definitely stale
  const release = await acquireLock(dir, { timeoutMs: 2000 });
  const cur = JSON.parse(await readFile(lockFile, "utf8"));
  assert.equal(cur.pid, process.pid);
  await release();
});

test("lock: terminated owner's lock is recovered by another process", async () => {
  const dir = await freshDir();
  const helper = path.join(import.meta.dirname, "helpers", "lock-child.mjs");
  const results = path.join(dir, "results.log");
  // Attach the rejection handler immediately: the child dies by SIGKILL,
  // so its promise rejects as soon as it exits (possibly before we poll).
  const child = run("node", [helper, "killself", dir, results]).catch(() => null);
  // Wait for the child to hold the lock, then for it to die by SIGKILL.
  const ready = `${results}.ready`;
  const start = Date.now();
  for (;;) {
    try {
      await readFile(ready);
      break;
    } catch {
      if (Date.now() - start > 10000) throw new Error("child never took the lock");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await child; // SIGKILL: exits with signal, not code 0 (rejection already swallowed)
  const release = await acquireLock(dir, { timeoutMs: 8000 });
  const cur = JSON.parse(await readFile(lockPath(dir), "utf8"));
  assert.equal(cur.pid, process.pid, "abandoned lock was not reclaimed");
  await release();
});

test("lock: racing processes on one stale lock never overlap", async () => {
  const dir = await freshDir();
  await writeFile(lockPath(dir), staleLock());
  const helper = path.join(import.meta.dirname, "helpers", "lock-child.mjs");
  const results = path.join(dir, "results.log");
  await writeFile(results, "");
  const N = 4;
  await Promise.all(
    Array.from({ length: N }, () => run("node", [helper, "race", dir, results], { timeout: 60000 }))
  );
  const lines = (await readFile(results, "utf8")).trim().split("\n");
  const starts = new Map();
  const ends = new Map();
  for (const line of lines) {
    const [kind, pid, token, ts] = line.split(" ");
    if (kind === "start") starts.set(pid, { token, ts: Number(ts) });
    if (kind === "end") ends.set(pid, { token, ts: Number(ts) });
  }
  assert.equal(starts.size, N, `expected ${N} acquisitions, got: ${lines.join("; ")}`);
  assert.equal(ends.size, N);
  const tokens = new Set([...starts.values()].map((s) => s.token));
  assert.equal(tokens.size, N, "two processes shared one lock token");
  const intervals = [...starts.entries()].map(([pid, s]) => ({ pid, ...s, end: ends.get(pid).ts }));
  for (const iv of intervals) assert.ok(iv.end > iv.ts, "hold interval inverted");
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i];
      const b = intervals[j];
      const overlap = a.ts < b.end && b.ts < a.end;
      assert.ok(!overlap, `overlapping lock holders: ${a.pid} and ${b.pid}`);
    }
  }
});

test("lock: concurrent post and profile sections stay serial", async () => {
  const dir = await freshDir();
  const order = [];
  await Promise.all(
    [1, 2, 3].map((i) =>
      withPublishLock(dir, async () => {
        order.push(`in-${i}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`out-${i}`);
        return i;
      })
    )
  );
  assert.equal(order.length, 6);
  for (let k = 0; k < order.length; k += 2) {
    assert.match(order[k], /^in-/);
    assert.equal(order[k + 1], `out-${order[k].slice(3)}`, `critical sections interleaved: ${order}`);
  }
});
