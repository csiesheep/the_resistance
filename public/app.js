// The client. Three views on one page — landing, solo setup, the table —
// picked by query string so the build works at any prefix. Solo mode runs
// the engine and the bots right here; the bots act on timers so the table
// reads as a sequence of people doing things, not a batch.
import * as E from "./shared/engine.js";
import * as B from "./shared/bots.js";
import { sayAction, sayResult } from "./shared/talk.js";
import en from "./i18n/en.js";
import zh from "./i18n/zh-Hant.js";

const LANGS = { en, "zh-Hant": zh };
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- language ----------
let lang = "en", S = en;
function t(key, p = {}) {
  const v = key.split(".").reduce((o, k) => (o ? o[k] : undefined), S);
  return String(v ?? key).replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? `{${k}}`));
}
function setLang(l) {
  lang = LANGS[l] ? l : "en";
  S = LANGS[lang];
  store.set("tr.lang", lang);
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  const [a, b, c] = S.titleParts;
  $("hero").innerHTML = `${esc(a)}<br>${esc(b)}<span class="red">${esc(c)}</span>`;
  renderSetup();
  if (game.st) render();
}
$("langBtn").addEventListener("click", () => setLang(lang === "en" ? "zh-Hant" : "en"));

// ---------- solo setup ----------
const setup = {
  n: Number(store.get("tr.n", 7)),
  level: store.get("tr.level", "normal"),
  name: store.get("tr.name", ""),
  blind: store.get("tr.blind", "0") === "1",
};
function renderSetup() {
  const n = setup.n;
  $("pCount").textContent = n;
  $("pMinus").disabled = n <= E.MIN_PLAYERS;
  $("pPlus").disabled = n >= E.MAX_PLAYERS;
  $("setupSub").textContent = t("setup.sub", { bots: n - 1 });
  $("pSummary").textContent = t("setup.summary", { spies: E.SPIES[n], ops: n - E.SPIES[n], twoFail: n >= 7 ? t("setup.twoFail") : "" });
  document.querySelectorAll("#levelSeg button").forEach((b) => b.classList.toggle("on", b.dataset.level === setup.level));
  $("nameInput").value = setup.name;
  $("nameInput").placeholder = t("setup.defaultName");
  $("blindChk").checked = setup.blind;
}
$("pMinus").addEventListener("click", () => { setup.n = Math.max(E.MIN_PLAYERS, setup.n - 1); store.set("tr.n", setup.n); renderSetup(); });
$("pPlus").addEventListener("click", () => { setup.n = Math.min(E.MAX_PLAYERS, setup.n + 1); store.set("tr.n", setup.n); renderSetup(); });
document.querySelectorAll("#levelSeg button").forEach((b) => b.addEventListener("click", () => { setup.level = b.dataset.level; store.set("tr.level", setup.level); renderSetup(); }));
$("nameInput").addEventListener("input", (e) => { setup.name = e.target.value.trim().slice(0, 16); store.set("tr.name", setup.name); });
$("blindChk").addEventListener("change", (e) => { setup.blind = e.target.checked; store.set("tr.blind", setup.blind ? "1" : "0"); });
$("btnStart").addEventListener("click", () => startGame());
$("btnPlay").addEventListener("click", () => go("?play"));

// ---------- the solo game ----------
const game = {
  st: null, me: 0, names: [], level: "normal", rng: null,
  stage: null,        // null | "voteResult" | "missionResult" — the table pauses to show something
  stageTimer: null, botTimer: null, peeked: false,
  picks: new Set(), log: [], lastVote: null,
};
const DELAY = { reveal: 200, propose: 1500, vote: 650, mission: 800 };
const botName = (seat) => game.names[seat];
const talkCtx = () => ({ rng: game.rng, names: game.names, T: S.talk, sep: lang === "en" ? ", " : "、", and: lang === "en" ? " and " : "和" });
const nameList = (seats) => seats.map((s) => game.names[s]).join(lang === "en" ? ", " : "、");

