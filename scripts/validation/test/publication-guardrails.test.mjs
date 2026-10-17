import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// The two publication-guardrails scans are governance's scan steps, taken byte for byte.
// Governance's fixture checker finds each scan by its step name, and the secret scan job runs
// that checker against its own fixtures before it scans. Each scan installs a pinned ripgrep
// itself and checks for rg before it first runs rg, so a missing rg fails the step instead of
// letting it pass with nothing scanned.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const guardrails = YAML.parse(fs.readFileSync(path.join(workflowsDir, "publication-guardrails.yml"), "utf8"));
const SCAN_JOBS = ["local-path-leak-check", "secret-pattern-scan"];
const RG_CHECK = /^command -v rg >\/dev\/null \|\| \{ .*; exit 1; \}$/;

// Lines of a run body that call rg, leaving out comments and the presence check itself.
const callsRg = (line) => !line.startsWith("#") && !RG_CHECK.test(line) && /(^|[\s|;&(!`])rg(\s|$)/.test(line);

function rgSteps() {
  return fs
    .readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((file) => {
      const doc = YAML.parse(fs.readFileSync(path.join(workflowsDir, file), "utf8"));
      return Object.entries(doc.jobs ?? {}).flatMap(([id, job]) =>
        (job.steps ?? [])
          .map((step) => ({ where: `${file}#${id}/${step.name}`, lines: (step.run ?? "").split("\n").map((l) => l.trim()) }))
          .filter(({ lines }) => lines.some(callsRg)),
      );
    });
}

test("the workflow token is read-only by default", () => {
  assert.deepEqual(guardrails.permissions, { contents: "read" });
});

const SCAN_STEPS = {
  "local-path-leak-check": ["Detect local path or identity leakage"],
  "secret-pattern-scan": ["Check the scan against its fixtures", "Scan secret-like patterns"],
};

test("each scan job is the checkout and then governance's named steps", () => {
  for (const id of SCAN_JOBS) {
    const steps = guardrails.jobs[id].steps;
    assert.match(steps[0].uses ?? "", /^actions\/checkout@/, id);
    assert.deepEqual(steps.slice(1).map((s) => s.name), SCAN_STEPS[id], id);
    for (const step of steps.slice(1)) assert.equal(typeof step.run, "string", `${id}/${step.name}`);
  }
  const fixtures = guardrails.jobs["secret-pattern-scan"].steps[1].run.trim();
  assert.equal(fixtures, "bash scripts/ci/check-guardrail-fixtures.sh .github/workflows/publication-guardrails.yml");
});

test("every step that runs rg checks for it first", () => {
  const steps = rgSteps();
  assert.deepEqual(
    SCAN_JOBS.filter((id) => !steps.some(({ where }) => where.startsWith(`publication-guardrails.yml#${id}/`))),
    [],
    "both scan jobs run rg",
  );
  const unchecked = steps
    .filter(({ lines }) => {
      const check = lines.findIndex((l) => RG_CHECK.test(l));
      return check < 0 || check > lines.findIndex(callsRg);
    })
    .map(({ where }) => where);
  assert.deepEqual(unchecked, []);
});
