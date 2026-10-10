#!/usr/bin/env node
// Validates topics/catalog.yaml and renders the generated files.
//
//   node scripts/catalog/generate.mjs            validate and write generated files
//   node scripts/catalog/generate.mjs --check    validate and fail if generated files drift
//   --manifest <file>   bootstrap manifest to validate against
//                       (default topics/registry/repository-bootstrap-manifest.csv)
//   --asyncapi <dir>    also compare with asyncapi/<service-id>.yaml files in <dir>
//                       (a checkout of the AsyncAPI catalog; local use)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { crossCheckAsyncApi, generateAll, loadCatalog, loadManifest, validateCatalog } from "./catalog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const opts = { check: false, manifest: null, asyncapi: null, root: repoRoot };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      opts.check = true;
    } else if (arg === "--manifest" || arg === "--asyncapi" || arg === "--root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} needs a value`);
      }
      opts[arg.slice(2)] = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return opts;
}

export function run(argv, log = console) {
  const opts = parseArgs(argv);
  const catalogPath = path.join(opts.root, "topics/catalog.yaml");
  const catalog = loadCatalog(catalogPath);
  const manifestPath = opts.manifest ?? path.join(opts.root, catalog.metadata?.manifest ?? "topics/registry/repository-bootstrap-manifest.csv");
  const manifest = loadManifest(manifestPath);

  const errors = validateCatalog(catalog, manifest);
  if (opts.asyncapi) {
    errors.push(...crossCheckAsyncApi(catalog, opts.asyncapi));
  }
  if (errors.length > 0) {
    for (const e of errors) {
      log.error(`catalog: ${e}`);
    }
    log.error(`catalog: ${errors.length} error(s)`);
    return 1;
  }

  const files = generateAll(opts.root, catalog);
  const drift = [];
  for (const [rel, content] of files) {
    const target = path.join(opts.root, rel);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current === content) {
      continue;
    }
    if (opts.check) {
      drift.push(rel);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      log.log(`catalog: wrote ${rel}`);
    }
  }
  if (drift.length > 0) {
    for (const rel of drift) {
      log.error(`catalog: ${rel} is out of date`);
    }
    log.error("catalog: run `npm run catalog:generate` and commit the result");
    return 1;
  }
  const count = catalog.namespaces.reduce((n, ns) => n + ns.topics.length, 0);
  const types = catalog.namespaces.reduce((n, ns) => n + ns.topics.reduce((m, t) => m + t.eventTypes.length, 0), 0);
  log.log(
    `catalog: valid (${catalog.namespaces.length} namespaces, ${count} aggregate topics, ${types} event types)` +
      `${opts.check ? ", generated files up to date" : ""}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (e) {
    console.error(`catalog: ${e.message}`);
    process.exit(2);
  }
}
