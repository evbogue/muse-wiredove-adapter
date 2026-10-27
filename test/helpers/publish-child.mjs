// Helper run by state.test.js as a separate process: publishes one
// post with a mocked relay (no real network) and prints its id and
// content. Usage: node publish-child.mjs <dir> <text>
import { publishPost } from "../../src/publish.js";

const [, , dir, text] = process.argv;
let lastSignature = null;
const result = await publishPost({
  text,
  dir,
  sendNtfy: false,
  fetchImpl: async (url, opts) => {
    const body = String(opts?.body ?? "");
    if (body.length === 208) lastSignature = body;
    const isId = body.length === 44 && !body.includes("---");
    return {
      ok: true,
      json: async () => ({ messages: isId && lastSignature ? [lastSignature] : [] }),
    };
  },
});
console.log(JSON.stringify({ id: result.id, content: result.content }));
