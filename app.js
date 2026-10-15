// Lanterns: spaced-repetition flashcards with progress synced to a GitHub repo file.
"use strict";

const EXAM_DATE = "2026-12-20";
const NEW_UNTIL = "2026-11-30"; // last day for new cards; after this, review only
const MAX_IVL = 21; // days; keeps every card cycling at least every 3 weeks before the exam
const TIER_ORDER = { S: 0, A: 1, B: 2 };
const LETTERS = "কখগঘঙ";

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const settings = Object.assign(
  { token: "", repo: "raiyan22/paper-lanterns", path: "progress.json", dailyNew: 0, sessionSize: 40, decks: null, theme: "" },
  LS.get("lt.settings", {})
);
if (!LS.get("lt.device", null)) LS.set("lt.device", Math.random().toString(36).slice(2, 8));
const DEVICE = LS.get("lt.device", "x");
let progress = LS.get("lt.progress", null) || { v: 1, cards: {}, flags: {}, log: {} };
let remoteSha = null, dirty = 0, syncing = false;

function saveLocal() { LS.set("lt.progress", progress); }
function saveSettings() { LS.set("lt.settings", settings); }
if (settings.theme) document.documentElement.dataset.theme = settings.theme;

// ---------- dates ----------
function dayNum(d = new Date()) { return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000); }
function dayOf(iso) { const [y, m, d] = iso.split("-").map(Number); return dayNum(new Date(y, m - 1, d)); }
const TODAY = () => dayNum();
function isoDay(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }

// ---------- data ----------
let decks = [], cards = [], byId = {};
async function loadData() {
  decks = await (await fetch("data/decks.json", { cache: "no-cache" })).json();
  const lists = await Promise.all(decks.map(d => fetch("data/" + d.file, { cache: "no-cache" }).then(r => r.json())));
  cards = []; byId = {};
  lists.forEach((list, i) => list.forEach((c, j) => {
    if (c.type === "mcq" && !(c.ans >= 0)) return; // answer missing in the book
    c.deck = decks[i].id; c.subject = decks[i].subject; c.ord = j;
    cards.push(c); byId[c.id] = c;
  }));
  if (!settings.decks) settings.decks = decks.map(d => d.id);
}
const activeCards = () => cards.filter(c => settings.decks.includes(c.deck));

// ---------- scheduling ----------
// entry: [due, ivl, ease, reps, lapses, lastTs]
function st(id) { return progress.cards[id]; }
function grade(id, correct) {
  const t = TODAY(), now = Date.now();
  let [, ivl, ease, reps, lapses] = st(id) || [t, 0, 2.5, 0, 0];
  if (correct) {
    ivl = ivl <= 0 ? 1 : Math.min(MAX_IVL, Math.max(ivl + 1, Math.round(ivl * ease)));
    ease = Math.min(3.0, ease + 0.03);
    reps++;
  } else {
    ivl = 0; ease = Math.max(1.3, ease - 0.2); lapses++;
  }
  const isNew = !st(id);
  progress.cards[id] = [ivl === 0 ? t : t + ivl, ivl, +ease.toFixed(2), reps, lapses, now];
  const L = (progress.log[DEVICE] ||= {}), k = isoDay(t), e = (L[k] ||= { n: 0, r: 0, c: 0 });
  if (isNew) e.n++; else e.r++;
  if (correct) e.c++;
  saveLocal(); dirty++;
  if (dirty >= 15) push();
}
function todayLog() {
  const k = isoDay(TODAY()), sum = { n: 0, r: 0, c: 0 };
  for (const dev of Object.values(progress.log)) { const e = dev[k]; if (e) { sum.n += e.n; sum.r += e.r; sum.c += e.c; } }
  return sum;
}
function plan() {
  const act = activeCards(), t = TODAY();
  const unseen = act.filter(c => !st(c.id));
  const due = act.filter(c => st(c.id) && st(c.id)[0] <= t);
  const daysLeft = Math.max(1, dayOf(NEW_UNTIL) - t + 1);
  const autoNew = t > dayOf(NEW_UNTIL) ? 0 : Math.ceil(unseen.length / daysLeft);
  const target = settings.dailyNew > 0 ? settings.dailyNew : autoNew;
  const newLeft = Math.max(0, target - todayLog().n);
  return { act, unseen, due, autoNew, target, newLeft, daysToExam: dayOf(EXAM_DATE) - t };
}

