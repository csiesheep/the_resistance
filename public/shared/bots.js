// The AI seats. A bot decides from a `view` (engine.view) and nothing else, so
// it can only know what a human in that seat would know: its own role, the
// other spies if it is one, and the public history. Bots keep no memory; the
// posterior is recomputed from the history at every decision, which keeps
// them stateless (a room can be restored from storage and the bots just
// carry on) and deterministic given the rng.
//
// Model: there are at most C(10,4) = 210 possible spy sets. A resistance bot
// keeps a posterior over them, starting uniform, minus the sets that contain
// itself. Mission results are near-hard evidence (f fails means at least f
// spies on that team); votes are soft evidence (spies tend to approve teams
// that carry a spy and reject clean ones). Everything the bot does derives
// from the marginal P(spy) per seat and P(fail) per candidate team.
//
// Every decision also carries a `why`, so the table-talk module can say
// something true about it.

import * as E from "./engine.js";

const { RESISTANCE, SPY } = E;

export const LEVELS = ["easy", "normal", "hard"];

// Per-level knobs. `noise` is the chance a decision is taken at random
// instead of from the model; `voteWeight` scales how much voting patterns
// count (0 = ignored); `slack` is how much worse than the best available
// team a proposal may be and still get a resistance approve; `spyCover` is
// how often a spy lets a cheap-to-blame mission (two seats, or mission 1)
// through when the score allows; `spyMimic` is how often a spy
// votes the way an operative in its seat would, instead of by its own
// interest (the rulebook's advice: act like the resistance); `fog` is how
// much weight the operatives keep on a spy set the mission results have
// ruled out — 0 is exact inference, more is the human habit of forgiving a
// seat that was on a failed mission.
//
// Tuned with tests/sim.js (300 games per cell, bots on both sides), resistance
// win rate at 5..10 players:
//   easy    34 37 21 13 25 10   spies blunder (eager fails, tell-tale votes),
//                               operatives are foggy and ignore votes
//   normal  53 66 42 38 31 38   the target band: close to the real game's feel
//   hard    55 95 48 41 39 48   near-exact operatives; six players is theirs
// Across levels: hard spies vs normal operatives 44 72 35 32 32 31; hard
// operatives vs normal spies 80 78 86 82 63 89.
export const LEVEL = {
  easy:   { noise: 0.25, voteWeight: 0.0, slack: 0.30, spyCover: 0.3, spyMimic: 0.0, fog: 0.40 },
  normal: { noise: 0.08, voteWeight: 0.5, slack: 0.15, spyCover: 0.8, spyMimic: 0.5, fog: 0.45 },
  hard:   { noise: 0.0,  voteWeight: 1.0, slack: 0.09, spyCover: 0.8, spyMimic: 1.0, fog: 0.12 },
};

// How likely a spy on a team is to play Fail, by mission — used only inside
// the likelihood of a result. Spies often let mission 1 through.
const SPY_FAIL_RATE = [0.6, 0.85, 0.9, 0.9, 0.95];

// Vote likelihoods, P(approve | voter is spy?, team carries a spy?).
const P_APPROVE = {
  spy:  { withSpy: 0.85, clean: 0.35 },
  res:  { withSpy: 0.6,  clean: 0.6 },   // uninformative on purpose: operatives don't know
};

