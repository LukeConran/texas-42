import { imitationPolicy, modelFromJson, modelToJson, type ImitationModel } from "./imitate";
import { duel, type DuelResult } from "./ladder";
import { heuristicPolicy, type Policy } from "./policy";

/**
 * Rung 4. Change one weight at a time and keep the change when the same
 * deals award more marks against the heuristic. Two copies of these weights
 * pass so often that a match between them scores nothing, so that match is
 * not the test. The saved file changes when the best version beats the
 * starting weights on two separate fresh sets.
 */

export interface ReinforceOptions {
  /** Training hands. Defaults to 30000. */
  hands?: number;
  /** Scales how far each try moves a weight. 1 is the normal shake. */
  lr?: number;
  /** First training deal. Defaults to 40000, clear of the fresh sets. */
  seed?: number;
  /** Deals in each fresh set. Defaults to 64. */
  evalDeals?: number;
  onProgress?: (progress: ReinforceProgress) => void;
}

export interface ReinforceProgress {
  used: number;
  hands: number;
  start: DuelResult;
  best: DuelResult;
  /** True when this report includes a fresh-set check. */
  checked: boolean;
}

export interface ReinforceResult {
  model: ImitationModel;
  accepted: boolean;
  versusHeuristic: DuelResult;
  versusStart: DuelResult;
  confirmation: DuelResult;
  confirmationStart: DuelResult;
}

const STEP_SCALES = [0.15, 0.4, 1, 2];
const HEADS = ["bid", "trump", "play"] as const;

export function reinforce(start: ImitationModel, options: ReinforceOptions = {}): ReinforceResult {
  const hands = options.hands ?? 30000;
  const step = options.lr ?? 1;
  const pool = options.seed ?? 40000;
  const evalDeals = options.evalDeals ?? 64;
  const trainDeals = evalDeals < 16 ? Math.max(2, evalDeals) : 32;
  const gainNeeded = evalDeals < 16 ? 1 : 2;
  const validation = dealSeeds(12000, evalDeals);
  const confirmationSeeds = dealSeeds(90000, evalDeals);
  const heuristic = heuristicPolicy({ margin: 0 }, "heuristic");
  const scales = STEP_SCALES.map((scale) => scale * step);

  const versusStart = duel(validation, imitationPolicy(start), heuristic);
  let used = versusStart.hands;
  let cursor = 0;
  const theta = cloneModel(start);
  let best = cloneModel(start);
  let bestResult = versusStart;
  let bestMargin = margin(versusStart);
  report();

  while (used < hands) {
    let moved = false;
    let stop = false;
    for (const key of HEADS) {
      for (let index = 0; index < theta[key].w.length; index++) {
        const seeds = dealSeeds(pool + (cursor % 20000), trainDeals);
        const cost = seeds.length * 2 * (1 + scales.length * 2);
        if (used + cost > hands) {
          stop = true;
          break;
        }
        cursor += trainDeals;
        improveCoordinate(theta, key, index, scales, gainNeeded, seeds, heuristic);
        used += cost;
        moved = true;
        report();
      }
      if (stop) break;
    }
    if (!moved) break;
    const held = duel(validation, imitationPolicy(theta), heuristic);
    used += held.hands;
    if (margin(held) > bestMargin) {
      bestMargin = margin(held);
      best = cloneModel(theta);
      bestResult = held;
    }
    report(true);
  }

  const confirmation = duel(confirmationSeeds, imitationPolicy(best), heuristic);
  const confirmationStart = duel(confirmationSeeds, imitationPolicy(start), heuristic);
  const accepted = margin(bestResult) > margin(versusStart) && margin(confirmation) > margin(confirmationStart);
  return {
    model: best,
    accepted,
    versusHeuristic: bestResult,
    versusStart,
    confirmation,
    confirmationStart,
  };

  function report(checked = false): void {
    options.onProgress?.({ used, hands, start: versusStart, best: bestResult, checked });
  }
}

function improveCoordinate(
  model: ImitationModel,
  key: (typeof HEADS)[number],
  index: number,
  scales: number[],
  gainNeeded: number,
  seeds: number[],
  heuristic: Policy,
): void {
  const head = model[key];
  const original = head.w[index] ?? 0;
  const current = margin(duel(seeds, imitationPolicy(model), heuristic));
  let chosen = original;
  let bestDelta = 0;
  for (const scale of scales) {
    const reach = scale * Math.max(0.5, Math.abs(original));
    for (const sign of [1, -1]) {
      head.w[index] = original + sign * reach;
      const delta = margin(duel(seeds, imitationPolicy(model), heuristic)) - current;
      if (delta > bestDelta) {
        bestDelta = delta;
        chosen = head.w[index] ?? original;
      }
    }
  }
  head.w[index] = bestDelta >= gainNeeded ? chosen : original;
}

function margin(result: DuelResult): number {
  return result.awardA - result.awardB;
}

function cloneModel(model: ImitationModel): ImitationModel {
  return modelFromJson(modelToJson(model));
}

function dealSeeds(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => (start + index) >>> 0 || 1);
}
