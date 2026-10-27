# muse-wiredove-adapter

Publish Wiredove / ANProto messages and images from Node.js, without a
browser. Built for Muse (the agent), but usable by anyone with Node.

No dependencies. Requires Node >= 22 (uses built-in WebCrypto Ed25519,
`fetch`, and `Blob`).

## How it works

It follows wiredove's own publish flow, minus the browser:

1. **Identity** — an Ed25519 keypair in ANProto format:
   `base64(pubkey) + base64(secret)`. The identity file is a secret.
2. **Compose** — a post is YAML frontmatter + body, exactly like apds
   `yaml.create(metadata, body)`:
   `---\n\n<metadata>\n---\n\n<body>`. It is hashed (SHA-256) and signed
   as `pubkey + base64(sig || timestamp+hash)` (208 chars), then verified
   back before anything is sent.
3. **Media** — images/audio/video go through AndFS v1 first: 256 KiB
   chunks, SHA-256 chunk hashes, a JSON manifest, and a signed
   `andfs-upload-v1` upload to `https://wiredove.net/api/media`. The
   server must confirm the same manifest hash, mime, and size. The
   resulting `media_url` is appended to the post body, like the website
   composer does.
4. **Publish** — content, then signature, are POSTed to the Wiredove
   gossip relay (`https://pub.wiredove.net/gossip`, content first,
   signature second), and the publish is only reported as done when
   gossiping the post id returns the signature. Then, like the website
   composer, the signed post and its content are also posted to the
   public ntfy topic `https://ntfy.sh/wiredove`.
5. **Chaining** — after a successful publish, the post id is saved as
   `previous` in state, so the next post chains onto author history.

What it does *not* do (v0.1): no WebSocket/Trystero gossip (HTTP relay
only), no feed reading, no moderation, no profile-link editing, and the
YAML layer supports flat string/number metadata only. That covers name,
previous, reply/replyto, and AndFS media fields.

## Install

```bash
git clone https://github.com/evbogue/muse-wiredove-adapter.git
cd muse-wiredove-adapter
node --version   # >= 22
npm test         # dry-run tests only, no publishing
```

No `npm install` needed — there are no dependencies.

## Identity

```bash
node bin/muse-wiredove.js identity --name "Muse"
```

This writes `~/.config/muse-wiredove/identity.txt` (mode 0600) and
`~/.config/muse-wiredove/state.json`. Override with
`MUSE_WIREDOVE_DIR` / `MUSE_WIREDOVE_IDENTITY`.

**The identity file is a secret.** Anyone with it can post as you.
Never commit it, never paste it into chat, issues, or logs. The repo's
`.gitignore` excludes it, but that only helps if you keep it out of the
repo directory in the first place.

## Post text

```bash
node bin/muse-wiredove.js post --text "hello wiredove"
# --dry-run prints the signed post without sending it
node bin/muse-wiredove.js post --text "hello" --dry-run
```

## Post an image

```bash
node bin/muse-wiredove.js post --text "sunset" --image ./sunset.jpg
```

The image is AndFS-uploaded first (max 32 MiB; png/jpg/gif/webp,
mp3/mp4/webm/ogg/wav), then posted with its `media_url`.

## Profile

```bash
node bin/muse-wiredove.js profile --name "Muse" --bio "hello" --image ./avatar.jpg
```

This publishes a profile update post (metadata only, empty body),
following wiredove's `publishProfileUpdate`: name, bio, and AndFS image,
chained via `previous`.

## Replies

```bash
node bin/muse-wiredove.js post --text "replying" --reply <post-id> --replyto <author-pubkey>
```

## For agents (Muse)

```js
import { publishPost } from "./src/publish.js";
const post = await publishPost({ text: "hello", imagePath: "./photo.jpg" });
console.log(post.url); // https://wiredove.net/#<signature>
```

`publishPost` returns `{ author, id, signature, url, content, media }`.
Use `dryRun: true` to compose and verify without sending anything.
Always show the user the post text and url before publishing in a
non-dry-run call — posts are public, signed, and cannot be silently
un-published.

## Security notes

- Posts are public. Do not post private, sensitive, or unreviewed text.
- The ntfy topic is public. Treat anything sent to it as public.
- Verify a post in the feed (`post.url`) after publishing; relay
  confirmation alone is not a feed render.
- This adapter is v0.1 and was built from wiredove at master `ed19ca1`
  plus `NOTIFICATION_WORKFLOW.md`. If wiredove changes its compose,
  AndFS, or relay format, this adapter must be updated to match.
