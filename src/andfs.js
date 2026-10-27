// AndFS v1 media upload, following wiredove's client/andfs.js and
// vendor/andfs/andfs.js: 256 KiB chunks, SHA-256 chunk hashes in
// URL-safe base64, manifest = JSON {andfs:1, size, chunkSize, chunks},
// manifestHash = hash(manifest bytes). The server must confirm the same
// manifest hash, mime, and size back.
import { an } from "./an.js";

export const CHUNK_SIZE = 262144;
export const MAX_BYTES = 32 * 1024 * 1024;
export const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav", "audio/x-wav",
  "video/mp4", "video/ogg", "video/webm",
]);

async function sha256UrlSafe(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Buffer.from(digest).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function andfsManifest(bytes) {
  const chunks = [];
  for (let off = 0; off < bytes.length || chunks.length === 0; off += CHUNK_SIZE) {
    chunks.push(await sha256UrlSafe(bytes.subarray(off, off + CHUNK_SIZE)));
    if (bytes.length === 0) break;
  }
  const manifest = new TextEncoder().encode(JSON.stringify({ andfs: 1, size: bytes.length, chunkSize: CHUNK_SIZE, chunks }));
  return { manifestHash: await sha256UrlSafe(manifest), manifest };
}

// Local-only media preparation (work order 2): validation, manifest
// calculation, and metadata, with no network access. The returned
// media_url is calculated, not uploaded — callers must label it as
// such (uploaded: false) until uploadMedia confirms it.
export async function prepareMedia({ bytes, mime, name, origin = "https://wiredove.net", reply, replyto }) {
  if (!ALLOWED_MIME.has(mime)) throw new Error(`Unsupported media format: ${mime}`);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Media must be between 1 byte and 32 MiB");
  if (Boolean(reply) !== Boolean(replyto)) throw new Error("A media reply requires both reply and replyto");
  const { manifestHash } = await andfsManifest(bytes);
  return {
    type: mime.split("/")[0], andfs: manifestHash, mime,
    media_name: name || `${mime.split("/")[0]}-${Date.now()}`,
    media_size: bytes.length, media_url: `${origin}/media/${manifestHash}`, media_source: origin,
    uploaded: false,
  };
}

export async function uploadMedia({ bytes, mime, name, keypair, origin = "https://wiredove.net", fetchImpl = fetch, reply, replyto }) {
  const prepared = await prepareMedia({ bytes, mime, name, origin, reply, replyto });
  const { manifestHash } = prepared;
  const authorization = JSON.stringify({
    action: "andfs-upload-v1", andfs: manifestHash, mime, media_size: bytes.length,
    ...(reply ? { reply } : {}), ...(replyto ? { replyto } : {}),
  });
  const response = await fetchImpl(`${origin}/api/media`, {
    method: "POST",
    body: bytes,
    headers: {
      "X-ANProto-Content": authorization,
      "X-ANProto-Signature": await an.sign(await an.hash(authorization), keypair),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let message = detail;
    try { message = JSON.parse(detail).error || detail; } catch {}
    throw new Error(message || `Upload failed (${response.status})`);
  }
  const saved = await response.json();
  if (saved.andfs !== manifestHash || saved.mime !== mime || saved.media_size !== bytes.length) {
    throw new Error("Upload server did not confirm the expected AndFS attachment");
  }
  return { ...prepared, uploaded: true };
}
