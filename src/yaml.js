// Minimal frontmatter YAML for Wiredove posts.
// Format matches apds lib/yaml.js (evbogue/apds@e091911, verified
// 2026-10-27): create is `---\n\n${dump(obj)}\n---\n\n${body}`,
// where dump is js-yaml. For an empty object js-yaml dumps "{}\n",
// not an empty string — that is the fix for work order 6: the old
// adapter emitted "---\n\n---\n\n<body>", which no frontmatter parser
// (including its own) could split, so the whole document became the
// body. Only flat scalar metadata is supported in v0.1 (strings and
// numbers), which covers name, previous, reply, replyto, and AndFS
// media fields. Values are always double-quoted (JSON escaping),
// which YAML parses back to the same string.
export function yamlStringify(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number") lines.push(`${key}: ${value}`);
    else if (typeof value === "string") lines.push(`${key}: ${JSON.stringify(value)}`);
    else throw new Error(`Unsupported YAML value for ${key}: only strings and numbers in v0.1`);
  }
  return lines.length ? lines.join("\n") + "\n" : "{}\n";
}

export function yamlCreate(obj, body) {
  return `---\n\n${yamlStringify(obj)}---\n\n${body}`;
}

export function yamlParse(text) {
  const match = /^---\n\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text);
  if (!match) {
    // Legacy fallback: documents written by the old empty-metadata
    // bug ("---\n\n---\n\n<body>") still split cleanly here.
    for (const prefix of ["---\n\n---\n\n", "---\n\n\n---\n\n"]) {
      if (text.startsWith(prefix)) return { body: text.slice(prefix.length) };
    }
    return { body: text };
  }
  const attrs = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (raw.startsWith('"')) {
      try { attrs[key] = JSON.parse(raw); continue; } catch {}
    }
    const num = Number(raw);
    attrs[key] = Number.isFinite(num) && raw !== "" ? num : raw;
  }
  return { ...attrs, body: match[2] };
}

export const yaml = { create: yamlCreate, parse: yamlParse };
