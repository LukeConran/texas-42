import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(mkdtempSync(join(tmpdir(), "texas42-search-")), "bench.mjs");
await build({
  entryPoints: ["src/ai/searchBench.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  target: "node20",
  legalComments: "none",
});
await import(pathToFileURL(outfile).href);
