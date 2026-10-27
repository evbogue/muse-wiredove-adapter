// Transport- and UI-free ANProto helpers, following wiredove's
// client/protocol.js contract, with this adapter's an/yaml adapters.
import { an } from "./an.js";
import { yaml } from "./yaml.js";

export const isMessageHash = (v) => typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v);

export function createProtocol({ now = () => Date.now() } = {}) {
  async function open(signature) {
    if (typeof signature !== "string" || signature.length !== 208 || !isMessageHash(signature.slice(0, 44))) {
      throw new Error("Invalid ANProto signature");
    }
    let opened;
    try { opened = await an.open(signature); } catch { throw new Error("Invalid ANProto signature"); }
    if (!/^\d{13}[A-Za-z0-9+/]{43}=$/.test(opened)) throw new Error("Invalid signed timestamp and hash");
    return { author: signature.slice(0, 44), timestamp: Number(opened.slice(0, 13)), contentHash: opened.slice(13) };
  }

  async function verify(signature, content, { maxBytes = 65536 } = {}) {
    if (typeof content !== "string" || new TextEncoder().encode(content).length > maxBytes) {
      throw new Error("Post exceeds size limit");
    }
    const proof = await open(signature);
    if ((await an.hash(content)) !== proof.contentHash) throw new Error("Content hash does not match signature");
    if (proof.timestamp > now() + 300000) throw new Error("Post timestamp is in the future");
    return { id: await an.hash(signature), signature, content, ...proof, parsed: yaml.parse(content) };
  }

  async function compose(keypair, body, metadata = {}) {
    const content = yaml.create(metadata, body);
    if (!content) throw new Error("Could not encode post");
    return verify(await an.sign(await an.hash(content), keypair), content);
  }

  async function signPayload(payload, keypair) {
    return an.sign(await an.hash(payload), keypair);
  }

  return { open, verify, compose, signPayload };
}

export const protocol = createProtocol();
