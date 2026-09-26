import { readFileSync, writeFileSync } from "node:fs";
import { modelFromJson, modelToJson } from "./imitate";
import { reinforce } from "./reinforce";

/**
 * Nudge the saved weights from the marks at the end of each hand.
 * Usage: npm run rl -- <hands> <step>
 * Replaces src/ai/imitate.json only when the new weights win both held-out duels.
 */
const hands = positive(process.argv[2], 80);
const lr = positiveFloat(process.argv[3], 0.02);
const outPath = "src/ai/imitate.json";

let text: string;
try {
  text = readFileSync(outPath, "utf8");
} catch {
  console.error(`No weights at ${outPath}. Run npm run imitate first.`);
  process.exit(1);
}

const start = modelFromJson(text);
console.log(`Training ${hands} hands from the saved weights, step size ${lr}.`);
const started = Date.now();
const result = reinforce(start, {
  hands,
  lr,
  onHand(done, total) {
    if (done === total || done % 10 === 0) {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ${done}/${total} hands (${seconds}s)`);
    }
  },
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const deals = result.versusHeuristic.hands / 2;
console.log(
  `Held-out ${deals} deals vs heuristic: learned ${result.versusHeuristic.awardA}, heuristic ${result.versusHeuristic.awardB}.`,
);
console.log(
  `Held-out ${deals} deals vs previous weights: learned ${result.versusPrevious.awardA}, previous ${result.versusPrevious.awardB}.`,
);
if (result.accepted) {
  writeFileSync(outPath, modelToJson(result.model));
  console.log(`The learned weights beat both, so ${outPath} was replaced (${seconds}s).`);
} else {
  console.log(`The learned weights did not beat both, so ${outPath} was left as it was (${seconds}s).`);
}

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
