import type { Domino } from "../engine/domino";
import { dominoKey } from "../engine/domino";
import type { Action } from "../engine/game";
import { trumpKey } from "../engine/trump";

export interface LessonBeatYou {
  kind: "you";
  action: Action;
  say: string;
  hint: string;
}

export interface LessonBeatAuto {
  kind: "auto";
  action: Action;
}

export type LessonBeat = LessonBeatYou | LessonBeatAuto;

export interface Lesson {
  id: string;
  title: string;
  seed: number;
  beats: LessonBeat[];
  done: string;
}

const LESSONS: Lesson[] = [
  {
    id: "follow",
    title: "Follow suit",
    seed: 2,
    done: "You followed the five. A six is trump on this hand, so it does not follow a five. Any other tile with a five does.",
    beats: [
      { kind: "auto", action: { type: "bid", amount: "pass" } },
      {
        kind: "you",
        action: { type: "bid", amount: 30 },
        say: "East passed. Bid 30 so this lesson can name trump.",
        hint: "Bid 30. Passing deals again, and this lesson needs the hand in front of you.",
      },
      { kind: "auto", action: { type: "bid", amount: "pass" } },
      { kind: "auto", action: { type: "bid", amount: "pass" } },
      {
        kind: "you",
        action: { type: "declareTrump", trump: { kind: "suit", suit: 6 } },
        say: "You won the bid. Name sixes.",
        hint: "Name sixes. The next trick is about what follows a five when sixes are trump.",
      },
      {
        kind: "you",
        action: { type: "play", domino: tile("6-1") },
        say: "Lead the 6-1. In the usual game the opening lead may be any tile. The lesson is the trick after this one.",
        hint: "Lead the 6-1. It is the six with a one on the other end.",
      },
      { kind: "auto", action: { type: "play", domino: tile("6-2") } },
      { kind: "auto", action: { type: "play", domino: tile("2-2") } },
      { kind: "auto", action: { type: "play", domino: tile("6-6") } },
      { kind: "auto", action: { type: "acknowledgeTrick" } },
      { kind: "auto", action: { type: "play", domino: tile("5-2") } },
      {
        kind: "you",
        action: { type: "play", domino: tile("5-1") },
        say: "East led the 5-2. Sixes are trump, so your sixes do not follow a five. The bright tiles are the legal plays. Play the 5-1.",
        hint: "That tile is legal, but this lesson wants the 5-1. A six does not follow the five.",
      },
    ],
  },
  {
    id: "count",
    title: "Count the points",
    seed: 3,
    done: "The double-five counts 10 and the 5-0 counts 5. The trick itself counts 1. That is 16. Every hand has 42 points: one for each of the seven tricks, plus the five count tiles.",
    beats: [
      { kind: "auto", action: { type: "bid", amount: "pass" } },
      {
        kind: "you",
        action: { type: "bid", amount: 30 },
        say: "Bid 30. You will lead a count tile, and the table will follow.",
        hint: "Bid 30 so you can name trump and lead.",
      },
      { kind: "auto", action: { type: "bid", amount: "pass" } },
      { kind: "auto", action: { type: "bid", amount: "pass" } },
      {
        kind: "you",
        action: { type: "declareTrump", trump: { kind: "suit", suit: 1 } },
        say: "Name ones. The double-five has no one on it, so it stays a ten-count.",
        hint: "Name ones.",
      },
      {
        kind: "you",
        action: { type: "play", domino: tile("5-5") },
        say: "Lead the double-five. It counts 10. Any tile may lead, and the ringed one is the count this lesson is about.",
        hint: "Lead the double-five, the 5-5.",
      },
      { kind: "auto", action: { type: "play", domino: tile("5-0") } },
      { kind: "auto", action: { type: "play", domino: tile("5-3") } },
      { kind: "auto", action: { type: "play", domino: tile("5-2") } },
      { kind: "auto", action: { type: "acknowledgeTrick" } },
    ],
  },
];

export function lessons(): Lesson[] {
  return LESSONS;
}

export function lessonById(id: string): Lesson | undefined {
  return LESSONS.find((lesson) => lesson.id === id);
}

export function sameLessonAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "bid" && b.type === "bid") return a.amount === b.amount;
  if (a.type === "declareTrump" && b.type === "declareTrump") return trumpKey(a.trump) === trumpKey(b.trump);
  if (a.type === "play" && b.type === "play") return dominoKey(a.domino) === dominoKey(b.domino);
  return a.type === "acknowledgeTrick";
}

export function wantedKey(beat: LessonBeat | undefined): string | null {
  if (!beat || beat.kind !== "you" || beat.action.type !== "play") return null;
  return dominoKey(beat.action.domino);
}

function tile(key: string): Domino {
  const [hi, lo] = key.split("-").map(Number);
  return { hi: hi ?? 0, lo: lo ?? 0 };
}