// ---------- combinatorics ----------
export function combos(items, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

// ---------- the posterior ----------
// A spy set is a bitmask over seats (n <= 10, so it fits in an int). Keeping
// the whole model in ints and flat arrays means a decision allocates almost
// nothing, which matters in a Durable Object and keeps the harness fast.
const popcount = (x) => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
export const maskOf = (seats) => seats.reduce((m, s) => m | (1 << s), 0);

// `knownClean` is a seat that is certainly not a spy (the bot itself, when it
// is an operative). Pass null for an outsider's view of the table, which is
// what a spy uses to judge how it looks to the others.
// Returns [{ set, mask, p }], p summing to 1.
export function posterior(view, { knownClean = null, voteWeight = 0.5, fog = 0 } = {}) {
  const n = view.n;
  const sets = [];
  for (const set of combos([...Array(n).keys()], E.SPIES[n])) {
    const mask = maskOf(set);
    if (knownClean !== null && (mask >> knownClean) & 1) continue;
    sets.push({ set, mask, w: 1, p: 0 });
  }
  const fS = new Float64Array(n), fR = new Float64Array(n); // per-voter factors, reused

  for (const round of view.rounds) {
    const rate = SPY_FAIL_RATE[round.mission] ?? 0.9;
    round.proposals.forEach((p, idx) => {
      // The fifth proposal is forced (approve or lose), so it says nothing.
      if (voteWeight <= 0 || idx >= E.MAX_REJECTS - 1) return;
      const teamMask = maskOf(p.team);
      for (const carries of [false, true]) {
        const pS = carries ? P_APPROVE.spy.withSpy : P_APPROVE.spy.clean;
        const pR = carries ? P_APPROVE.res.withSpy : P_APPROVE.res.clean;
        for (let v = 0; v < n; v++) { fS[v] = p.votes[v] ? pS : 1 - pS; fR[v] = p.votes[v] ? pR : 1 - pR; }
        for (const h of sets) {
          if (((h.mask & teamMask) !== 0) !== carries) continue;
          let like = 1;
          for (let v = 0; v < n; v++) like *= (h.mask >> v) & 1 ? fS[v] : fR[v];
          h.w *= Math.pow(like, voteWeight);
        }
      }
    });
    if (round.result) {
      const teamMask = maskOf(round.result.team);
      const fails = round.result.fails;
      for (const h of sets) {
        const k = popcount(h.mask & teamMask);
        if (fails > k) { h.w *= fog; continue; }
        h.w *= binom(k, fails) * Math.pow(rate, fails) * Math.pow(1 - rate, k - fails);
      }
    }
  }
  let total = 0;
  for (const h of sets) total += h.w;
  if (!(total > 0)) { for (const h of sets) h.w = 1; total = sets.length; } // contradictory history (should not happen)
  for (const h of sets) h.p = h.w / total;
  return sets;
}

export function marginals(sets, n) {
  const m = new Array(n).fill(0);
  for (const h of sets) for (let s = 0; s < n; s++) if ((h.mask >> s) & 1) m[s] += h.p;
  return m;
}

// P(the mission fails | this team), assuming spies fail whenever they can.
export function pFail(sets, team, need) {
  const teamMask = maskOf(team);
  let p = 0;
  for (const h of sets) if (popcount(h.mask & teamMask) >= need) p += h.p;
  return p;
}

// ---------- policies ----------
const sortNum = (a) => a.slice().sort((x, y) => x - y);
// The operative's approval rule: a team is fine if it is not much worse than
// the best team this seat could propose. The vote track loosens it.
const wouldApprove = (pf, bestPf, view, lv) => pf <= bestPf + lv.slack + 0.08 * view.rejects;
// Best team including `me`, by P(fail), under a posterior.
function bestTeamWith(sets, me, n, k, need) {
  const others = [...Array(n).keys()].filter((s) => s !== me);
  let best = null;
  for (const rest of combos(others, k - 1)) {
    const team = sortNum([me, ...rest]);
    const pf = pFail(sets, team, need);
    if (!best || pf < best.pf) best = { team, pf };
  }
  return best;
}
const topSuspects = (m, exclude, count = 2) =>
  [...m.keys()].filter((s) => !exclude.includes(s)).sort((a, b) => m[b] - m[a]).slice(0, count);

function resistanceDecision(view, lv, rng) {
  const me = view.seat;
  const sets = posterior(view, { knownClean: me, voteWeight: lv.voteWeight, fog: lv.fog });
  const m = marginals(sets, view.n);
  const others = [...Array(view.n).keys()].filter((s) => s !== me);
  const k = view.teamSize, need = view.failsNeeded;
  // Every team that includes me, scored by P(fail). I know I am clean, so
  // any team without me is strictly worse than the same team with me swapped in.
  const candidates = combos(others, k - 1).map((rest) => {
    const team = sortNum([me, ...rest]);
    return { team, pf: pFail(sets, team, need) };
  }).sort((a, b) => a.pf - b.pf || (a.team.join() < b.team.join() ? -1 : 1));
  const best = candidates[0];

  if (view.phase === "propose") {
    if (rng.next() < lv.noise) {
      const pick = candidates[rng.int(Math.min(3, candidates.length))];
      return { type: "propose", seat: me, team: pick.team, why: { trusted: pick.team.filter((s) => s !== me), pFail: pick.pf, suspects: topSuspects(m, pick.team) } };
    }
    return { type: "propose", seat: me, team: best.team, why: { trusted: best.team.filter((s) => s !== me), pFail: best.pf, suspects: topSuspects(m, best.team) } };
  }

  if (view.phase === "vote") {
    const team = view.proposal;
    const pf = pFail(sets, team, need);
    const forced = view.rejects >= E.MAX_REJECTS - 1;
    let approve = forced || view.leader === me || wouldApprove(pf, best.pf, view, lv);
    if (!forced && rng.next() < lv.noise) approve = rng.next() < 0.6;
    const worst = team.filter((s) => s !== me).sort((a, b) => m[b] - m[a])[0];
    return { type: "vote", seat: me, approve, why: { forced, pFail: pf, bestPFail: best.pf, onTeam: team.includes(me), suspect: worst, suspectP: m[worst] } };
  }

  if (view.phase === "mission") return { type: "play", seat: me, success: true };
  return null;
}

function spyDecision(view, lv, rng) {
  const me = view.seat;
  const n = view.n;
  const spies = view.spies ? view.spies : [me]; // blind spies know only themselves
  const isSpy = (s) => spies.includes(s);
  // How the table looks from the outside: which seats the operatives trust.
  const sets = posterior(view, { knownClean: null, voteWeight: lv.voteWeight, fog: lv.fog });
  const m = marginals(sets, n);
  const k = view.teamSize, need = view.failsNeeded;
  const score = view.score;
  const decisive = score[SPY] === E.WINS_NEEDED - 1 || score[RESISTANCE] === E.WINS_NEEDED - 1;

  if (view.phase === "propose") {
    // Me plus the most-trusted operatives: exactly one spy, and a team that
    // reads as a sensible pick. With two fails needed, bring a second spy.
    const spiesWanted = Math.min(need, spies.length, k);
    const otherSpies = spies.filter((s) => s !== me).sort((a, b) => m[a] - m[b]).slice(0, spiesWanted - 1);
    const ops = [...Array(n).keys()].filter((s) => !isSpy(s)).sort((a, b) => m[a] - m[b]);
    const team = sortNum([me, ...otherSpies, ...ops].slice(0, k));
    if (rng.next() < lv.noise) {
      const rnd = sortNum(E.shuffle(rng, [...Array(n).keys()].filter((s) => s !== me)).slice(0, k - 1).concat(me));
      return { type: "propose", seat: me, team: rnd, why: { trusted: rnd.filter((s) => s !== me), suspects: topSuspects(m, rnd) } };
    }
    return { type: "propose", seat: me, team, why: { trusted: team.filter((s) => s !== me), suspects: topSuspects(m, team) } };
  }

  if (view.phase === "vote") {
    const team = view.proposal;
    const spiesOn = team.filter(isSpy).length;
    const canSink = spiesOn >= need;
    let approve;
    if (view.rejects >= E.MAX_REJECTS - 1) approve = false;          // the fifth rejection wins
    else if (decisive) approve = canSink;                              // this vote decides the game
    else if (view.leader === me) approve = true;                       // nobody rejects their own team
    else if (rng.next() < lv.spyMimic) {
      // Vote as an operative in this seat would, from the outsider posterior
      // (which does not know I am a spy), so my votes carry no signal.
      const outsiderBest = bestTeamWith(sets, me, n, k, need);
      approve = wouldApprove(pFail(sets, team, need), outsiderBest.pf, view, lv);
    }
    else if (canSink) approve = rng.next() < 0.85;
    else if (view.mission === 0) approve = rng.next() < 0.8;           // cover on mission 1
    else approve = rng.next() < 0.3;
    if (rng.next() < lv.noise) approve = rng.next() < 0.6;
    const worst = team.filter((s) => s !== me).sort((a, b) => m[b] - m[a])[0];
    return { type: "vote", seat: me, approve, why: { canSink, pFail: pFail(sets, team, need), onTeam: team.includes(me), suspect: worst, suspectP: m[worst] } };
  }

  if (view.phase === "mission") {
    const team = view.proposal;
    const spiesOn = team.filter(isSpy);
    if (!view.spies) {
      // Blind: cannot coordinate. Fail unless it is clearly wasted.
      return { type: "play", seat: me, success: need > 1 && rng.next() < 0.5 };
    }
    if (spiesOn.length < need) return { type: "play", seat: me, success: true }; // cannot sink; don't burn cover
    // Exactly `need` spies fail, chosen by seat order so they never over-fail.
    const designated = spiesOn.slice(0, need);
    if (!designated.includes(me)) return { type: "play", seat: me, success: true };
    // A fail on a two-seat team, or on mission 1, costs a lot of cover: the
    // operatives learn half a name. Let those through unless the score says
    // every remaining mission has to sink.
    const failsStillNeeded = E.WINS_NEEDED - score[SPY];
    const missionsLeft = E.MISSIONS - view.mission;
    const must = decisive || failsStillNeeded >= missionsLeft;
    const cheap = team.length <= 2 || view.mission === 0;
    if (!must && cheap && rng.next() < lv.spyCover) return { type: "play", seat: me, success: true };
    return { type: "play", seat: me, success: false };
  }
  return null;
}

// ---------- entry point ----------
// Returns the action this seat should take now, or null if it is not its turn.
export function decide(view, level = "normal", rng = E.makeRng(E.randomSeed())) {
  const lv = LEVEL[level] || LEVEL.normal;
  const me = view.seat;
  if (me === null || !view.waitingOn.includes(me)) return null;
  if (view.phase === "reveal") return { type: "ready", seat: me };
  if (view.role === SPY) return spyDecision(view, lv, rng);
  return resistanceDecision(view, lv, rng);
}

// Suspicion as this seat sees it — for the UI's "who do you think" hints and
// for table talk. Operatives get their own posterior; spies get the outsider view.
export function suspicion(view, level = "normal") {
  const lv = LEVEL[level] || LEVEL.normal;
  const clean = view.role === RESISTANCE ? view.seat : null;
  return marginals(posterior(view, { knownClean: clean, voteWeight: lv.voteWeight, fog: lv.fog }), view.n);
}
