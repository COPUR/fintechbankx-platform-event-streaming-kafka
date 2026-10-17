import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownFiles, unpinnedSectionReferences } from "../doc-section-references.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("a section named by its title without a commit in the same paragraph is reported", () => {
  const md = [
    "Intro paragraph.",
    "",
    'See the chart README section "Datasource and TLS guard" in `other-repo`; this guide does',
    "not repeat it.",
    "",
  ].join("\n");
  const found = unpinnedSectionReferences(md);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.deepEqual(found[0].sections, ["Datasource and TLS guard"]);
});

test("a commit named in the same paragraph pins every section of that paragraph", () => {
  const md = [
    'See the chart README section "Datasource and TLS guard" (`other-repo` at commit `cc26a97`',
    'or later; same README, section "Vendoring the guard").',
  ].join("\n");
  assert.deepEqual(unpinnedSectionReferences(md), []);
});

test("a commit in another paragraph does not pin the reference", () => {
  const md = [
    "Service charts vendor the guard of commit `6b6c317`.",
    "",
    'Its names are in the README section "Datasource and TLS guard".',
  ].join("\n");
  const found = unpinnedSectionReferences(md);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test("the rule fails closed on spellings it does not model as pinned", () => {
  for (const md of [
    'Read the sections "A" and "B" of the other README.',
    "Read the section “A” of the other README.",
    'Read section "A" at commit 6b6c317 (no code span around the hash).',
    'Read section "A" at commit `6b6c` (too short to name a commit).',
    'Read Section "A" of the other README.',
  ]) {
    assert.equal(unpinnedSectionReferences(md).length, 1, md);
  }
});

test("fenced code blocks are not read", () => {
  const md = ["```text", 'section "A"', "", 'section "B"', "```", "", "Plain text."].join("\n");
  assert.deepEqual(unpinnedSectionReferences(md), []);
});

test("every Markdown file of this repository pins the sections it names", () => {
  const files = markdownFiles(repoRoot);
  assert.ok(files.some((f) => f.endsWith(path.join("docs", "guides", "SERVICE_CLIENT_CONFIGURATION.md"))));
  const unpinned = files.flatMap((file) =>
    unpinnedSectionReferences(fs.readFileSync(file, "utf8")).map(
      (r) => `${path.relative(repoRoot, file)}:${r.line} ${r.sections.map((s) => `"${s}"`).join(", ")}`,
    ),
  );
  assert.deepEqual(unpinned, []);
});
