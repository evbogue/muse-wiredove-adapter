// Wiredove gossip relay over HTTP, following wiredove's client/relay.js:
// content first, signature second, then confirm the signature is returned
// when gossiping the post id.
export function createWiredoveRelay({ baseURL = "https://pub.wiredove.net", fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!baseURL) throw new Error("A Wiredove relay URL is required");
  const gossip = async (value) => {
    const response = await fetchImpl(new URL("/gossip", baseURL), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: value,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Wiredove relay returned ${response.status}`);
    const result = await response.json();
    return Array.isArray(result.messages) ? result.messages.filter((x) => typeof x === "string") : [];
  };
  return {
    gossip,
    async publish({ content, signature, id }) {
      await gossip(content);
      await gossip(signature);
      if (!(await gossip(id)).includes(signature)) {
        throw new Error("Wiredove has not confirmed the signature");
      }
    },
    async poll(since = 0) {
      const response = await fetchImpl(new URL(`/gossip/poll?since=${encodeURIComponent(since)}`, baseURL), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Wiredove relay returned ${response.status}`);
      return response.json();
    },
  };
}
