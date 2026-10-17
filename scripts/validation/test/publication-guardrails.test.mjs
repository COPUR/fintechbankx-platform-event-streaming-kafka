import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// The guardrail scans run `if rg ...; then fail; fi`. When rg is not installed the
// condition exits 127, the `if` takes the false branch and the step passes without
// scanning anything. Hosted runner images do not ship rg, so every job that calls rg
// must first run the "Install ripgrep" step, which fails the job when rg stays absent.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const PROVISION = "Install ripgrep";
const BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => fs.existsSync(p));

const callsRg = (run) => /(^|[\s|;&(!`])rg(\s|$)/m.test(run ?? "");

function workflowJobs() {
  return fs
    .readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((file) => {
      const doc = YAML.parse(fs.readFileSync(path.join(workflowsDir, file), "utf8"));
      return Object.entries(doc.jobs ?? {}).map(([id, job]) => ({ where: `${file}#${id}`, steps: job.steps ?? [] }));
    });
}

function provisionBodies() {
  return workflowJobs().flatMap(({ steps }) => steps.filter((s) => s.name === PROVISION).map((s) => s.run));
}

test("every job that calls rg installs it before its first rg step", () => {
  const scanning = workflowJobs().filter(({ steps }) => steps.some((s) => s.name !== PROVISION && callsRg(s.run)));
  assert.ok(
    scanning.some(({ steps }) => steps.some((s) => s.name === "Scan secret-like patterns")),
    "the secret scan job is among the jobs that call rg",
  );
  const unprovisioned = scanning
    .filter(({ steps }) => {
      const firstRg = steps.findIndex((s) => s.name !== PROVISION && callsRg(s.run));
      const provision = steps.findIndex((s) => s.name === PROVISION);
      return provision < 0 || provision > firstRg;
    })
    .map(({ where }) => where);
  assert.deepEqual(unprovisioned, []);
});

test("every Install ripgrep step has the same body", () => {
  const bodies = provisionBodies();
  assert.ok(bodies.length > 0);
  assert.equal(new Set(bodies).size, 1);
});

function runProvision({ rgPresent, sudoExit }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provision-rg-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const log = path.join(dir, "sudo.log");
    fs.writeFileSync(path.join(bin, "sudo"), `#!${BASH}\necho "$*" >> '${log}'\nexit ${sudoExit}\n`, { mode: 0o755 });
    if (rgPresent) {
      fs.writeFileSync(path.join(bin, "rg"), `#!${BASH}\necho 'ripgrep 14.1.0'\n`, { mode: 0o755 });
    }
    const script = path.join(dir, "step.sh");
    fs.writeFileSync(script, provisionBodies()[0]);
    const r = spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: dir,
      env: { PATH: bin },
      encoding: "utf8",
    });
    const sudoCalls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: r.status, stdout: r.stdout, sudoCalls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Install ripgrep keeps an rg that is already on PATH", () => {
  const r = runProvision({ rgPresent: true, sudoExit: 1 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ripgrep 14\.1\.0/);
  assert.deepEqual(r.sudoCalls, []);
});

test("Install ripgrep fails the job when the package install fails", () => {
  const r = runProvision({ rgPresent: false, sudoExit: 1 });
  assert.notEqual(r.status, 0);
  assert.ok(r.sudoCalls.length > 0);
});

test("Install ripgrep fails the job when rg is still missing after the install", () => {
  const r = runProvision({ rgPresent: false, sudoExit: 0 });
  assert.notEqual(r.status, 0);
  assert.ok(r.sudoCalls.some((c) => /apt-get install .*\bripgrep\b/.test(c)), r.sudoCalls.join("; "));
});
