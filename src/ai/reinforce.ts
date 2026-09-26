import { createMatch, type Action, type PlayerView } from "../engine/game";
import {
  imitationPolicy,
  modelFromJson,
  modelToJson,
  reinforceUpdate,
  sampleChoice,
  type DecisionTrace,
  type ImitationModel,
} from "./imitate";
import { benchSettings, duel, playHand, type DuelResult } from "./ladder";
import { heuristicPolicy, type Policy, type SeatPolicies } from "./policy";

/**
 * Rung 4. Start from the imitation weights and nudge them by the marks
 * the learning team won. A hand that everyone passed teaches nothing.
 * The saved file changes only when a fresh duel beats the heuristic and
 * the weights this run started from.
 */

export interface ReinforceOptions {
  /** Training hands. Defaults to 80. */
  hands?: number;
  /** Step size. Defaults to 0.02 so the fitted bid weights are not wiped out. */
  lr?: number;
  /** First training deal. Defaults to 20000, clear of the imitate and eval deals. */
  seed?: number;
  /** Held-out deals for the save gate. Defaults to 24. */
  evalDeals?: number;
  onHand?: (hand: number, hands: number) => void;
}

export interface ReinforceResult {
  model: ImitationModel;
  accepted: boolean;
  versusHeuristic: DuelResult;
  versusPrevious: DuelResult;
}

export function reinforce(start: ImitationModel, options: ReinforceOptions = {}): ReinforceResult {
  const hands = options.hands ?? 80;
  const lr = options.lr ?? 0.02;
  const seed = options.seed ?? 20000;
  const evalDeals = options.evalDeals ?? 24;
  const learner = modelFromJson(modelToJson(start));
  const frozen = modelFromJson(modelToJson(start));
  const rng = { state: seed >>> 0 || 1 };
  let baseline = 0;

  for (let i = 0; i < hands; i++) {
    const learnerTeam = i % 2;
    const opponent =
      i % 4 < 2 ? heuristicPolicy({ margin: 0 }, "heuristic") : imitationPolicy(frozen, "frozen");
    const traces: DecisionTrace[] = [];
    const learnerPolicy = samplingPolicy(learner, rng, traces);
    const seats: SeatPolicies =
      learnerTeam === 0
        ? [learnerPolicy, opponent, learnerPolicy, opponent]
        : [opponent, learnerPolicy, opponent, learnerPolicy];
    const done = playHand(createMatch(benchSettings((seed + i) >>> 0 || 1, "marks")), seats);
    const result = done.lastResult;
    if (!result) throw new Error("The hand ended without a result");
    if (!result.passed) {
      const other = learnerTeam === 0 ? 1 : 0;
      const raw = result.awarded[learnerTeam] - result.awarded[other];
      const advantage = clamp(raw - baseline, -2, 2);
      baseline = baseline * 0.95 + raw * 0.05;
      for (const trace of traces) {
        reinforceUpdate(learner[trace.head], trace.rows, trace.chosen, advantage, lr);
      }
    }
    options.onHand?.(i + 1, hands);
  }

  const evalSeeds = Array.from({ length: evalDeals }, (_, index) => 12000 + index);
  const greedy = imitationPolicy(learner, "reinforce");
  const versusHeuristic = duel(evalSeeds, greedy, heuristicPolicy({ margin: 0 }, "heuristic"));
  const versusPrevious = duel(evalSeeds, greedy, imitationPolicy(frozen, "previous"));
  const accepted =
    versusHeuristic.awardA > versusHeuristic.awardB && versusPrevious.awardA > versusPrevious.awardB;
  return { model: learner, accepted, versusHeuristic, versusPrevious };
}

function samplingPolicy(
  model: ImitationModel,
  rng: { state: number },
  traces: DecisionTrace[],
): Policy {
  return {
    name: "learner",
    act(view: PlayerView): Action {
      const choice = sampleChoice(model, view, rng);
      if (choice.trace) traces.push(choice.trace);
      return choice.action;
    },
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
