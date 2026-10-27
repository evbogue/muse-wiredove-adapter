// Minimal frontmatter YAML for Wiredove posts.
// Format matches apds lib/yaml.js: "---\n\n<yaml>\n---\n\n<body>"
// Only flat scalar metadata is supported in v0.1 (strings and numbers),
// which covers name, previous, reply, replyto, and AndFS media fields.
// Values are always double-quoted (JSON escaping), which YAML parses back
// to the same string.
export function yamlStringify(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number") lines.push(`${key}: ${value}`);
    else if (typeof value === "string") lines.push(`${key}: ${JSON.stringify(value)}`);
    else throw new Error(`Unsupported YAML value for ${key}: only strings and numbers in v0.1`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

export function yamlCreate(obj, body) {
  return `---\n\n${yamlStringify(obj)}---\n\n${body}`;
}

export function yamlParse(text) {
  const match = /^---\n\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text);
  if (!match) return { body: text };
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
