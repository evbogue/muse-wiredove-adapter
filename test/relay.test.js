import test from "node:test";
import assert from "node:assert/strict";
import { an } from "../src/an.js";
import { createWiredoveRelay } from "../src/relay.js";

// Replaces the old misleading relay test, which only called gossip
// directly. These tests call relay.publish and verify the full
// content -> signature -> id confirmation flow.
async function signPost(content) {
  const keypair = await an.generate();
  const signature = await an.sign(await an.hash(content), keypair);
  return { signature, id: await an.hash(signature) };
}

test("relay: publish confirms via gossip(id) returning the signature", async () => {
  const { signature, id } = await signPost("hello relay");
  const seen = [];
  const relay = createWiredoveRelay({
    baseURL: "https://example.test",
    fetchImpl: async (url, opts) => {
      seen.push(opts.body);
      const isId = opts.body === id;
      return { ok: true, json: async () => ({ messages: isId ? [signature] : [] }) };
    },
  });
  await relay.publish({ content: "hello relay", signature, id });
  assert.deepEqual(seen, ["hello relay", signature, id]);
});

test("relay: missing confirmation is rejected", async () => {
  const { signature, id } = await signPost("hello relay");
  const relay = createWiredoveRelay({
    baseURL: "https://example.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ messages: [] }) }),
  });
  await assert.rejects(() => relay.publish({ content: "hello relay", signature, id }), /has not confirmed/);
});

test("relay: HTTP failure is rejected", async () => {
  const { signature, id } = await signPost("hello relay");
  const relay = createWiredoveRelay({
    baseURL: "https://example.test",
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => relay.publish({ content: "hello relay", signature, id }), /500/);
});
