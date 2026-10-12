import { describe, expect, it } from "vitest";
import { createMatch, concede, defaultSettings } from "../src/engine/game";
import { decode } from "../src/net/messages";
import { clearSave, readSave, writeSave, type TableSave } from "../src/ui/save";

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("saved tables", () => {
  it("round-trips a local match and rejects a hand that is not a full deck", () => {
    const storage = memory();
    const state = createMatch({ ...defaultSettings(4), scoringMode: "marks", target: 7 });
    const save: TableSave = {
      kind: "local",
      version: 1,
      state,
      pace: "fast",
      botLevel: "hard",
      me: 2,
      names: ["Ada", null, "Lee", null],
      wasOnline: true,
    };
    writeSave(storage, save);
    expect(readSave(storage)).toEqual(save);

    const broken = structuredClone(save);
    broken.state.hands[1] = [{ hi: 0, lo: 0 }];
    storage.setItem("texas42.table", JSON.stringify(broken));
    expect(readSave(storage)).toBeNull();

    const nello = structuredClone(save);
    nello.state.trump = { kind: "nello" };
    nello.state.phase = "playing";
    nello.state.hands[2] = [];
    writeSave(storage, nello);
    expect(readSave(storage)?.kind).toBe("local");

    writeSave(storage, { kind: "guest", version: 1, room: "ab12", name: "  Jo  " });
    expect(readSave(storage)).toEqual({ kind: "guest", version: 1, room: "AB12", name: "Jo" });
    clearSave(storage);
    expect(readSave(storage)).toBeNull();
    expect(readSave(memory())).toBeNull();
  });

  it("gives the match to the other team when a seat resigns", () => {
    const state = createMatch({ ...defaultSettings(2), scoringMode: "marks", target: 7 });
    const done = concede(state, 0);
    expect(done.phase).toBe("matchComplete");
    expect(done.turn).toBeNull();
    expect(done.scores).toEqual([0, 7]);
    expect(done.lastResult?.matchWinner).toBe(1);
    expect(concede(done, 1)).toBe(done);
    expect(decode('{"type":"resign"}')).toEqual({ type: "resign" });
  });
});
