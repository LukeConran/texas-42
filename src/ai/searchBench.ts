import { createMatch } from "../engine/game";
import { benchSettings, playHand } from "./ladder";
import { heuristicPolicy } from "./policy";
import { searchPolicy } from "./search";

/**
 * Play seeded deals twice, swapping the teams, and print the marks.
 * Usage: npm run search -- <deals> <samples>
 */
const deals = positive(process.argv[2], 8);
const samples = positive(process.argv[3], 16);
const seeds = Array.from({ length: deals }, (_, index) => index + 1);
const heuristic = heuristicPolicy({ margin: 0 }, "heuristic");

console.log(
  `Searching ${deals} deals, ${samples} hidden hands at each decision. Each deal is played twice, with the teams swapped.`,
);

let searchMarks = 0;
let heuristicMarks = 0;
const started = Date.now();
for (const seed of seeds) {
  const dealStarted = Date.now();
  const search = searchPolicy({ samples, seed: seed * 10007, name: "search" });
  const first = playHand(createMatch(benchSettings(seed, "marks")), [search, heuristic, search, heuristic]).lastResult;
  const second = playHand(createMatch(benchSettings(seed, "marks")), [heuristic, search, heuristic, search]).lastResult;
  if (!first || !second) throw new Error(`Deal ${seed} did not finish`);
  const searchAward = first.awarded[0] + second.awarded[1];
  const heuristicAward = first.awarded[1] + second.awarded[0];
  searchMarks += searchAward;
  heuristicMarks += heuristicAward;
  const seconds = ((Date.now() - dealStarted) / 1000).toFixed(1);
  console.log(`deal ${seed}: search ${searchAward}, heuristic ${heuristicAward} (${seconds}s)`);
}

const totalSeconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `After ${deals} deals (${deals * 2} hands, ${totalSeconds}s): search ${searchMarks}, heuristic ${heuristicMarks}.`,
);
console.log("Raise the second number for a steadier search. It costs about that many times longer.");

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
