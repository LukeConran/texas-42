import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { duel } from "./ladder";
import { heuristicPolicy } from "./policy";
import {
  collectSearchLessons,
  imitationPolicy,
  modelToJson,
  trainImitation,
  trainingAccuracy,
} from "./imitate";

/**
 * Watch the search play, fit weights to its choices, and score the copy.
 * Usage: npm run imitate -- <hands> <samples>
 * Weights are written to src/ai/imitate.json.
 */
const hands = positive(process.argv[2], 48);
const samples = positive(process.argv[3], 16);
const outPath = "src/ai/imitate.json";

console.log(`Watching the search play ${hands} hands, ${samples} hidden deals at each decision.`);
const started = Date.now();
const lesson = collectSearchLessons(hands, samples, 1, (done, total) => {
  if (done === total || done % 5 === 0) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${done}/${total} hands (${seconds}s)`);
  }
});
console.log(
  `Collected ${lesson.bids.length} bids, ${lesson.trumps.length} trump calls, ${lesson.plays.length} plays.`,
);

const model = trainImitation(lesson, { epochs: 80, lr: 0.15, seed: 1 });
const accuracy = trainingAccuracy(lesson, model);
console.log(
  `Fit accuracy on those choices: bids ${(100 * accuracy.bid).toFixed(0)}%, trump ${(100 * accuracy.trump).toFixed(0)}%, plays ${(100 * accuracy.play).toFixed(0)}%.`,
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, modelToJson(model));
console.log(`Wrote ${model.bid.w.length + model.trump.w.length + model.play.w.length} weights to ${outPath}.`);

const heldOut = Array.from({ length: 16 }, (_, index) => 5000 + index);
const result = duel(heldOut, imitationPolicy(model), heuristicPolicy({ margin: 0 }, "heuristic"));
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `Held-out 16 deals (${result.hands} hands, ${seconds}s total): imitate ${result.awardA}, heuristic ${result.awardB}.`,
);
console.log("Raise the first number to learn from more hands. Raise the second to copy a steadier search.");

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
