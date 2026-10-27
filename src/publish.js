// Publish a Wiredove post without a browser, following wiredove's
// composer.js flow: compose -> verify -> ntfy(signed) + ntfy(content) ->
// relay gossip(content, signature), confirmed by gossip(id).
// Media goes through AndFS first (see andfs.js), then its media_url is
// appended to the body if it is not already there, exactly like the
// website composer does.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { protocol } from "./protocol.js";
import { createWiredoveRelay } from "./relay.js";
import { uploadMedia } from "./andfs.js";
import { an } from "./an.js";
import { loadIdentity, loadState, saveState, defaultDir } from "./identity.js";

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "audio/ogg", ".wav": "audio/wav" };

async function ntfy(value) {
  await fetch("https://ntfy.sh/wiredove", { method: "POST", body: `https://wiredove.net/#${value}` });
}

export async function publishPost({
  text = "", imagePath, name, reply, replyto, previous,
  dir = defaultDir(), relayURL = "https://pub.wiredove.net",
  origin = "https://wiredove.net", dryRun = false, sendNtfy = true,
  fetchImpl = fetch,
} = {}) {
  const keypair = await loadIdentity(dir);
  const state = await loadState(dir);
  let media = null;
  if (imagePath) {
    const bytes = new Uint8Array(await readFile(imagePath));
    const ext = path.extname(imagePath).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) throw new Error(`Unknown media type for ${imagePath}`);
    media = await uploadMedia({ bytes, mime, name: path.basename(imagePath), keypair, origin, fetchImpl, reply, replyto });
  }
  let body = text;
  if (media && !body.includes(media.media_url)) body = [body.trim(), media.media_url].filter(Boolean).join("\n\n");
  if (!body.trim() && !media) throw new Error("Nothing to post: give --text and/or --image");

  const meta = {};
  const displayName = name || state.name;
  if (displayName) meta.name = displayName;
  const prev = previous || state.previous;
  if (prev) meta.previous = prev;
  if (reply) meta.reply = reply;
  if (replyto) meta.replyto = replyto;
  if (media) Object.assign(meta, media);

  const post = await protocol.compose(keypair, body, meta);
  const result = {
    author: post.author, id: post.id, signature: post.signature,
    url: `https://wiredove.net/#${post.signature}`, content: post.content, media,
  };
  if (dryRun) return { ...result, dryRun: true };

  const relay = createWiredoveRelay({ baseURL: relayURL, fetchImpl });
  await relay.publish({ content: post.content, signature: post.signature, id: post.id });
  if (sendNtfy) { try { await ntfy(post.signature); await ntfy(post.content); } catch {} }
  await saveState(dir, { ...state, pubkey: post.author, ...(displayName ? { name: displayName } : {}), previous: post.id });
  return result;
}

export async function publishProfile({ name, bio, imagePath, dir = defaultDir(), relayURL = "https://pub.wiredove.net", origin = "https://wiredove.net", dryRun = false, fetchImpl = fetch } = {}) {
  const keypair = await loadIdentity(dir);
  const state = await loadState(dir);
  let media = null;
  if (imagePath) {
    const bytes = new Uint8Array(await readFile(imagePath));
    const ext = path.extname(imagePath).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) throw new Error(`Unknown media type for ${imagePath}`);
    media = await uploadMedia({ bytes, mime, name: path.basename(imagePath), keypair, origin, fetchImpl });
  }
  const meta = {};
  if (bio !== undefined) meta.bio = bio;
  if (name || state.name) meta.name = name || state.name;
  if (media) meta.image = media.media_url;
  if (state.previous) meta.previous = state.previous;
  const post = await protocol.compose(keypair, "", meta);
  const result = { author: post.author, id: post.id, signature: post.signature, url: `https://wiredove.net/#${post.signature}`, content: post.content, media };
  if (dryRun) return { ...result, dryRun: true };
  const relay = createWiredoveRelay({ baseURL: relayURL, fetchImpl });
  await relay.publish({ content: post.content, signature: post.signature, id: post.id });
  await saveState(dir, { ...state, pubkey: post.author, ...(meta.name ? { name: meta.name } : {}), previous: post.id });
  return result;
}

export { an };
