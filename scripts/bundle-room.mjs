import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

// One file, no relative imports. Vercel compiles a TypeScript route into
// Node ESM and then cannot resolve an extensionless import, which crashes
// the function before it can return JSON.
await build({
  entryPoints: ["src/server/roomFunction.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "api/signal.mjs",
  target: "node20",
  legalComments: "none",
});

const bundled = await readFile("api/signal.mjs", "utf8");
const wrapped = `${bundled}
export default {
  async fetch(request) {
    return roomFetch(request);
  },
};
`;
await writeFile("api/signal.mjs", wrapped);

const mod = await import(new URL("../api/signal.mjs", import.meta.url).href);
const response = await mod.default.fetch(
  new Request("https://texas42.local/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "create" }),
  }),
);
const payload = await response.json();
if (response.status !== 200 || typeof payload.code !== "string") {
  throw new Error(`Bundled room function failed: ${response.status} ${JSON.stringify(payload)}`);
}