function startGame() {
  const n = setup.n;
  game.rng = E.makeRng(E.randomSeed());
  game.st = E.createGame(E.randomSeed(), n, { blindSpies: setup.blind });
  game.me = 0;
  game.level = setup.level;
  const pool = E.shuffle(game.rng, S.names.filter((x) => x !== setup.name));
  game.names = [setup.name || t("setup.defaultName"), ...pool.slice(0, n - 1)];
  game.stage = null; game.peeked = false; game.seen = false; game.picks = new Set(); game.log = []; game.lastVote = null;
  clearTimeout(game.stageTimer); clearTimeout(game.botTimer);
  addSys(t("sys.dealt", { name: botName(game.st.leader) }));
  show("table");
  render();
  tick();
}

// Bots act one at a time, on a timer, whenever the phase is waiting on them.
function tick() {
  clearTimeout(game.botTimer);
  if (!game.st || game.stage || game.st.phase === "over") { render(); return; }
  const bots = E.mustAct(game.st).filter((s) => s !== game.me);
  render();
  if (!bots.length) return;
  const seat = bots[game.rng.int(bots.length)];
  const wait = DELAY[game.st.phase] * (0.6 + 0.8 * game.rng.next());
  game.botTimer = setTimeout(() => botAct(seat), wait);
}
function botAct(seat) {
  if (!game.st || game.stage) return;
  const view = E.view(game.st, seat);
  const action = B.decide(view, game.level, game.rng);
  if (!action) return tick();
  const line = sayAction(action, view, talkCtx());
  step(action);
  if (action.type === "propose") addSys(t("sys.proposed", { name: botName(seat), team: nameList(action.team) }));
  if (line) addSay(seat, line);
  afterStep();
}
function humanAct(action) {
  if (!game.st || game.stage) return;
  try { step(action); } catch (err) { console.warn(err.message); return; }
  if (action.type === "propose") addSys(t("sys.proposed", { name: botName(game.me), team: nameList(action.team) }));
  afterStep();
}
function step(action) { game.st = E.apply(game.st, action); }

// After any action: pause on the events people need to see, else keep going.
function afterStep() {
  const ev = game.st.event;
  if (ev && ev.type === "voted") {
    game.stage = "voteResult";
    game.lastVote = ev;
    const rejecters = ev.votes.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    const outcome = ev.approved ? t("sys.approvedWord") : t("sys.rejectedWord");
    addSys(rejecters.length
      ? t("sys.voteResult", { yes: ev.yes, no: game.st.n - ev.yes, outcome, rejecters: nameList(rejecters) })
      : t("sys.voteResultNone", { yes: ev.yes, no: game.st.n - ev.yes, outcome }));
    if (ev.over) addSys(t("sys.spiesWinRejects"), true);
    render();
    game.stageTimer = setTimeout(continueStage, ev.over ? 2500 : 4000);
    return;
  }
  if (ev && ev.type === "mission") {
    game.stage = "missionResult";
    // Cards in a shuffled order, fixed for the stage: the order carries no information.
    game.lastCards = E.shuffle(game.rng, ev.team.map((_, i) => i < ev.fails));
    const outcome = ev.success ? t("table.missionSuccess").toLowerCase() : t("table.missionFailed").toLowerCase();
    addSys(t("sys.missionResult", { n: ev.mission + 1, outcome, fails: failsText(ev.fails, ev.team.length) }), !ev.success);
    render();
    // A few bots react, one after another.
    const speakers = E.shuffle(game.rng, [...Array(game.st.n).keys()].filter((s) => s !== game.me)).slice(0, ev.success ? 2 : 3);
    speakers.forEach((s, i) => setTimeout(() => {
      if (game.stage !== "missionResult") return;
      const line = sayResult(E.view(game.st, s), s, talkCtx());
      if (line) addSay(s, line);
    }, 1400 + i * 900));
    game.stageTimer = setTimeout(continueStage, ev.over ? 5000 : 6500);
    return;
  }
  if (game.st.phase === "propose" && game.st.rejects === E.MAX_REJECTS - 1) addSys(t("sys.fifthWarning"), true);
  tick();
}
function continueStage() {
  clearTimeout(game.stageTimer);
  game.stage = null;
  game.picks = new Set();
  if (game.st.phase === "over") {
    addSys(t("sys.over", { side: game.st.winner === E.SPY ? t("roles.spySide") : t("roles.resistanceSide") }));
    render();
    return;
  }
  tick();
}
const failsText = (fails, n) => (fails === 0 ? t("table.noFails") : t(fails === 1 ? "table.failsAmong" : "table.failsAmongPlural", { fails, n }));

