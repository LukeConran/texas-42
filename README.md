# Texas 42

A four-handed game of Texas 42 you can play in the browser. You sit South. Your partner is across the table, and two bots play West and East.

The rules engine is separate from the table and from the bots. A later reinforcement-learning policy can replace the heuristic by implementing the same decision function, and a later server can host the same state for more than one person.

## Play

```bash
npm install
npm run dev
```

Then open the URL Vite prints. `npm test` checks the rules. `npm run build` typechecks and writes `dist/`.

## Rules in this version

This is straight four-handed 42, the partnership game. It follows the common tournament shape from the National 42 Players Association and Austin 42 where the writeups agree, plus the point-scoring payout described with the request.

- Double-six set, seven tiles each, no boneyard.
- Partners sit across: you and Partner against West and East. Play moves clockwise, to your left (West, then Partner, then East).
- Bidding starts with the player left of the shaker. Each player bids once. Bids run from 30 through 42. After 42 the next bid is 84, and only after 84 may someone bid 126 or 168. If everyone passes, the hand is shaken again and nobody scores.
- The high bidder names trump before the lead: blanks, ones, twos, threes, fours, fives, sixes, doubles, or no trump (follow me).
- The opening lead may be any tile. The menu has a house rule that forces that first lead to be a trump.
- A tile that contains the trump number is always trump. Its other end is the rank, and the double is highest. You follow the suit that was led when you can. If you cannot, any tile is legal, including a trump, and trump is not required.
- On a non-trump lead the suit is the higher end. A tile with that number on either end must follow, unless the tile is trump. In follow me there is no trump. When doubles are trump, a double does not follow the number on its face.
- Each trick is worth 1. The count tiles are 5-0, 4-1, and 3-2 (5 each) and 6-4 and 5-5 (10 each). That is 42.
- Points, first to 250: a made bid scores each team what it captured. A set bid scores the bidding team nothing, and the defenders score what they captured plus the bid. A bid of 42 or higher is the stake itself. The bidder must take all 42 points, and the side that wins the contract scores that stake.
- Marks, first to 7: the side that makes or sets the bid takes one mark, or `bid / 42` marks when the bid is 42 or higher.

Nello, sevens, plunge, and splash are not in this version.

## Where a stronger bot would plug in

`observe(state, seat)` builds a `PlayerView` that contains that seat's hand and everything on the table, and not the other hands. `chooseAction(view)` returns a bid, a trump, or a play. `apply(state, action)` is the only way the match changes, and it rejects a renege.

`src/ai/heuristic.ts` is the current opponent. It is a point-count bidder and a trick-taking policy, not a trained agent. `src/ai/policy.ts` is the slot a later bot fills, and it still sees only that view. `src/ai/ladder.ts` plays seeded hands and records each team's award. The same deals are replayed with the two policies swapped, so a new bot has to win the award rather than draw lucky cards.

The measuring table is the first rung. The second rung, `src/ai/search.ts`, deals the cards still out several times, tries each legal bid or play, and keeps the choice that wins more marks against the heuristic. Run `npm run search`. That plays 8 deals, sampling 16 hidden hands at each decision. `npm run search -- 24 32` raises the deal count and the sample count. Each deal is played twice with the teams swapped. The table in the browser still uses the heuristic, because the search is too slow for a click.

The third rung fits weights to those search choices so a later decision is a dot product instead of another search. Run `npm run imitate`. That watches the search play 48 hands, sampling 16 hidden hands at each decision, writes the weights to `src/ai/imitate.json`, and scores the copy against the heuristic on 16 fresh deals. `npm run imitate -- 80 16` learns from more hands. The table in the browser still uses the heuristic.

The fourth rung nudges those same weights from the marks won at the end of the hand. Run `npm run rl`. That plays 80 hands. Half the opponents are the heuristic and half are a frozen copy of the weights you started with. The learning seats sample a legal choice, then the team's marks move the weights. It writes `src/ai/imitate.json` only when the new weights beat both the heuristic and the previous file on 24 fresh deals. `npm run rl -- 160 0.02` trains on more hands; the second number is the step size. The table in the browser still uses the heuristic.

## Play with friends

The first player hosts the match in their own browser. Friends join with the room code. Empty seats are filled by the same bots as a local game. The host has to leave the tab open until the match is done.

On the menu, choose **Host a room**, then share the four-letter code or the link (`?room=CODE`). The first person to join sits on the host's left, the second sits across as the host's partner, and the third sits on the host's right. **Show hands** is only on the local table. A room never offers it, and a guest only receives their own tiles.

Moves go through Redis. The host's browser still deals the tiles and decides what is legal. The host sends each guest their own tiles through Redis, long enough to deliver them. The room code alone cannot read those tiles. There is no direct browser-to-browser connection and no extra relay account.

## Host it so different networks can play

1. Push this branch and import the GitHub repo in [Vercel](https://vercel.com). Use the Vite preset. Build command `npm run build`, output directory `dist`.
2. In the Vercel project, add **Upstash Redis** from the Marketplace. The names it injects, `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`), are what carry the room. No other account is required.
3. Deploy. Open the site, host a room, and send your friend the link. They can be on any network. The host's tab is the table.

Local `npm run dev` already answers `/api/signal` in memory, which is enough for two browsers on one computer. A deployed site without the Redis variables only works while every request hits the same server instance.
