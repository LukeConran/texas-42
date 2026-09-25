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
- On a non-trump lead the suit is the higher end. In follow me there is no trump. When doubles are trump, a double does not follow the number on its face.
- Each trick is worth 1. The count tiles are 5-0, 4-1, and 3-2 (5 each) and 6-4 and 5-5 (10 each). That is 42.
- Points, first to 250: a made bid scores each team what it captured. A set bid scores the bidding team nothing, and the defenders score what they captured plus the bid. A bid of 42 or higher is the stake itself. The bidder must take all 42 points, and the side that wins the contract scores that stake.
- Marks, first to 7: the side that makes or sets the bid takes one mark, or `bid / 42` marks when the bid is 42 or higher.

Nello, sevens, plunge, and splash are not in this version.

## Where a stronger bot would plug in

`observe(state, seat)` builds a `PlayerView` that contains that seat's hand and everything on the table, and not the other hands. `chooseAction(view)` returns a bid, a trump, or a play. `apply(state, action)` is the only way the match changes, and it rejects a renege.

`src/ai/heuristic.ts` is the current opponent. It is a point-count bidder and a trick-taking policy, not a trained agent. A reinforcement-learning policy can replace `chooseAction` without touching the rules. Self-play can call the same functions: the state is plain data, the shuffle is a seeded generator, and legal bids and plays are listed on the view.

## Where multiplayer would plug in

The browser is only a client of `apply`. A room on a local network, or a hosted game, would keep `GameState` on the server, accept an `Action` from the seat whose turn it is, and broadcast the view from `observe`. Clients should not be trusted to decide what is legal. Nothing in the engine depends on a single screen, so that server can come later without rewriting the rules.