// ---------- sync (GitHub contents API) ----------
function b64encode(str) { const bytes = new TextEncoder().encode(str); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); }
function b64decode(b) { const bin = atob(b.replace(/\n/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }
function merge(a, b) {
  const out = { v: 1, cards: { ...a.cards }, flags: { ...(a.flags || {}), ...(b.flags || {}) }, log: JSON.parse(JSON.stringify(a.log || {})) };
  for (const [id, e] of Object.entries(b.cards || {})) if (!out.cards[id] || out.cards[id][5] < e[5]) out.cards[id] = e;
  for (const [dev, days] of Object.entries(b.log || {})) {
    const D = (out.log[dev] ||= {});
    for (const [k, e] of Object.entries(days)) { const x = D[k]; D[k] = !x ? e : { n: Math.max(x.n, e.n), r: Math.max(x.r, e.r), c: Math.max(x.c, e.c) }; }
  }
  return out;
}
function ghHeaders() { return { Authorization: "Bearer " + settings.token, Accept: "application/vnd.github+json" }; }
const apiUrl = () => `https://api.github.com/repos/${settings.repo}/contents/${settings.path}`;
function setSync(msg) { document.getElementById("sync").textContent = msg; }
async function pull() {
  if (!settings.token) { setSync("Progress saved on this device only. Add a GitHub token in Settings to sync."); return; }
  try {
    const r = await fetch(apiUrl() + "?t=" + Date.now(), { headers: ghHeaders(), cache: "no-store" });
    if (r.status === 404) { remoteSha = null; setSync("No progress file on GitHub yet. It will be created on first sync."); return; }
    if (!r.ok) throw new Error(r.status);
    const j = await r.json(); remoteSha = j.sha;
    progress = merge(progress, JSON.parse(b64decode(j.content)));
    saveLocal(); setSync("Synced " + new Date().toLocaleTimeString());
  } catch (e) { setSync("Sync failed (" + e.message + "). Working offline."); }
}
async function push(retry = true) {
  if (!settings.token || syncing || !dirty) return;
  syncing = true;
  try {
    const body = { message: "update", content: b64encode(JSON.stringify(progress)) };
    if (remoteSha) body.sha = remoteSha;
    const r = await fetch(apiUrl(), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) { syncing = false; await pull(); if (retry) return push(false); return; }
    if (!r.ok) throw new Error(r.status);
    remoteSha = (await r.json()).content.sha; dirty = 0;
    setSync("Synced " + new Date().toLocaleTimeString());
  } catch (e) { setSync("Sync failed (" + e.message + "). Will retry."); }
  syncing = false;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") push(); });

// ---------- rendering helpers ----------
const $view = () => document.getElementById("view");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
const bn = n => String(n).replace(/\d/g, d => "০১২৩৪৫৬৭৮৯"[d]);
function srcLine(c) {
  const tier = `<span class="chip tier${c.tier}">${c.tier === "S" ? "Petro/BCIC/Power" : c.tier === "A" ? "Past exam" : "Book"}</span>`;
  return `<div class="small muted">${tier}${c.section ? esc(c.section) + " · " : ""}${esc(deckTitle(c.deck))} p.${esc(c.printed)}${c.src ? "<br>" + esc(c.src) : ""}</div>`;
}
const deckTitle = id => (decks.find(d => d.id === id) || {}).title || id;

// ---------- views ----------
function home() {
  const p = plan(), lg = todayLog();
  const deckBoxes = decks.map(d => `<label class="row" style="color:var(--ink)"><input type="checkbox" style="width:auto" data-deck="${d.id}" ${settings.decks.includes(d.id) ? "checked" : ""}> ${esc(d.title)} <span class="muted small">(${d.count})</span></label>`).join("");
  $view().innerHTML = `
    <div class="panel">
      <div class="stats">
        <div class="stat"><b>${p.due.length}</b>reviews due</div>
        <div class="stat"><b>${p.newLeft}</b>new left today</div>
        <div class="stat"><b>${lg.n + lg.r}</b>answered today</div>
        <div class="stat"><b>${p.daysToExam}</b>days to Dec 20</div>
      </div>
      <p class="small muted">Daily new-card target: ${p.target} ${settings.dailyNew ? "(manual)" : "(auto: finishes all unseen cards by Nov 30)"} · Unseen: ${p.unseen.length} of ${p.act.length}</p>
      <div class="actions">
        <button class="primary" id="go" ${p.due.length + p.newLeft === 0 ? "disabled" : ""}>Start session</button>
        <button id="extra" ${p.unseen.length === 0 ? "disabled" : ""}>+20 extra new</button>
      </div>
    </div>
    <div class="panel"><b>Decks</b>${deckBoxes || '<p class="muted">No decks yet.</p>'}</div>`;
  $view().querySelectorAll("[data-deck]").forEach(cb => cb.onchange = () => {
    settings.decks = [...$view().querySelectorAll("[data-deck]:checked")].map(x => x.dataset.deck); saveSettings(); home();
  });
  document.getElementById("go").onclick = () => startSession(0);
  document.getElementById("extra").onclick = () => startSession(20);
}

let session = null;
function shuffleOpts(c) {
  const idx = c.options.map((_, i) => i);
  const fixed = c.options.some(o => /সব|কোনটিই|কোনোটিই|উভয়|[কখগঘ]\s*ও\s*[কখগঘ]|উপরের/.test(o));
  if (!fixed) for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx;
}
function startSession(extra) {
  const p = plan();
  const due = p.due.sort((a, b) => st(a.id)[0] - st(b.id)[0] || TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  const fresh = p.unseen.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.deck.localeCompare(b.deck) || a.ord - b.ord)
    .slice(0, extra || p.newLeft);
  const size = extra ? extra : settings.sessionSize;
  const q = [];
  let i = 0, j = 0;
  while (q.length < size && (i < due.length || j < fresh.length)) { // 3 reviews : 1 new
    for (let k = 0; k < 3 && i < due.length && q.length < size; k++) q.push(due[i++]);
    if (j < fresh.length && q.length < size) q.push(fresh[j++]);
  }
  session = { queue: q.map(c => c.id), done: 0, right: 0, total: q.length, missed: new Set() };
  next();
}
function next() {
  if (!session.queue.length) return finish();
  const c = byId[session.queue[0]];
  const pct = Math.round(100 * session.done / Math.max(1, session.done + session.queue.length));
  const head = `<div class="row small muted"><span>${session.done} done · ${session.queue.length} left</span>${st(c.id) ? "" : '<span class="chip">new</span>'}</div><div class="bar"><i style="width:${pct}%"></i></div>`;
  if (c.type === "mcq") {
    const order = shuffleOpts(c);
    $view().innerHTML = `<div class="panel">${head}${srcLine(c)}<div class="q">${md(c.q)}</div>
      <div class="opts">${order.map((oi, k) => `<button class="opt" data-oi="${oi}"><span class="k">${LETTERS[k]}</span>${md(c.options[oi])}</button>`).join("")}</div>
      <div id="after"></div></div><p class="small muted">Keys: <kbd>1</kbd>–<kbd>4</kbd> answer · <kbd>Enter</kbd> next</p>`;
    const btns = [...$view().querySelectorAll(".opt")];
    const choose = oi => {
      if (session.answered) return; session.answered = true;
      const ok = oi === c.ans;
      btns.forEach(b => { const v = +b.dataset.oi; if (v === c.ans) b.classList.add("good"); else if (v === oi) b.classList.add("bad"); b.disabled = true; });
      afterAnswer(c, ok, (c.exp ? `<div class="answer">${md(c.exp)}</div>` : "") + (c.note ? `<div class="answer small">⚠ ${md(c.note)}</div>` : ""));
    };
    btns.forEach(b => b.onclick = () => choose(+b.dataset.oi));
    session.keys = e => { const n = +e.key; if (n >= 1 && n <= btns.length) choose(+btns[n - 1].dataset.oi); };
  } else {
    $view().innerHTML = `<div class="panel">${head}${srcLine(c)}<div class="q">${md(c.q)}</div>
      <div id="after"><div class="actions"><button class="primary" id="reveal">Show answer</button></div></div></div>
      <p class="small muted">Answer in your head first. <kbd>Space</kbd> reveal · <kbd>1</kbd> missed · <kbd>2</kbd> got it</p>`;
    const reveal = () => {
      if (session.revealed) return; session.revealed = true;
      document.getElementById("after").innerHTML = `<div class="answer">${md(c.a)}</div>
        <div class="actions"><button id="miss">Missed it</button><button class="primary" id="got">Got it</button></div>`;
      document.getElementById("miss").onclick = () => selfGrade(false);
      document.getElementById("got").onclick = () => selfGrade(true);
    };
    const selfGrade = ok => { if (session.answered) return; session.answered = true; afterAnswer(c, ok, "", true); };
    document.getElementById("reveal").onclick = reveal;
    session.keys = e => { if (e.key === " " && !session.revealed) { e.preventDefault(); reveal(); } else if (session.revealed && e.key === "1") selfGrade(false); else if (session.revealed && e.key === "2") selfGrade(true); };
  }
  session.answered = false; session.revealed = false;
}
function afterAnswer(c, ok, extraHtml, auto) {
  const first = !session.missed.has(c.id);
  if (first) grade(c.id, ok); // only the first attempt in a session affects the schedule
  session.queue.shift();
  if (!ok) { session.missed.add(c.id); session.queue.splice(Math.min(4, session.queue.length), 0, c.id); }
  else { session.done++; if (first) session.right++; }
  if (ok && !first) { progress.cards[c.id][0] = TODAY() + 1; progress.cards[c.id][1] = 1; saveLocal(); } // relearned → tomorrow
  if (auto) return next();
  document.getElementById("after").innerHTML = `<div class="feedback ${ok ? "good" : "bad"}">${ok ? "Correct" : "Wrong: it will come back in a few cards"}</div>${extraHtml}
    <div class="actions"><button id="flag" class="ghost">Report error</button><button class="primary" id="nx">Next</button></div>`;
  document.getElementById("nx").onclick = next;
  document.getElementById("nx").focus();
  document.getElementById("flag").onclick = () => flag(c);
  session.keys = e => { if (e.key === "Enter") { e.preventDefault(); next(); } };
}
function flag(c) {
  const msg = prompt("What is wrong with this card? (wrong answer, spelling, etc.)");
  if (msg === null) return;
  progress.flags[c.id] = { t: Date.now(), msg }; saveLocal(); dirty++;
  alert("Noted. It will be checked and fixed.");
}
function finish() {
  session.keys = null;
  const acc = session.total ? Math.round(100 * session.right / session.total) : 0;
  $view().innerHTML = `<div class="panel"><h2 style="margin-top:0">Session done</h2>
    <p>${session.total} cards · ${acc}% right on the first try · ${session.missed.size} relearned</p>
    <div class="actions"><button class="primary" id="home">Back home</button></div></div>`;
  document.getElementById("home").onclick = home;
  dirty++; push();
}
document.addEventListener("keydown", e => { if (session && session.keys && !e.ctrlKey && !e.metaKey && e.target.tagName !== "INPUT") session.keys(e); });

function stats() {
  const t = TODAY(), rows = [];
  for (const d of decks) {
    const cs = cards.filter(c => c.deck === d.id);
    for (const tier of ["S", "A", "B"]) {
      const tc = cs.filter(c => c.tier === tier); if (!tc.length) continue;
      const seen = tc.filter(c => st(c.id)), mature = seen.filter(c => st(c.id)[1] >= 7);
      rows.push(`<tr><td>${esc(d.title)}</td><td><span class="chip tier${tier}">${tier}</span></td><td>${tc.length}</td><td>${seen.length}</td><td>${mature.length}</td></tr>`);
    }
  }
  const days = [];
  for (let k = 6; k >= 0; k--) { const key = isoDay(t - k), s = { n: 0, r: 0, c: 0 }; for (const dev of Object.values(progress.log)) { const e = dev[key]; if (e) { s.n += e.n; s.r += e.r; s.c += e.c; } } days.push(`<tr><td>${key.slice(5)}</td><td>${s.n}</td><td>${s.r}</td><td>${s.n + s.r ? Math.round(100 * s.c / (s.n + s.r)) + "%" : "–"}</td></tr>`); }
  const forecast = []; for (let k = 1; k <= 7; k++) forecast.push(activeCards().filter(c => st(c.id) && st(c.id)[0] === t + k).length);
  $view().innerHTML = `
    <div class="panel"><b>Coverage</b><p class="small muted">Mature = you have answered it correctly with a gap of 7+ days.</p>
      <table><tr><th>Deck</th><th>Tier</th><th>Cards</th><th>Seen</th><th>Mature</th></tr>${rows.join("")}</table></div>
    <div class="panel"><b>Last 7 days</b><table><tr><th>Day</th><th>New</th><th>Reviews</th><th>Right</th></tr>${days.join("")}</table></div>
    <div class="panel"><b>Reviews due, next 7 days</b><p>${forecast.join(" · ")}</p></div>`;
}

function settingsView() {
  $view().innerHTML = `<div class="panel">
    <b>GitHub sync</b>
    <p class="small muted">Progress is saved to <code>${esc(settings.path)}</code> in your repo so the PC and phone share it. Create a fine-grained token with access to only this repo and permission <i>Contents: Read and write</i>. The token stays on this device and is never uploaded.</p>
    <label>Repo (owner/name)</label><input id="repo" value="${esc(settings.repo)}">
    <label>Token</label><input id="tok" type="password" value="${esc(settings.token)}" placeholder="github_pat_...">
    <label>New cards per day (0 = automatic)</label><input id="dn" type="number" min="0" value="${settings.dailyNew}">
    <label>Cards per session</label><input id="ss" type="number" min="5" value="${settings.sessionSize}">
    <label>Theme</label><select id="th"><option value="">Match device</option><option value="light" ${settings.theme === "light" ? "selected" : ""}>Light</option><option value="dark" ${settings.theme === "dark" ? "selected" : ""}>Dark</option></select>
    <div class="actions"><button class="primary" id="save">Save and sync</button></div></div>`;
  document.getElementById("save").onclick = async () => {
    settings.repo = document.getElementById("repo").value.trim();
    settings.token = document.getElementById("tok").value.trim();
    settings.dailyNew = Math.max(0, +document.getElementById("dn").value || 0);
    settings.sessionSize = Math.max(5, +document.getElementById("ss").value || 40);
    settings.theme = document.getElementById("th").value;
    document.documentElement.dataset.theme = settings.theme; if (!settings.theme) delete document.documentElement.dataset.theme;
    saveSettings(); await pull(); dirty++; await push(); home();
  };
}

document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => {
  if (session && session.queue.length && !confirm("Leave this session?")) return;
  session = null; push();
  ({ home, stats, settings: settingsView })[b.dataset.go]();
});

(async () => {
  $view().innerHTML = '<p class="muted">Loading cards…</p>';
  try { await loadData(); } catch (e) { $view().innerHTML = `<p>Could not load cards: ${esc(e.message)}</p>`; return; }
  await pull();
  home();
})();
