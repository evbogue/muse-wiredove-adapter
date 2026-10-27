import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIdentity, loadIdentity, loadState, validateKeypair } from "../src/identity.js";
import { publishPost } from "../src/publish.js";
import { an } from "../src/an.js";

// Work order 1: tests use isolated temp dirs and override inherited
// identity env settings, so a developer's real identity is never touched.
async function freshDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-id-"));
  process.env.MUSE_WIREDOVE_DIR = dir;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  return dir;
}

test("identity: repeat creation preserves the winning key and state byte-for-byte", async () => {
  const dir = await freshDir();
  const first = await createIdentity(dir, "First");
  const idBefore = await readFile(path.join(dir, "identity.txt"));
  const stateBefore = await readFile(path.join(dir, "state.json"));
  await assert.rejects(() => createIdentity(dir, "Second"), /already exists|already belongs/);
  assert.deepEqual(await readFile(path.join(dir, "identity.txt")), idBefore);
  assert.deepEqual(await readFile(path.join(dir, "state.json")), stateBefore);
  assert.equal((await loadIdentity(dir)), first.keypair);
});

test("identity: concurrent creation cannot replace the winning key", async () => {
  const dir = await freshDir();
  const results = await Promise.allSettled([createIdentity(dir, "A"), createIdentity(dir, "B")]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(await loadIdentity(dir), won[0].value.keypair);
});

test("identity: new secret files are mode 0600", async () => {
  const dir = await freshDir();
  await createIdentity(dir, "Mode");
  const mode = (await stat(path.join(dir, "identity.txt"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("identity: malformed keypairs are rejected without leaking key material", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "identity.txt"), "not-a-keypair\n");
  await assert.rejects(() => loadIdentity(dir), /Invalid identity keypair/);
  // A keypair whose secret does not match its public key: the good
  // seed paired with a different public key inside the secret.
  const good = await an.generate();
  const other = await an.generate();
  const seed = Buffer.from(good.slice(44), "base64").subarray(0, 32);
  const otherPub = Buffer.from(other.slice(0, 44), "base64");
  const bad = good.slice(0, 44) + Buffer.concat([seed, otherPub]).toString("base64");
  await writeFile(path.join(dir, "identity.txt"), bad + "\n");
  let err;
  try { await loadIdentity(dir); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(!err.message.includes(good.slice(0, 20)));
  assert.throws(() => validateKeypair(bad), /does not match/);
});

test("identity: state belonging to another identity blocks publishing", async () => {
  const dir = await freshDir();
  const first = await createIdentity(dir, "First");
  // Simulate a state file from a different identity:
  const other = await an.generate();
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ pubkey: an.pubkeyOf(other), previous: "x".repeat(43) + "=" }));
  await assert.rejects(
    () => publishPost({ text: "hi", dir, dryRun: true, fetchImpl: async () => { throw new Error("no network"); } }),
    /different identity/,
  );
  // And the original identity/state are untouched:
  assert.equal(await loadIdentity(dir), first.keypair);
});

test("identity: malformed state surfaces instead of being discarded", async () => {
  const dir = await freshDir();
  await createIdentity(dir, "First");
  await writeFile(path.join(dir, "state.json"), "{not json");
  await assert.rejects(() => loadState(dir), /not valid JSON/);
});
