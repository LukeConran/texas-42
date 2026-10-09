import { readFileSync } from "node:fs";
import { appendRun, captureBands, captureSamples, writeSamples } from "./history";
import { modelFromJson, imitationPolicy } from "./imitate";
import { duel } from "./ladder";
import { heuristicPolicy } from "./policy";

/**
 * Score the weights on disk and append that look to the training log.
 * Usage: npm run score
 */
const outPath = "src/ai/imitate.json";
let text: string;
try {
  text = readFileSync(outPath, "utf8");
} catch {
  console.error(`No weights at ${outPath}. Run npm run imitate first.`);
  process.exit(1);
}

const model = modelFromJson(text);
const seeds = Array.from({ length: 64 }, (_, index) => 12000 + index);
const started = Date.now();
const versusHeuristic = duel(seeds, imitationPolicy(model), heuristicPolicy({ margin: 0 }, "heuristic"));
const seconds = (Date.now() - started) / 1000;
const at = new Date().toISOString();
const { bands } = captureBands(model, null);
appendRun({
  at,
  kind: "score",
  hands: versusHeuristic.hands,
  lr: 0,
  seed: 12000,
  seconds,
  accepted: true,
  versusHeuristic,
  bands,
  weightL1: { bid: 0, trump: 0, play: 0 },
  weights: model,
});
writeSamples(at, captureSamples(model));
console.log(
  `Current weights on 64 deals: ${versusHeuristic.awardA}-${versusHeuristic.awardB} (${seconds.toFixed(1)}s).`,
);
console.log("Appended this look to stats/data/runs.jsonl. Open it with npm run stats.");
