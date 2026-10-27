import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { yaml } from "../src/yaml.js";
import { protocol } from "../src/protocol.js";
import { publishPost, publishProfile } from "../src/publish.js";
import { createIdentity } from "../src/identity.js";

// Work order 6 compatibility fixtures. The wire format is apds
// lib/yaml.js (evbogue/apds@e091911): "---\n\n<yaml>\n---\n\n<body>",
// with js-yaml dump({}) === "{}\n" for empty metadata.

test("yaml: empty metadata round-trips, body is exactly the body", () => {
  const doc = yaml.create({}, "hello");
  assert.equal(doc, "---\n\n{}\n---\n\nhello");
  assert.equal(yaml.parse(doc).body, "hello");
  assert.deepEqual(Object.keys(yaml.parse(doc)), ["body"]);
});

test("yaml: populated metadata round-trips", () => {
  const doc = yaml.create({ name: "Muse", previous: "abc=" }, "hello");
  const parsed = yaml.parse(doc);
  assert.equal(parsed.name, "Muse");
  assert.equal(parsed.previous, "abc=");
  assert.equal(parsed.body, "hello");
});

test("yaml: escaped strings round-trip", () => {
  const tricky = 'say "hi" \\ backslash\nnewline\tand: colon';
  const parsed = yaml.parse(yaml.create({ name: tricky, bio: "it's" }, "body"));
  assert.equal(parsed.name, tricky);
  assert.equal(parsed.bio, "it's");
});

test("yaml: numeric fields round-trip as numbers", () => {
  const parsed = yaml.parse(yaml.create({ media_size: 12345, count: 0 }, "body"));
  assert.equal(parsed.media_size, 12345);
  assert.equal(parsed.count, 0);
});

test("yaml: empty body and multiline body round-trip", () => {
  assert.equal(yaml.parse(yaml.create({ name: "Muse" }, "")).body, "");
  const multi = "line one\nline two\n\nline four";
  assert.equal(yaml.parse(yaml.create({ name: "Muse" }, multi)).body, multi);
});

test("yaml: metadata-only profile post round-trips", () => {
  const parsed = yaml.parse(yaml.create({ name: "Muse", bio: "hello" }, ""));
  assert.equal(parsed.name, "Muse");
  assert.equal(parsed.bio, "hello");
  assert.equal(parsed.body, "");
});

test("yaml: legacy empty-metadata documents still parse", () => {
  assert.equal(yaml.parse("---\n\n---\n\nhello").body, "hello");
});

test("yaml: unnamed identity's first text post round-trips", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-yaml-"));
  process.env.MUSE_WIREDOVE_DIR = dir;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir); // no name, no previous
  const result = await publishPost({ text: "first post, no name", dir, dryRun: true, fetchImpl: async () => { throw new Error("no network"); } });
  const parsed = yaml.parse(result.content);
  assert.equal(parsed.body, "first post, no name");
  // And the composed post verifies through protocol (which parses):
  const keypair = (await import("../src/identity.js")).loadIdentity;
  const post = await protocol.compose(await keypair(dir), "first post, no name", {});
  assert.equal(post.parsed.body, "first post, no name");
});

test("yaml: profile post with no name metadata still parses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-wiredove-yaml-"));
  process.env.MUSE_WIREDOVE_DIR = dir;
  delete process.env.MUSE_WIREDOVE_IDENTITY;
  await createIdentity(dir);
  const result = await publishProfile({ dir, dryRun: true, fetchImpl: async () => { throw new Error("no network"); } });
  assert.equal(yaml.parse(result.content).body, "");
});
