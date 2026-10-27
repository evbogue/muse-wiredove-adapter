// Identity and chaining state. The identity file holds ONE line: the
// ANProto keypair. That file is a secret: chmod 600, never commit it,
// never paste it into chat, issues, or logs. State (pubkey, display name,
// last post id) lives in a separate JSON file so posts can chain via
// `previous`, like wiredove's author history.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { an } from "./an.js";

export const defaultDir = () => process.env.MUSE_WIREDOVE_DIR || path.join(homedir(), ".config", "muse-wiredove");
export const identityPath = (dir = defaultDir()) => process.env.MUSE_WIREDOVE_IDENTITY || path.join(dir, "identity.txt");
export const statePath = (dir = defaultDir()) => path.join(dir, "state.json");

export async function loadState(dir) {
  try { return JSON.parse(await readFile(statePath(dir), "utf8")); } catch { return {}; }
}
export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(dir), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function loadIdentity(dir) {
  const keypair = (await readFile(identityPath(dir), "utf8")).trim();
  if (!keypair || keypair.length < 100) throw new Error(`No identity found at ${identityPath(dir)} — run: muse-wiredove identity --name "Your Name"`);
  return keypair;
}

export async function createIdentity(dir, name) {
  const keypair = await an.generate();
  await mkdir(dir, { recursive: true });
  await writeFile(identityPath(dir), keypair + "\n", { mode: 0o600 });
  try { await chmod(identityPath(dir), 0o600); } catch {}
  const state = { pubkey: an.pubkeyOf(keypair), ...(name ? { name } : {}) };
  await saveState(dir, state);
  return { keypair, ...state, identityFile: identityPath(dir) };
}
