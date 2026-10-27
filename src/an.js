// ANProto identity primitives, using Node's built-in WebCrypto Ed25519.
// Keypair format matches wiredove/anproto: base64(pubkey 32B) + base64(secret 64B).
// The secret is seed (32B) + pubkey (32B); only the seed is used as the
// private key material. Never log, commit, or share a keypair.
const b64encode = (bytes) => Buffer.from(bytes).toString("base64");
const b64decode = (text) => new Uint8Array(Buffer.from(text, "base64"));

export const pubkeyOf = (keypair) => keypair.slice(0, 44);

async function importPrivate(keypair) {
  const secret = b64decode(keypair.slice(44));
  if (secret.length !== 64) throw new Error("Invalid keypair: expected a 64-byte secret");
  const seed = secret.slice(0, 32);
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d: b64encode(seed).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""), x: b64encode(secret.slice(32)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function importPublic(pubkey) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: b64encode(b64decode(pubkey)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

export async function generateKeypair() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const seed = b64decode(priv.d);
  const secret = new Uint8Array([...seed, ...pub]);
  return b64encode(pub) + b64encode(secret);
}

export async function hash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64encode(new Uint8Array(digest));
}

// an.sign: sign(ts + hash) with Ed25519, return pubkey + base64(sig + payload).
export async function sign(contentHash, keypair) {
  const ts = Date.now();
  const payload = new TextEncoder().encode(String(ts) + contentHash);
  const key = await importPrivate(keypair);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, payload));
  const combined = new Uint8Array([...sig, ...payload]);
  return pubkeyOf(keypair) + b64encode(combined);
}

// an.open: verify and return ts + contentHash.
export async function open(signature) {
  if (typeof signature !== "string" || signature.length !== 208) {
    throw new Error("Invalid ANProto signature");
  }
  const pubkey = signature.slice(0, 44);
  const rest = b64decode(signature.slice(44));
  const sig = rest.slice(0, 64);
  const payload = rest.slice(64);
  const key = await importPublic(pubkey);
  const ok = await crypto.subtle.verify("Ed25519", key, sig, payload);
  if (!ok) throw new Error("Invalid ANProto signature");
  return new TextDecoder().decode(payload);
}

export const an = { generate: generateKeypair, hash, sign, open, pubkeyOf };
