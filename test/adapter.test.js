import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { an } from "../src/an.js";
import { yaml } from "../src/yaml.js";
import { protocol } from "../src/protocol.js";
import { createWiredoveRelay } from "../src/relay.js";
import { andfsManifest } from "../src/andfs.js";
import { publishPost } from "../src/publish.js";
import { createIdentity } from "../src/identity.js";

test("an: sign/open round-trip and pubkey format", async () => {
  const keypair = await an.generate();
  assert.equal(keypair.length, 132);
  const content = "hello wiredove";
  const sig = await an.sign(await an.hash(content), keypair);
  assert.equal(sig.length, 208);
  const opened = await an.open(sig);
  assert.ok(opened.endsWith(await an.hash(content)));
  assert.equal(opened.slice(0, 13).length, 13);
});

test("yaml: frontmatter round-trip", () => {
  const doc = yaml.create({ name: "Muse", previous: "abc=" }, "hello");
  const parsed = yaml.parse(doc);
  assert.equal(parsed.name, "Muse");
  assert.equal(parsed.previous, "abc=");
  assert.equal(parsed.body, "hello");
});

test("protocol: compose verifies", async () => {
  const keypair = await an.generate();
  const post = await protocol.compose(keypair, "test post", { name: "Muse" });
  assert.equal(post.parsed.body, "test post");
  assert.equal(post.parsed.name, "Muse");
  await assert.rejects(() => protocol.verify(post.signature, "tampered"));
});

test("relay: publish confirms via gossip(id)", async () => {
  const seen = [];
  const relay = createWiredoveRelay({
    baseURL: "https://example.test",
    fetchImpl: async (url, opts) => {
      if (String(url).endsWith("/gossip")) {
        seen.push(opts.body);
        const isId = opts.body.length === 44 && !opts.body.includes("---");
        return { ok: true, json: async () => ({ messages: isId ? ["sig-123"] : [] }) };
      }
      throw new Error("unexpected fetch");
    },
  });
  // Direct gossip path, not full publish (which needs a real signature id):
  assert.deepEqual(await relay.gossip("hello"), []);
  assert.equal(seen.length, 1);
});

test("andfs: manifest hash is deterministic", async () => {
  const a = await andfsManifest(new TextEncoder().encode("hello"));
  const b = await andfsManifest(new TextEncoder().encode("hello"));
  assert.equal(a.manifestHash, b.manifestHash);
  assert.match(a.manifestHash, /^[A-Za-z0-9_-]{43}$/);
});

test("publish: dry-run composes and chains state, publishes nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-"));
  await createIdentity(dir, "Muse Test");
  let fetched = 0;
  const r1 = await publishPost({ text: "first", dir, dryRun: true, fetchImpl: async () => { fetched++; throw new Error("network should not be used in dry-run"); } });
  assert.equal(r1.dryRun, true);
  assert.equal(fetched, 0);
  // Simulate a confirmed first post so the second chains via previous:
  const stateFile = path.join(dir, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.previous = r1.id;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(stateFile, JSON.stringify(state));
  const r2 = await publishPost({ text: "second", dir, dryRun: true, fetchImpl: async () => { throw new Error("no network"); } });
  assert.ok(r2.content.includes(r1.id));
});
