# The Resistance

A browser version of *The Resistance*, the 5–10 player social-deduction game by Don Eskridge (Indie Boards & Cards). Play solo against AI bots, or open an online room and share a four-letter code with friends; bots fill any empty seats. English and traditional Chinese.

Fan-made and unofficial. Own art and prose; the rules are the game's own.

Live at https://games.csiesheep.com/the_resistance/ — solo mode is playable; online rooms are the next milestone.

## How it works

Everything runs on Cloudflare as one Worker, the same shape as [Dice Wars](https://github.com/csiesheep/dice_war):

- `public/` is the client: landing, setup, lobby and the table view, served as static assets. `public/shared/engine.js` holds all rules (tables, phase machine, per-seat view projection), `public/shared/bots.js` the AI and `public/shared/talk.js` the bots' table talk, all used unchanged by both the browser and the server. Every player-visible string is in `public/i18n/`.
- `src/index.js` is the Worker: the path-prefix router that serves `/the_resistance/…` plus, from the multiplayer milestone, the WebSocket entry point at `/the_resistance/ws`.
- `src/room.js` (to come) is a Durable Object, one per room, named by its code. It is authoritative: it deals the roles, keeps the phase clock, runs the AI seats, and sends each seat only what that seat may see.

URLs are query strings on the page so the same build works at any prefix:

- `/the_resistance/` landing
- `/the_resistance/?play` single player
- `/the_resistance/?room=ABCD` an online room

## Milestones

1. **M0 Scaffold** — router, placeholder page, deploy. Done.
2. **M1 Engine** — tables, phase machine, reducer, `view(state, seat)`, tests. Done.
3. **M2 Bots** — Bayesian suspicion model over spy sets, resistance and spy policies, three levels, a bot-vs-bot harness to tune win rates. Done.
4. **M3 Solo** — the full game against bots in the browser, with bot table talk. Done.
5. **M4 Rooms** — Durable Object, phase timers, chat, bot fill, disconnect takeover.
6. **M5 Ship** — rules page, SEO, hub card, sitemap.

## Develop

```bash
npm install
npm run dev
```

Then open http://localhost:8787/the_resistance/.

```bash
npm test          # engine and bot tests
npm run sim 300   # bot-vs-bot win rates per player count and level
```

The harness runs each cell in a child process with retries: Node 24 on the development machine dies with an access violation a few percent of the time on this workload, under any V8 flags.

## Deploy

```bash
npm run deploy
```

Deploys from a logged-in `wrangler`. The routes in `wrangler.jsonc` attach the Worker to `games.csiesheep.com/the_resistance` and `/the_resistance/*`; the `games` hub Worker keeps the hostname itself. Pushes to `main` do not deploy on their own unless the repo is connected under Workers & Pages in the Cloudflare dashboard, as the sibling games are.
