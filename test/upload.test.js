import test from "node:test";
import assert from "node:assert/strict";
import { an } from "../src/an.js";
import { uploadMedia, prepareMedia } from "../src/andfs.js";

// Regression test for a live-server bug found 2026-10-27: uploadMedia
// was sending an authorization JSON without the `andfs` field
// (it destructured `manifestHash` from a prepared object that carries
// the hash as `andfs`), so wiredove.net rejected every upload with
// "Unsupported media or size". Mocked tests that echoed the header
// back masked it. This test validates the header strictly, like the
// real server does.
test("upload: authorization header contains andfs, mime, and media_size", async () => {
  const keypair = await an.generate();
  const bytes = new TextEncoder().encode("hello upload");
  const prepared = await prepareMedia({ bytes, mime: "image/png", name: "hello.png" });
  let seenAuth = null;
  const result = await uploadMedia({
    bytes, mime: "image/png", name: "hello.png", keypair,
    fetchImpl: async (url, opts) => {
      seenAuth = JSON.parse(opts.headers["X-ANProto-Content"]);
      assert.equal(seenAuth.action, "andfs-upload-v1");
      assert.equal(seenAuth.andfs, prepared.andfs);
      assert.equal(seenAuth.mime, "image/png");
      assert.equal(seenAuth.media_size, bytes.length);
      return {
        ok: true,
        json: async () => ({ andfs: seenAuth.andfs, mime: seenAuth.mime, media_size: seenAuth.media_size }),
      };
    },
  });
  assert.equal(result.andfs, prepared.andfs);
  assert.equal(result.uploaded, true);
});
