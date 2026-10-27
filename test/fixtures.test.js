import test from "node:test";
import assert from "node:assert/strict";
import { an } from "../src/an.js";
import { andfsManifest } from "../src/andfs.js";

// Independent fixtures, NOT self-round-trips.
//
// Provenance (generated 2026-10-27, Node v24.22.1):
// - ANProto signature: wiredove's vendored upstream implementation,
//   vendor/anproto/an.js (TweetNaCl-based), from the wiredove clone at
//   master ed19ca1 (~/workspace/wiredove-fresh-scan/wiredove). The
//   upstream signer was run with its PRNG wired to WebCrypto, signed
//   the SHA-256 hash of "hello wiredove", and the resulting keypair,
//   hash, and signature were recorded verbatim below.
// - AndFS manifests: wiredove's vendored upstream implementation,
//   vendor/andfs/andfs.js, same clone. Chunk hashes and manifest
//   hashes below were computed by that upstream code and matched by
//   the adapter's andfsManifest at generation time.

// Only the public key is recorded here, never the generated keypair:
// the upstream private key was used once to sign and then discarded.
const UPSTREAM_PUBKEY = "eCxIuOj5aDjWS6yrI7IdYbAPaqc0ZtumND+iMrNQDUw=";
const UPSTREAM_HASH = "Jr8Kw/m78d1oTAYpBtr9KdF1nBHx7HGzUrPc60ng1/I=";
const UPSTREAM_SIGNATURE = "eCxIuOj5aDjWS6yrI7IdYbAPaqc0ZtumND+iMrNQDUw=QlthBsbVyvMGi0rcJw9IGqY2MzJJbJ9uqKJA+dGlva5lJiZduHb3g+RmVziyLRm3rCdJNAgzlGNi2SEzVonsCzE3OTMxMzc5MjU1NThKcjhLdy9tNzhkMW9UQVlwQnRyOUtkRjFuQkh4N0hHelVyUGM2MG5nMS9JPQ==";

test("fixtures: adapter opens an upstream ANProto signature", async () => {
  assert.equal(UPSTREAM_PUBKEY.length, 44);
  assert.equal(UPSTREAM_SIGNATURE.length, 208);
  assert.equal(await an.hash("hello wiredove"), UPSTREAM_HASH);
  const opened = await an.open(UPSTREAM_SIGNATURE);
  assert.ok(opened.endsWith(UPSTREAM_HASH), "opened payload must end with the upstream content hash");
  assert.equal(UPSTREAM_PUBKEY, UPSTREAM_SIGNATURE.slice(0, 44));
  await assert.rejects(() => an.open(UPSTREAM_SIGNATURE.slice(0, -4) + "AAAA"));
});

const MANIFEST_CASES = [
  { label: "hello (single chunk)", bytes: new TextEncoder().encode("hello"), chunks: ["LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"], manifestHash: "i-tcfghzY_bzlUhL2vhQlhGe-f9sDuiEcF7ys2vkrVc" },
  { label: "empty (single empty chunk)", bytes: new Uint8Array(0), chunks: ["47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"], manifestHash: "m105n21ymSb_rrW3y7LoBrCzS_TREJLAq5gE4KQw11k" },
  { label: "exactly one chunk (262,144 bytes of 'a')", bytes: new Uint8Array(262144).fill(97), chunks: ["3T3eh2I9mms1TGjJQ9GJyJxjZS2UXnu98JhsrpGklSE"], manifestHash: "cH2I7eLVytJgapxK8JDs2m9xjaxrmblKhm14-RTDkpI" },
  { label: "chunk boundary +1 (262,145 bytes of 'b')", bytes: new Uint8Array(262145).fill(98), chunks: ["niQOrOWekCVGtcd3zsi4wgAXkV0uDshVgNXMe1htp90", "PiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0"], manifestHash: "Y_r6yhh-1vuXO4QeOFHFP_1-W1x-1HjGMUR-nO66gnA" },
  { label: "multi-chunk (600,000 bytes of 'c')", bytes: new Uint8Array(600000).fill(99), chunks: ["pDIfS8TOLd8OmHkobi8SIOzhDKMEB827VHXMRaCUzZ4", "pDIfS8TOLd8OmHkobi8SIOzhDKMEB827VHXMRaCUzZ4", "mAO58JZqyoeDJRzK50UMcm7Nxqla3JDJ6ChzB1--Wh4"], manifestHash: "A838Khvxe2f9fGcmny6yRwV9bHqPNtIbsD0vxb4JMx4" },
];

for (const c of MANIFEST_CASES) {
  test(`fixtures: AndFS manifest matches upstream — ${c.label}`, async () => {
    const { manifestHash, manifest } = await andfsManifest(c.bytes);
    assert.equal(manifestHash, c.manifestHash);
    const parsed = JSON.parse(new TextDecoder().decode(manifest));
    assert.deepEqual(parsed.chunks, c.chunks);
    assert.equal(parsed.size, c.bytes.length);
    assert.equal(parsed.chunkSize, 262144);
  });
}
