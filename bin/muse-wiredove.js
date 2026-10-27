#!/usr/bin/env node
// muse-wiredove — publish Wiredove / ANProto posts from the command line.
// Usage:
//   muse-wiredove identity --name "Muse"
//   muse-wiredove post --text "hello" [--image ./photo.jpg] [--dry-run] [--no-ntfy]
//   muse-wiredove profile --name "Muse" [--bio "..."] [--image ./photo.jpg] [--dry-run]
// Env: MUSE_WIREDOVE_DIR, MUSE_WIREDOVE_IDENTITY. The identity file is a
// secret: it is written 0600 and must never be committed or pasted anywhere.
import { createIdentity, loadState, defaultDir, identityPath } from "../src/identity.js";
import { publishPost, publishProfile, resumePending } from "../src/publish.js";
import { an } from "../src/an.js";

const args = process.argv.slice(2);
const cmd = args[0];
const flags = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
}
const dir = flags.dir || defaultDir();

function usage() {
  console.log(`muse-wiredove — Wiredove / ANProto publisher (Node, no browser)

Commands:
  identity [--name NAME]        Create a new identity (writes a secret keypair file)
  post --text TEXT [--image FILE] [--reply ID] [--replyto PUBKEY] [--previous ID] [--dry-run] [--no-ntfy]
  profile [--name NAME] [--bio TEXT] [--image FILE] [--dry-run]
  resume [--image FILE]       Resume a pending post/profile with its original signature and id

The identity file defaults to ${identityPath()}.
Posts are public and signed; they cannot be silently un-published.`);
}

try {
  if (cmd === "identity") {
    const { pubkey, identityFile } = await createIdentity(dir, flags.name);
    console.log(JSON.stringify({ pubkey, identityFile, note: "Identity file is secret. Keep it 0600, never commit it." }, null, 2));
  } else if (cmd === "post") {
    const result = await publishPost({
      text: flags.text || "", imagePath: flags.image, name: flags.name,
      reply: flags.reply, replyto: flags.replyto, previous: flags.previous,
      dir, dryRun: Boolean(flags["dry-run"]), sendNtfy: !flags["no-ntfy"],
      ...(flags["ntfy-timeout-ms"] ? { ntfyTimeoutMs: Number(flags["ntfy-timeout-ms"]) } : {}),
      ...(flags["upload-timeout-ms"] ? { uploadTimeoutMs: Number(flags["upload-timeout-ms"]) } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "profile") {
    const state = await loadState(dir);
    const result = await publishProfile({
      name: flags.name, bio: flags.bio, imagePath: flags.image, dir, dryRun: Boolean(flags["dry-run"]),
    });
    console.log(JSON.stringify({ ...result, previousName: state.name || null }, null, 2));
  } else if (cmd === "resume") {
    const result = await resumePending({ dir, imagePath: flags.image });
    console.log(JSON.stringify(result ?? { recovered: false, note: "No pending publish to resume." }, null, 2));
  } else if (cmd === "pubkey") {
    const { loadIdentity } = await import("../src/identity.js");
    console.log(an.pubkeyOf(await loadIdentity(dir)));
  } else {
    usage();
    if (cmd) process.exitCode = 2;
  }
} catch (err) {
  console.error(`muse-wiredove: ${err.message}`);
  process.exitCode = 1;
}
