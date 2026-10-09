import { readFileSync, writeFileSync } from "node:fs";
import { appendRun, captureBands, captureSamples, weightL1, writeSamples } from "./history";
import { modelFromJson, modelToJson } from "./imitate";
import { reinforce } from "./reinforce";

/**
 * Search for weight changes that win more marks against the heuristic.
 * Usage: npm run rl -- <hands> <shake>
 * The shake scales each try. 1 is the normal size. 0.05 is a very small shake.
 * Replaces src/ai/imitate.json when the best version beats the starting weights
 * on two fresh sets of deals.
 */
const hands = positive(process.argv[2], 30000);
const step = positiveFloat(process.argv[3], 1);
const outPath = "src/ai/imitate.json";

let text: string;
try {
  text = readFileSync(outPath, "utf8");
} catch {
  console.error(`No weights at ${outPath}. Run npm run imitate first.`);
  process.exit(1);
}

const start = modelFromJson(text);
console.log(`Searching ${hands} hands for weight changes that win more marks. Shake scale ${step}.`);
const started = Date.now();
let printed = -1;
const result = reinforce(start, {
  hands,
  lr: step,
  onProgress(progress) {
    const bucket = Math.floor((progress.used / progress.hands) * 10);
    if (!progress.checked && bucket === printed) return;
    if (!progress.checked) printed = bucket;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const deals = progress.best.hands / 2;
    console.log(
      `  ${Math.min(progress.used, progress.hands)}/${progress.hands} hands (${seconds}s). ` +
        `${deals} fresh deals: best ${progress.best.awardA}-${progress.best.awardB}, ` +
        `start ${progress.start.awardA}-${progress.start.awardB}.`,
    );
  },
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const deals = result.versusStart.hands / 2;
console.log(
  `Validation, ${deals} deals: start ${result.versusStart.awardA}-${result.versusStart.awardB}, best ${result.versusHeuristic.awardA}-${result.versusHeuristic.awardB}.`,
);
console.log(
  `Confirmation, ${deals} other deals: start ${result.confirmationStart.awardA}-${result.confirmationStart.awardB}, best ${result.confirmation.awardA}-${result.confirmation.awardB}.`,
);
if (result.accepted) {
  writeFileSync(outPath, modelToJson(result.model));
  console.log(`The best weights won more marks on both sets, so ${outPath} was replaced (${seconds}s).`);
} else {
  console.log(`The best weights did not win more marks on both sets, so ${outPath} was left as it was (${seconds}s).`);
}

const at = new Date().toISOString();
const { bands, bandsStart } = captureBands(result.model, start);
appendRun({
  at,
  kind: "rl",
  hands,
  lr: step,
  seed: 40000,
  seconds: Number(seconds),
  accepted: result.accepted,
  versusHeuristic: result.versusHeuristic,
  versusStart: result.versusStart,
  confirmation: result.confirmation,
  confirmationStart: result.confirmationStart,
  bands,
  bandsStart,
  weightL1: weightL1(result.model, start),
  weights: result.model,
});
writeSamples(at, captureSamples(result.model));
console.log("Appended this run to stats/data/runs.jsonl. Open it with npm run stats.");

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