// ---------- log ----------
function addSay(seat, text) { game.log.push({ seat, text }); renderLog(); }
function addSys(text, hot = false) { game.log.push({ sys: true, text, hot }); renderLog(); }
function renderLog() {
  const el = $("log");
  el.innerHTML = game.log.slice(-60).map((l) => l.sys
    ? `<div class="sys${l.hot ? " hot" : ""}">${esc(l.text)}</div>`
    : `<div class="${l.seat === game.me ? "me" : ""}"><b>${esc(botName(l.seat))}</b> ${esc(l.text)}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

// ---------- rendering the table ----------
function render() {
  if (!game.st) return;
  const st = game.st, v = E.view(st, game.me);
  renderBar(v); renderTrack(v); renderVoteTrack(v); renderRing(v); renderPanel(v); renderLog();
  renderOverlay(v);
}
function renderBar(v) {
  const left = v.phase === "over" ? t("over.title") : `${t("table.round", { n: v.rounds.length })} · ${t("table.mission", { n: Math.min(v.mission + 1, E.MISSIONS) })}`;
  $("barLeft").textContent = left;
  const lead = v.leader === game.me ? t("table.youLead") : t("table.leads", { name: botName(v.leader) });
  $("barRight").innerHTML = v.phase === "over" ? "" : `<span class="t">${esc(lead)}</span>`;
}
function renderTrack(v) {
  const results = v.rounds.map((r) => r.result).filter(Boolean);
  $("track").innerHTML = v.sizes.map((size, i) => {
    const r = results[i];
    const cls = r ? (r.success ? "ok" : "no") : (i === v.mission && v.phase !== "over" ? "cur" : "");
    const two = E.failsNeeded(v.n, i) === 2 ? " ✕✕" : "";
    return `<div class="m ${cls}">${i + 1}<i>${size}${two}</i></div>`;
  }).join("");
}
function renderVoteTrack(v) {
  const pips = [...Array(E.MAX_REJECTS).keys()].map((i) => `<span class="${i < v.rejects ? "x" : ""}"></span>`).join("");
  const label = v.phase === "over" ? "" : (v.rejects ? t("table.rejected", { n: v.rejects }) : "");
  $("vtrack").innerHTML = pips + (label ? `<em>${esc(label)}</em>` : "");
}
function renderRing(v) {
  const n = v.n, me = game.me;
  const ring = $("ring");
  ring.style.setProperty("--r", `${Math.round(ring.clientWidth * 0.41)}px`);
  const team = v.proposal || [];
  const votes = game.stage === "voteResult" ? game.lastVote.votes : null;
  const mySpies = v.spies || [];
  const proposing = v.phase === "propose" && v.leader === me && !game.stage;
  const html = [];
  for (let i = 0; i < n; i++) {
    const a = (((i - me) / n) + 0.5) % 1; // me at the bottom
    const cls = ["seat"];
    if (i === me) cls.push("you");
    if (i === v.leader && v.phase !== "over") cls.push("lead");
    if (team.includes(i)) cls.push("team");
    if (proposing && game.picks.has(i)) cls.push("pick");
    if (mySpies.includes(i) && i !== me && v.phase !== "over") cls.push("spy");
    if ((v.phase === "vote" || v.phase === "mission") && team.length && !team.includes(i) && !game.stage) cls.push("dim");
    if (proposing) cls.push("tappable");
    let badge = "";
    if (votes) badge = `<span class="v ${votes[i] ? "y" : "n"}">${votes[i] ? "✓" : "✕"}</span>`;
    else if (v.phase === "vote" && v.voted && !game.stage) badge = `<span class="done ${v.voted[i] ? "on" : ""}"></span>`;
    else if (v.phase === "mission" && v.played && team.includes(i) && !game.stage) badge = `<span class="done ${v.played[team.indexOf(i)] ? "on" : ""}"></span>`;
    const ai = i === me ? "" : `<span class="ai">${esc(t("table.ai"))}</span>`;
    const initial = esc([...botName(i)][0] || "?");
    html.push(`<button type="button" class="${cls.join(" ")}" style="--a:${a}" data-seat="${i}" ${proposing ? "" : "tabindex=-1"}><span class="av">${initial}${ai}${badge}</span><span class="nm">${esc(i === me ? t("table.you") : botName(i))}</span></button>`);
  }
  html.push(`<div class="center">${centerHtml(v)}</div>`);
  ring.innerHTML = html.join("");
  if (proposing) ring.querySelectorAll(".seat").forEach((el) => el.addEventListener("click", () => togglePick(Number(el.dataset.seat))));
}
function centerHtml(v) {
  const me = game.me;
  if (game.stage === "voteResult") {
    const ev = game.lastVote;
    return `<span class="k">${esc(ev.approved ? t("table.approved") : t("table.rejectedTeam"))}</span><div class="big ${ev.approved ? "blue" : "red"}">${ev.yes}–${v.n - ev.yes}</div><span class="sub">${esc(ev.approved ? t("table.teamGoes") : (v.phase === "over" ? "" : t("table.nextLeader", { name: botName(v.leader) })))}</span>`;
  }
  if (game.stage === "missionResult") {
    const ev = v.event;
    return `<span class="k">${esc(t("table.shuffled"))}</span><div class="big ${ev.success ? "blue" : "red"}">${esc(ev.success ? t("table.missionSuccess") : t("table.missionFailed"))}</div><span class="sub">${esc(failsText(ev.fails, ev.team.length))}${ev.need === 2 && ev.fails === 1 ? " · " + esc(t("table.twoNeeded")) : ""}</span>`;
  }
  if (v.phase === "propose") {
    if (v.leader === me) return `<span class="k">${esc(t("table.pick"))}</span><div class="big">${game.picks.size}<span class="dimmed">/${v.teamSize}</span></div><span class="sub">${esc(t("table.tapSeats"))}</span>`;
    return `<span class="k">${esc(t("table.mission", { n: v.mission + 1 }))}</span><div class="big dimmed">${v.teamSize}</div><span class="sub">${esc(t("table.choosing", { name: botName(v.leader) }))}</span>`;
  }
  if (v.phase === "vote") {
    const done = v.voted.filter(Boolean).length;
    return `<span class="k">${esc(t("table.proposes", { name: botName(v.leader) }))}</span><div class="big mid">${esc(nameList(v.proposal).replace(/, |、/g, " · "))}</div><span class="sub">${esc(t("table.voted", { done, n: v.n }))}</span>`;
  }
  if (v.phase === "mission") {
    const done = v.played.filter(Boolean).length;
    return `<span class="k">${esc(t("table.mission", { n: v.mission + 1 }))}</span><div class="big mid">${esc(nameList(v.proposal).replace(/, |、/g, " · "))}</div><span class="sub">${esc(t("table.agentsChoosing", { n: v.proposal.length - done }))}</span>`;
  }
  if (v.phase === "over") {
    const spyWin = v.winner === E.SPY;
    return `<span class="k">${esc(t("over.title"))}</span><div class="big ${spyWin ? "red" : "blue"} mid">${esc(spyWin ? t("over.spyWin") : t("over.resWin"))}</div>`;
  }
  return "";
}
function togglePick(seat) {
  const v = E.view(game.st, game.me);
  if (game.picks.has(seat)) game.picks.delete(seat);
  else if (game.picks.size < v.teamSize) game.picks.add(seat);
  renderRing(v); renderPanel(v);
}

function renderPanel(v) {
  const me = game.me, p = $("panel");
  const btn = (id, cls, label, disabled = false) => `<button type="button" id="${id}" class="btn ${cls}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`;
  if (game.stage === "voteResult") {
    p.innerHTML = btn("btnCont", "gh", t("table.continue"));
    $("btnCont").addEventListener("click", continueStage);
    return;
  }
  if (game.stage === "missionResult") {
    const ev = v.event;
    const cards = game.lastCards;
    p.innerHTML = `<div class="flip">${cards.map((fail, i) => `<div class="card" style="transition-delay:${i * 250}ms"><div class="face back"></div><div class="face ${fail ? "f" : "s"}">${esc(fail ? t("table.fail") : t("table.success"))}</div></div>`).join("")}</div>`
      + (v.phase !== "over" ? `<div class="field small"><span>${esc(t("table.nextLeader", { name: v.leader === me ? t("table.you") : botName(v.leader) }))}</span></div>` : "")
      + btn("btnCont", "gh", t("table.continue"));
    requestAnimationFrame(() => requestAnimationFrame(() => p.querySelectorAll(".card").forEach((c) => c.classList.add("shown"))));
    $("btnCont").addEventListener("click", continueStage);
    return;
  }
  switch (v.phase) {
    case "propose":
      if (v.leader === me) {
        p.innerHTML = btn("btnPropose", "p", t("table.propose"), game.picks.size !== v.teamSize);
        $("btnPropose").addEventListener("click", () => humanAct({ type: "propose", seat: me, team: [...game.picks] }));
      } else p.innerHTML = "";
      return;
    case "vote":
      if (v.voted[me]) {
        p.innerHTML = `<p class="note">${esc(t("table.youVoted", { vote: v.myVote ? t("table.approve") : t("table.reject") }))}</p>`;
      } else {
        p.innerHTML = `<div class="row">${btn("btnYes", "p", t("table.approve"))}${btn("btnNo", "r", t("table.reject"))}</div>`;
        $("btnYes").addEventListener("click", () => humanAct({ type: "vote", seat: me, approve: true }));
        $("btnNo").addEventListener("click", () => humanAct({ type: "vote", seat: me, approve: false }));
      }
      return;
    case "mission":
      if (v.proposal.includes(me) && v.myCard === null) {
        const spy = v.role === E.SPY;
        p.innerHTML = `<p class="ph"><span>${esc(t("table.playCard"))}</span><small>${esc(t("table.playSub"))}</small></p>
          <div class="cards">
            <button type="button" id="cardS" class="mc s">${esc(t("table.success"))}<small>${esc(t("table.tapToPlay"))}</small></button>
            <button type="button" id="cardF" class="mc f" ${spy ? "" : "disabled"}>${esc(t("table.fail"))}<small>${esc(spy ? t("table.tapToPlay") : t("table.notForYou"))}</small></button>
          </div>`;
        $("cardS").addEventListener("click", () => humanAct({ type: "play", seat: me, success: true }));
        $("cardF").addEventListener("click", () => humanAct({ type: "play", seat: me, success: false }));
      } else p.innerHTML = `<p class="note">${esc(t("table.waitingTeam"))}</p>`;
      return;
    case "over":
      p.innerHTML = overHtml(v);
      $("btnAgain").addEventListener("click", () => startGame());
      return;
    default:
      p.innerHTML = "";
  }
}
function overHtml(v) {
  const me = game.me, spyWin = v.winner === E.SPY;
  const mine = v.roles[me] === E.SPY;
  const won = mine === spyWin;
  const why = v.reason === "rejects" ? t("over.byRejects") : t("over.byMissions", { what: spyWin ? t("over.failed") : t("over.succeeded") });
  const chips = [...Array(v.n).keys()].sort((a, b) => (v.roles[a] === E.SPY ? 0 : 1) - (v.roles[b] === E.SPY ? 0 : 1))
    .map((s) => `<span class="${v.roles[s] === E.SPY ? "s" : "r"}">${esc(s === me ? t("table.you") : botName(s))}</span>`).join("");
  const rows = v.rounds.map((r) => {
    const p = r.proposals[r.proposals.length - 1];
    const teamStr = r.result ? nameList(r.result.team) : (p ? nameList(p.team) : "");
    const voteStr = p ? `${p.votes.filter(Boolean).length}–${p.votes.length - p.votes.filter(Boolean).length}${r.proposals.length > 1 ? ` (×${r.proposals.length})` : ""}` : "";
    const res = r.result ? `<span class="dot ${r.result.success ? "ok" : "no"}"></span>${esc(t(r.result.fails === 1 ? "over.fails" : "over.failsPlural", { n: r.result.fails }))}` : "";
    return `<tr><td>${r.mission + 1}</td><td>${esc(teamStr)}</td><td>${voteStr}</td><td>${res}</td></tr>`;
  }).join("");
  return `<div class="result-head"><span class="k">${esc(why)}</span><span class="sub">${esc(t("over.youWere", { role: mine ? t("roles.spy") : t("roles.resistance") }))} ${esc(won ? t("over.youWon") : t("over.youLost"))}</span></div>
    <span class="lab">${esc(t("over.spies"))}</span><div class="who">${chips}</div>
    <table class="h"><tr><th>${esc(t("over.hM"))}</th><th>${esc(t("over.hTeam"))}</th><th>${esc(t("over.hVote"))}</th><th>${esc(t("over.hResult"))}</th></tr>${rows}</table>
    <div class="row"><a class="btn" href="rules.html">${esc(t("over.rules"))}</a><button type="button" id="btnAgain" class="btn p">${esc(t("over.again"))}</button></div>`;
}

// ---------- reveal overlay ----------
function renderOverlay(v) {
  const ov = $("overlay");
  if (v.phase !== "reveal") { ov.hidden = true; return; }
  const spy = v.role === E.SPY;
  const mates = spy ? (v.spies ? v.spies.filter((s) => s !== game.me) : null) : null;
  ov.hidden = false;
  ov.innerHTML = `<div class="sheet">
    <div id="roleCard" class="card-role ${game.peeked ? (spy ? "spy" : "res") : "hidden-role"}">
      ${game.peeked ? `<span class="k">${esc(t("reveal.yourCard"))}</span><span class="role">${esc(spy ? t("reveal.spy") : t("reveal.res"))}</span><p>${esc(spy ? t("reveal.spyText") : t("reveal.resText"))}</p>`
        + (spy ? (mates ? `<span class="k" style="margin-top:8px">${esc(t("reveal.others"))}</span><div class="mates">${mates.map((s) => `<div><span class="av">${esc([...botName(s)][0])}</span>${esc(botName(s))}</div>`).join("")}</div>` : `<p class="muted">${esc(t("reveal.blind"))}</p>`) : "")
        : `<span class="k">${esc(t("reveal.yourCard"))}</span><span class="role" style="color:var(--mute)">?</span>`}
    </div>
    <button type="button" id="btnPeek" class="btn">${esc(game.peeked ? t("reveal.release") : t("reveal.hold"))}</button>
    <button type="button" id="btnReady" class="btn p" ${game.seen ? "" : "disabled"}>${esc(t("reveal.ready"))}</button>
  </div>`;
  const peek = (on) => { game.peeked = on; if (on) game.seen = true; renderOverlay(v); };
  const pb = $("btnPeek");
  pb.addEventListener("pointerdown", (e) => { e.preventDefault(); peek(true); });
  pb.addEventListener("pointerup", () => peek(false));
  pb.addEventListener("pointerleave", () => { if (game.peeked) peek(false); });
  pb.addEventListener("pointercancel", () => peek(false));
  pb.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); peek(!game.peeked); } });
  $("btnReady").addEventListener("click", () => { game.peeked = false; humanAct({ type: "ready", seat: game.me }); });
}

// ---------- routing ----------
const views = ["landing", "setup", "table"];
function show(name) { for (const v of views) $("view-" + v).hidden = v !== name; if (name !== "table") $("overlay").hidden = true; }
function go(q) { history.pushState(null, "", location.pathname + q); route(); }
function route() {
  const q = new URLSearchParams(location.search);
  if (q.has("lang")) setLang(q.get("lang"));
  if (q.has("play")) { if (game.st && game.st.phase !== "over") { show("table"); render(); } else { show("setup"); renderSetup(); } }
  else { show("landing"); }
}
document.querySelectorAll("[data-link]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); go(""); }));
window.addEventListener("popstate", route);
window.addEventListener("resize", () => { if (game.st && !$("view-table").hidden) renderRing(E.view(game.st, game.me)); });

const q0 = new URLSearchParams(location.search);
setLang(q0.get("lang") || store.get("tr.lang", (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh-Hant" : "en"));
route();
