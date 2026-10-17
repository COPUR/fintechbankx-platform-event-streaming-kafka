// Pinned section references in this repository's Markdown.
//
// A guide here points at a section of a document in another repository by its title
// (`the chart README section "Datasource and TLS guard" in <repo>`). That repository moves
// on its own branches, so the pointer names the commit it was checked against, in the same
// paragraph, as commit `<sha>` (7 to 40 lower-case hex digits in a code span). The rule is
// fail-closed: every `section "<title>"` or `sections "<title>"` (straight or curly quotes,
// any case) outside fenced code needs that pin in its paragraph, whichever repository the
// section is in. A section of a file in this repository is linked instead
// ([text](path#anchor)), which the README link check resolves.
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "build", ".gradle"]);
const SECTION = /\bsections?\s+["“]([^"“”]+)["”]/gi;
const COMMIT_PIN = /\bcommit\s+`[0-9a-f]{7,40}`/i;
const FENCE = /^\s{0,3}(```|~~~)/;

export function markdownFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(p);
    }
  };
  walk(root);
  return files.sort();
}

// Paragraphs (runs of non-blank lines outside fenced code), with their first line number.
function paragraphs(markdown) {
  const out = [];
  let current = null;
  let fence = null;
  markdown.split(/\r\n|\r|\n/).forEach((line, i) => {
    const marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1] === fence) fence = null;
      return;
    }
    if (marker) {
      fence = marker[1];
      current = null;
      return;
    }
    if (line.trim() === "") {
      current = null;
      return;
    }
    if (!current) {
      current = { line: i + 1, lines: [] };
      out.push(current);
    }
    current.lines.push(line);
  });
  return out.map((p) => ({ line: p.line, text: p.lines.join("\n") }));
}

// One entry per paragraph that names a section without a commit pin: the line of its
// first section reference and the titles it names.
export function unpinnedSectionReferences(markdown) {
  const found = [];
  for (const para of paragraphs(markdown)) {
    const refs = [...para.text.matchAll(SECTION)];
    if (refs.length === 0 || COMMIT_PIN.test(para.text)) continue;
    const before = para.text.slice(0, refs[0].index);
    found.push({
      line: para.line + (before.match(/\n/g) || []).length,
      sections: refs.map((m) => m[1].replace(/\s+/g, " ").trim()),
    });
  }
  return found;
}
