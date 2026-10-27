// Identity and chaining state. The identity file holds ONE line: the
// ANProto keypair. That file is a secret: chmod 600, never commit it,
// never paste it into chat, issues, or logs. State (pubkey, display name,
// last post id) lives in a separate JSON file so posts can chain via
// `previous`, like wiredove's author history.
//
// Work order 1: creation is exclusive and never overwrites. A failed
// creation preserves existing identity and state byte-for-byte, and
// there is no reset/replacement path in this module.
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { an } from "./an.js";

export const defaultDir = () => process.env.MUSE_WIREDOVE_DIR || path.join(homedir(), ".config", "muse-wiredove");
export const identityPath = (dir = defaultDir()) => process.env.MUSE_WIREDOVE_IDENTITY || path.join(dir, "identity.txt");
export const statePath = (dir = defaultDir()) => path.join(dir, "state.json");

const b64decode = (text) => new Uint8Array(Buffer.from(text, "base64"));

// Validate without ever including key material in an error message.
// Note: the public-key segment itself ends in base64 padding, so the
// whole keypair cannot be validated as one continuous base64 string;
// each segment is decoded and length-checked separately.
export function validateKeypair(keypair) {
  if (typeof keypair !== "string" || keypair.length !== 132 || !/^[A-Za-z0-9+/=]+$/.test(keypair)) {
    throw new Error("Invalid identity keypair: expected a 132-character ANProto keypair");
  }
  const pub = b64decode(keypair.slice(0, 44));
  const secret = b64decode(keypair.slice(44));
  if (pub.length !== 32 || secret.length !== 64) {
    throw new Error("Invalid identity keypair: key material has the wrong length");
  }
  if (!secret.slice(32).every((byte, i) => byte === pub[i])) {
    throw new Error("Invalid identity keypair: public key does not match private key material");
  }
  return keypair;
}

export function assertStateBelongsToIdentity(state, pubkey) {
  if (state && typeof state === "object" && typeof state.pubkey === "string" && state.pubkey !== pubkey) {
    throw new Error("State belongs to a different identity than the loaded keypair; refusing to chain onto another identity's history");
  }
}

// Only a genuinely missing file is treated as missing. Malformed JSON,
// an invalid shape, or any other read error surfaces instead of being
// silently discarded (see also work order 3).
export async function loadState(dir) {
  let raw;
  try {
    raw = await readFile(statePath(dir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Cannot read state at ${statePath(dir)}: ${err.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(`State at ${statePath(dir)} is not valid JSON; refusing to discard it`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`State at ${statePath(dir)} has an invalid shape; refusing to discard it`);
  }
  return state;
}

export async function saveState(dir, state) {
  const target = statePath(dir);
  await mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}

export async function loadIdentity(dir) {
  let raw;
  try {
    raw = await readFile(identityPath(dir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`No identity found at ${identityPath(dir)} — run: muse-wiredove identity --name "Your Name"`);
    }
    throw new Error(`Cannot read identity at ${identityPath(dir)}: ${err.message}`);
  }
  return validateKeypair(raw.trim());
}

export async function createIdentity(dir, name) {
  const dirPath = dir || defaultDir();
  const idFile = identityPath(dirPath);
  await mkdir(dirPath, { recursive: true });

  // Refuse to create into a directory that already holds another
  // identity's state. This preserves that state byte-for-byte and
  // avoids orphaning it behind a new, unrelated keypair.
  const existingState = await loadState(dirPath);
  if (existingState.pubkey) {
    throw new Error(`State at ${statePath(dirPath)} already belongs to another identity; identity creation refused to avoid replacing it`);
  }

  const keypair = await an.generate();
  // Exclusive create: the filesystem, not a check-then-write, decides
  // the winner. Concurrent creators cannot replace the winning key.
  let handle;
  try {
    handle = await open(idFile, "wx", 0o600);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`Identity already exists at ${idFile}; refusing to overwrite it. Delete it deliberately outside this tool if you really mean to replace it, and back it up first.`);
    }
    throw new Error(`Cannot create identity at ${idFile}: ${err.message}`);
  }
  try {
    await handle.writeFile(keypair + "\n", "utf8");
    try { await chmod(idFile, 0o600); } catch {}
  } finally {
    await handle.close();
  }

  const state = { pubkey: an.pubkeyOf(keypair), ...(name ? { name } : {}) };
  try {
    await saveState(dirPath, state);
  } catch (err) {
    // Creation did not complete: roll back the identity file we just
    // created so a later attempt is not blocked by a half-created pair,
    // and leave any pre-existing state untouched (it was missing here).
    await rm(idFile, { force: true }).catch(() => {});
    throw new Error(`Identity creation failed while saving state: ${err.message}`);
  }
  return { keypair, ...state, identityFile: idFile };
}
