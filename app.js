// GeoChat Agent HQ page, version 1: inbox, status board, work lanes, ledger
// and agent keys. Reads the ledger as Venus (row-level security decides what
// her login may see) and writes only answers and agent keys. Everything an
// agent wrote is shown as text, never as HTML.
"use strict";

const cfg = window.HQ_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.anonKey, {
  // Implicit flow: the email link works even if the phone opens it in a
  // different browser from the one that asked for it.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATE = {
  working:    { w: "Working", c: "--good" },
  waiting:    { w: "Waiting on another agent", c: "--muted" },
  question:   { w: "Question for you", c: "--warn" },
  permission: { w: "Needs approval in its session", c: "--warn" },
  blocked:    { w: "Blocked", c: "--crit" },
  idle:       { w: "Idle", c: "--line-strong", hollow: true },
  scheduled:  { w: "Scheduled", c: "--line-strong", hollow: true },
  offline:    { w: "Offline", c: "--line-strong", hollow: true },
  proposed:   { w: "Not set up yet", c: "--line-strong", hollow: true },
};
const LANES = [["building", "Building"], ["inqa", "In QA"], ["findings", "Findings"], ["fixing", "Fixing"], ["retest", "Re-test"], ["needs", "Needs you"], ["done", "Done"]];
const URG = { now: ["Blocking now", 0], today: ["Today", 1], week: ["This week", 2] };
const TABLES = ["agents", "guardrails", "sessions", "events", "status_posts", "work_items", "handoffs", "questions", "answers", "locks", "lock_log"];

let D = {};               // the ledger, as last loaded
let replyOpen = {};       // question id -> reply box open
let busy = new Set();     // question ids with an answer being sent
let newKey = null;        // {agent, key} shown once
let channel = null;
let startedFor = null;   // user id the page is running for

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 4200);
}
const agentOf = (id) => (D.agents || []).find((a) => a.id === id);
const nameOf = (id) => id === "venus" ? "You" : id === "issue_log" ? "Issue log" : (agentOf(id)?.name ?? id);
const fullName = (id) => { const a = agentOf(id); return a ? `${a.name} (${a.job})` : nameOf(id); };
const dot = (id) => `<span class="dot" style="--c:var(--a-${esc(id === "venus" ? "you" : id)}, var(--muted))"></span>`;
const pill = (st) => { const m = STATE[st]; return `<span class="pill"${m.hollow ? ' data-hollow="true"' : ""} style="--pc:var(${m.c})"><i></i>${m.w}</span>`; };
const minutes = (n) => n * 60 * 1000;
const guard = (k, d) => { const g = (D.guardrails || []).find((x) => x.key === k); return g ? Number(g.value) : d; };

function when(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const same = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return same ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
function safeLink(s) {
  try {
    const u = new URL(String(s));
    if (u.protocol === "https:" || u.protocol === "http:") {
      return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(u.hostname + u.pathname).slice(0, 60)}</a>`;
    }
  } catch { /* not a URL */ }
  return esc(s);
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

function showSignin(msg, bad) {
  $("#app").hidden = true;
  $("#signin").hidden = false;
  const m = $("#signinMsg");
  m.hidden = !msg;
  m.textContent = msg || "";
  m.dataset.tone = bad ? "bad" : "";
}

$("#signinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email").value.trim();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  btn.disabled = false;
  if (error) showSignin(`Couldn't send the link: ${error.message}`, true);
  else showSignin("Check your email for the sign-in link, and open it on this device.");
});

$("#signOut").addEventListener("click", async () => {
  if (channel) await sb.removeChannel(channel);
  await sb.auth.signOut();
  showSignin("Signed out.");
});

async function start(session) {
  if (!session) return showSignin();
  if (startedFor === session.user.id) return;
  startedFor = session.user.id;
  // Binds the owner row to this login on first sign-in; refuses any other login.
  const { error } = await sb.rpc("hq_claim_owner");
  if (error) {
    startedFor = null;
    await sb.auth.signOut();
    return showSignin(error.message.replace(/^HQ: /, "") + ". Only Venus's login can open HQ.", true);
  }
  $("#signin").hidden = true;
  $("#app").hidden = false;
  await load();
  subscribe();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function load() {
  const q = (t) => {
    let r = sb.from(t).select("*");
    if (t === "events" || t === "status_posts" || t === "lock_log") r = r.order("id", { ascending: false }).limit(400);
    if (t === "answers") r = r.order("created_at", { ascending: false }).limit(200);
    if (t === "handoffs" || t === "questions") r = r.order("created_at", { ascending: false }).limit(300);
    return r;
  };
  const results = await Promise.all(TABLES.map((t) => q(t)));
  const failed = results.find((r) => r.error);
  if (failed) { toast(`Couldn't load HQ: ${failed.error.message}`); return; }
  TABLES.forEach((t, i) => { D[t] = results[i].data || []; });
  render();
}

let reloadTimer = null;
function reloadSoon() { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 400); }

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("hq-page");
  for (const t of ["handoffs", "questions", "answers", "status_posts", "sessions", "events", "locks", "work_items"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table: t }, reloadSoon);
  }
  channel.subscribe((status) => {
    const on = status === "SUBSCRIBED";
    $("#live").dataset.on = String(on);
    $("#liveText").textContent = on ? "Live" : "Reconnecting…";
  });
}
setInterval(() => { if (!$("#app").hidden) load(); }, 60 * 1000);   // time-based states (offline, red handoffs)

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

function openQuestions() {
  const now = Date.now();
  return (D.questions || []).filter((q) => q.status === "open" || (q.status === "snoozed" && new Date(q.snoozed_until) <= now));
}
function snoozedQuestions() {
  const now = Date.now();
  return (D.questions || []).filter((q) => q.status === "snoozed" && new Date(q.snoozed_until) > now);
}

function agentState(a) {
  if (a.status !== "active") return { st: "proposed" };
  const offlineAfter = minutes(guard("offline_after_minutes", 30));
  const live = (D.sessions || []).filter((s) => s.agent_id === a.id && !s.ended_at && Date.now() - new Date(s.last_event_at) < offlineAfter)
    .sort((x, y) => new Date(y.last_event_at) - new Date(x.last_event_at));
  const lastEvent = (D.events || []).find((e) => e.agent_id === a.id);
  const lastStatus = (D.status_posts || []).find((p) => p.agent_id === a.id);
  const openQ = openQuestions().filter((q) => q.from_agent === a.id);
  const machine = live[0]?.machine || null;

  if (!live.length) {
    return { st: a.scheduled ? "scheduled" : "offline", since: lastEvent?.at, machine };
  }
  const ev = live[0].last_event;
  const since = live[0].last_event_at;
  if (ev === "needs_permission") return { st: "permission", since, machine };
  if (ev === "stop_failure" || lastStatus?.state === "blocked") return { st: "blocked", since, machine };
  if (openQ.length) return { st: "question", since: openQ[0].created_at, machine };
  if (ev === "prompt" || ev === "session_start") return { st: "working", since, machine };
  const waiting = (D.handoffs || []).some((h) => h.from_agent === a.id && ["open", "claimed", "waiting_venus"].includes(h.status));
  return { st: waiting ? "waiting" : "idle", since, machine };
}

function nextStep(a) {
  const mine = (D.handoffs || []).filter((h) => h.to_target === a.id && h.status === "open");
  if (mine.length) return `Claim ${mine.map((h) => h.ref).join(", ")}`;
  const claimed = (D.handoffs || []).filter((h) => h.claimed_by === a.id && h.status === "claimed");
  if (claimed.length) return `Finish ${claimed.map((h) => h.ref).join(", ")}`;
  const q = openQuestions().filter((x) => x.from_agent === a.id);
  if (q.length) return `Waits for your answer to ${q.map((x) => x.ref).join(", ")}`;
  return "";
}

function runsOn(a, machine) {
  if (machine) return machine;
  const r = a.config?.runs_on || {};
  const vals = [...new Set(Object.values(r).map(String))];
  return vals.map((v) => v.replace(/-/g, " ")).join(" + ");
}

function laneOf(h) {
  if (h.status === "waiting_venus") return "needs";
  if (["resolved", "logged", "declined"].includes(h.status)) return "done";
  if (h.type === "dataset_ready") return "inqa";
  if (h.type === "fix_ready") return "retest";
  if (h.type === "qa_finding" || h.type === "data_finding") return h.status === "claimed" ? "fixing" : "findings";
  return "building";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderCounts();
  renderInbox();
  renderBoard();
  renderLanes();
  renderLedger();
  renderKeys();
}

function renderCounts() {
  const openQ = openQuestions().length;
  const perms = (D.agents || []).filter((a) => agentState(a).st === "permission").length;
  const inFlight = (D.handoffs || []).filter((h) => ["open", "claimed"].includes(h.status)).length;
  const off = (D.agents || []).filter((a) => a.status === "active" && agentState(a).st === "offline").length;
  const chip = (n, label, warn) => `<span class="count-chip"${warn && n ? ' data-tone="warn"' : ""}><b>${n}</b> ${label}</span>`;
  $("#counts").innerHTML = chip(openQ, openQ === 1 ? "question for you" : "questions for you", true)
    + chip(perms, "waiting in a session", true)
    + chip(inFlight, inFlight === 1 ? "handoff in flight" : "handoffs in flight")
    + chip(off, "offline");
  const n = openQ + perms;
  const badge = $("#inboxCount");
  badge.textContent = n ? `${n} waiting` : "All clear";
  badge.dataset.zero = String(!n);
  const held = (D.locks || []).filter((l) => l.holder && new Date(l.expires_at) > Date.now());
  $("#lockLine").hidden = !held.length;
  $("#lockBadge").textContent = held.map((l) => `${l.name} held by ${nameOf(l.holder)} until ${when(l.expires_at)}`).join(" · ");
}

function qCard(q, snoozed) {
  const c = q.card || {};
  const h = q.handoff_id ? (D.handoffs || []).find((x) => x.id === q.handoff_id) : null;
  const needsDecision = h && h.on_approve;   // Approve or Decline only; a reply alone doesn't route it
  const isBusy = busy.has(q.id);
  const opts = (Array.isArray(c.options) ? c.options : []).map((o, i) => `
    <button class="opt${o.recommended ? " rec" : ""}" type="button" data-act="pick" data-q="${q.id}" data-i="${i}"${isBusy ? " disabled" : ""}>
      <span class="l">${esc(o.label)}</span>${o.recommended ? '<span class="badge">Recommended</span>' : "<span></span>"}
      <span class="then">${esc(o.then)}</span></button>`).join("");
  const links = (Array.isArray(c.links) ? c.links : []).map(safeLink).join(" · ");
  const name = nameOf(q.from_agent);
  return `<article class="qcard${snoozed ? " snoozed" : ""}" aria-labelledby="h-${q.id}">
    <header><span class="who">${dot(q.from_agent)}${esc(fullName(q.from_agent))}</span><span class="urg" data-u="${esc(q.urgency)}">${esc(URG[q.urgency]?.[0] ?? q.urgency)}</span><span class="qid">${esc(q.ref)}</span></header>
    <h3 id="h-${q.id}">${esc(c.title)}</h3>
    ${c.body ? `<p>${esc(c.body)}</p>` : ""}
    ${c.recommendation_why ? `<p class="blocks"><strong>Why ${esc(name)} recommends it:</strong> ${esc(c.recommendation_why)}</p>` : ""}
    <p class="blocks"><strong>Waiting on this:</strong> ${esc(c.blocks)}</p>
    <div class="opts">${opts}</div>
    <div class="card-foot">
      ${needsDecision ? "" : `<button class="linkbtn" type="button" data-act="reply" data-q="${q.id}" aria-expanded="${replyOpen[q.id] ? "true" : "false"}">Reply in words</button>`}
      <button class="linkbtn" type="button" data-act="more" data-q="${q.id}">Ask for more</button>
      <button class="linkbtn" type="button" data-act="snooze" data-q="${q.id}">Snooze 1 hour</button>
      <button class="linkbtn" type="button" data-act="dismiss" data-q="${q.id}">Dismiss</button>
      <span class="ev">Asked ${esc(when(q.created_at))}${links ? ` · ${links}` : ""}</span>
    </div>
    <form class="replybox" data-q="${q.id}"${replyOpen[q.id] ? "" : " hidden"}>
      <label for="r-${q.id}">${replyOpen[q.id] === "more" ? `What else do you need from ${esc(name)}?` : `Your reply to ${esc(name)}`}</label>
      <textarea id="r-${q.id}" maxlength="4000" placeholder="${replyOpen[q.id] === "more" ? "Tell " + esc(name) + " what to find out" : "Tell " + esc(name) + " what to do"}"></textarea>
      <div class="row"><button class="btn" type="submit"${isBusy ? " disabled" : ""}>Send</button></div>
    </form>
  </article>`;
}

function renderInbox() {
  const open = openQuestions().sort((p, q) => (URG[p.urgency]?.[1] ?? 9) - (URG[q.urgency]?.[1] ?? 9) || new Date(p.created_at) - new Date(q.created_at));
  const sn = snoozedQuestions();
  const more = (D.questions || []).filter((q) => q.status === "more_info");
  const perms = (D.agents || []).filter((a) => agentState(a).st === "permission");
  let html = "";
  if (!open.length && !perms.length && !sn.length) html += '<p class="empty">Nothing needs you. When a decision is yours, the agent asks here and waits for your answer.</p>';
  html += open.map((q) => qCard(q, false)).join("");
  html += perms.map((a) => `<article class="pcard">
      <header><span class="who">${dot(a.id)}${esc(fullName(a.id))}</span><span class="urg" data-u="today">In its session</span></header>
      <h3>${esc(a.name)} is waiting for your approval in its Claude Code session</h3>
      <p class="blocks">You approve this inside ${esc(a.name)}'s session (on your phone: the Claude app, Remote Control). HQ can't approve it for you.</p>
    </article>`).join("");
  if (sn.length) html += '<p class="group-label">Snoozed</p>' + sn.map((q) => qCard(q, true)).join("");
  if (more.length) html += '<p class="group-label">Waiting for more from the agent</p><ul class="answered-list">'
    + more.map((q) => `<li>${esc(nameOf(q.from_agent))} · <span class="mono">${esc(q.ref)}</span>: ${esc(q.card?.title)}</li>`).join("") + "</ul>";
  const recent = (D.answers || []).slice(0, 8);
  if (recent.length) {
    html += '<p class="group-label">Answered</p><ul class="answered-list">' + recent.map((a) => {
      const q = (D.questions || []).find((x) => x.id === a.question_id);
      const label = a.action === "pick" ? a.option_label : a.action === "reply" ? `Reply: “${a.reply}”` : a.action.replace("_", " ");
      return `<li><span class="mono">${esc(when(a.created_at))}</span> · ${esc(nameOf(q?.from_agent))} · <span class="mono">${esc(q?.ref)}</span>: <b>${esc(label)}</b></li>`;
    }).join("") + "</ul>";
  }
  const el = $("#inbox");
  const keep = {};
  el.querySelectorAll("textarea").forEach((ta) => { keep[ta.id] = ta.value; });
  el.innerHTML = html;
  Object.keys(keep).forEach((id) => { const ta = document.getElementById(id); if (ta) ta.value = keep[id]; });
}

function renderBoard() {
  $("#board").innerHTML = (D.agents || []).filter((a) => a.status !== "retired").map((a) => {
    const s = agentState(a);
    const task = (D.status_posts || []).find((p) => p.agent_id === a.id)?.text ?? "";
    return `<tr>
      <td class="agent">${dot(a.id)} ${esc(fullName(a.id))}</td>
      <td>${pill(s.st)}</td>
      <td>${esc(task)}</td>
      <td class="mono">${esc(when(s.since))}</td>
      <td class="muted">${esc(nextStep(a))}</td>
      <td>${esc(runsOn(a, s.machine))}</td></tr>`;
  }).join("");
}

function renderLanes() {
  const lanes = Object.fromEntries(LANES.map(([k]) => [k, []]));
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const unclaimedAfter = guard("unclaimed_after_hours", 4) * 3600 * 1000;
  for (const h of D.handoffs || []) {
    const lane = laneOf(h);
    if (lane === "done" && new Date(h.resolved_at || h.created_at) < weekAgo) continue;
    const red = h.status === "open" && Date.now() - new Date(h.created_at) > unclaimedAfter;
    lanes[lane].push({ id: h.ref, t: h.packet?.summary ?? h.type, a: h.status === "claimed" ? h.claimed_by : h.from_agent, red,
      meta: `${h.type} → ${nameOf(h.to_target)}${red ? " · unclaimed" : ""}` });
  }
  for (const w of D.work_items || []) {
    const k = (LANES.find(([, label]) => label.toLowerCase() === String(w.lane).toLowerCase()) || ["building"])[0];
    lanes[k].push({ id: w.ref, t: w.title, a: w.agent_id, meta: "work item" });
  }
  $("#lanes").innerHTML = LANES.map(([k, label]) => {
    const list = lanes[k];
    return `<section class="lane" data-lane="${k}" aria-label="${label}"><h3><span>${label}</span><span class="mono">${list.length}</span></h3>${
      list.length ? list.map((c) => `<div class="wcard"${c.red ? ' data-red="true"' : ""}><span class="mono">${esc(c.id)}</span><span>${esc(c.t)}</span><span class="meta">${dot(c.a)}${esc(nameOf(c.a))} · ${esc(c.meta)}</span></div>`).join("")
        : '<p class="none">Nothing here</p>'}</section>`;
  }).join("");
}

function renderLedger() {
  const rows = [];
  const add = (at, who, html) => rows.push({ at, who, html });
  for (const h of D.handoffs || []) {
    add(h.created_at, h.from_agent, `Filed <span class="mono">${esc(h.ref)}</span> ${esc(h.type)} → ${esc(nameOf(h.to_target))}: ${esc(h.packet?.summary)}`);
    if (h.claimed_at) add(h.claimed_at, h.claimed_by, `Claimed <span class="mono">${esc(h.ref)}</span>`);
    if (h.resolved_at && h.status !== "logged") add(h.resolved_at, h.claimed_by || "venus", `${esc(h.status === "declined" ? "Declined" : "Resolved")} <span class="mono">${esc(h.ref)}</span>${h.resolution ? ` as ${esc(h.resolution)}` : ""}${h.resolution_note ? `: ${esc(h.resolution_note)}` : ""}`);
  }
  for (const q of D.questions || []) add(q.created_at, q.from_agent, `Asked you <span class="mono">${esc(q.ref)}</span>: ${esc(q.card?.title)}`);
  for (const a of D.answers || []) {
    const q = (D.questions || []).find((x) => x.id === a.question_id);
    add(a.created_at, "venus", `Answered <span class="mono">${esc(q?.ref)}</span>: ${esc(a.option_label || a.reply || a.action)}`);
  }
  for (const p of D.status_posts || []) add(p.at, p.agent_id, esc(p.text));
  for (const l of D.lock_log || []) add(l.at, l.agent_id, `${esc(l.action)} ${esc(l.name)}: ${esc(l.outcome)}${l.detail ? ` (${esc(l.detail)})` : ""}`);
  for (const e of D.events || []) {
    if (["session_start", "session_end", "stop_failure", "needs_permission"].includes(e.event)) {
      const words = { session_start: "Started a session", session_end: "Ended its session", stop_failure: "Stopped with an error", needs_permission: "Needs approval in its session" }[e.event];
      add(e.at, e.agent_id, esc(words));
    }
  }
  rows.sort((x, y) => new Date(y.at) - new Date(x.at));
  $("#ledger").innerHTML = rows.length ? rows.slice(0, 150).map((r) =>
    `<li><span class="mono">${esc(when(r.at))}</span><span class="lw">${dot(r.who)}${esc(nameOf(r.who))}</span><span class="what">${r.html}</span></li>`).join("")
    : '<li><span></span><span></span><span class="muted">Nothing recorded yet.</span></li>';
}

function renderKeys() {
  const agents = (D.agents || []).filter((a) => a.status === "active");
  let html = `<p class="muted" style="margin:0">Each agent needs its own key in its folder's <code>.env</code> as <code>HQ_AGENT_KEY=…</code>. A new key is shown once; copy it straight into that file. Never paste it into a chat.</p>`;
  if (newKey) {
    html += `<div class="newkey" role="alert"><b>New key for ${esc(fullName(newKey.agent))}. It won't be shown again.</b>
      <code id="newKeyText">${esc(newKey.key)}</code>
      <span class="row"><button class="btn" type="button" data-act="copykey">Copy</button> <button class="btn" type="button" data-act="hidekey">I've saved it</button></span>
      <span class="muted">Open the agent's folder, copy <code>.env.example</code> to <code>.env</code> if it isn't there, and paste after <code>HQ_AGENT_KEY=</code>. Then restart the agent.</span></div>`;
  }
  html += agents.map((a) => `<div class="keyrow"><span class="name">${dot(a.id)}${esc(fullName(a.id))}</span>
      <button class="btn" type="button" data-act="newkey" data-agent="${esc(a.id)}">Create a new key</button>
      <button class="btn danger" type="button" data-act="revoke" data-agent="${esc(a.id)}">Turn off all its keys</button></div>`).join("");
  $("#keys").innerHTML = html;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function answer(q, row, doneMsg) {
  busy.add(q.id);
  renderInbox();
  const { error } = await sb.from("answers").insert({ question_id: q.id, ...row });
  busy.delete(q.id);
  if (error) {
    toast(error.message.replace(/^HQ: /, ""));
    renderInbox();
    return false;
  }
  replyOpen[q.id] = false;
  toast(doneMsg);
  await load();
  return true;
}

$("#inbox").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const q = (D.questions || []).find((x) => x.id === b.dataset.q);
  if (!q || busy.has(q.id)) return;
  const name = nameOf(q.from_agent);
  const act = b.dataset.act;
  if (act === "pick") {
    const o = q.card?.options?.[Number(b.dataset.i)];
    if (!o) return;
    if (/^reply/i.test(o.label)) { replyOpen[q.id] = "reply"; renderInbox(); document.getElementById("r-" + q.id)?.focus(); return; }
    answer(q, { action: "pick", option_label: o.label }, `Answer sent to ${name}.`);
  } else if (act === "reply" || act === "more") {
    replyOpen[q.id] = replyOpen[q.id] === act ? false : act;
    renderInbox();
    if (replyOpen[q.id]) document.getElementById("r-" + q.id)?.focus();
  } else if (act === "snooze") {
    answer(q, { action: "snooze", snooze_hours: 1 }, `Snoozed for an hour. ${name} keeps waiting.`);
  } else if (act === "dismiss") {
    if (confirm(`Dismiss ${q.ref}? ${name} is told it's closed with no action.`)) answer(q, { action: "dismiss" }, `Dismissed. ${name} is told.`);
  }
});

$("#inbox").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target.closest("form.replybox");
  const q = (D.questions || []).find((x) => x.id === form?.dataset.q);
  if (!q) return;
  const text = form.querySelector("textarea").value.trim();
  if (!text) { toast("Write something first."); return; }
  const kind = replyOpen[q.id] === "more" ? "more_info" : "reply";
  answer(q, { action: kind, reply: text }, kind === "more_info" ? `Asked ${nameOf(q.from_agent)} for more.` : `Reply sent to ${nameOf(q.from_agent)}.`);
});

$("#keys").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "newkey") {
    const id = b.dataset.agent;
    if (!confirm(`Create a new HQ key for ${fullName(id)}? Its old keys keep working until you turn them off.`)) return;
    const { data, error } = await sb.rpc("hq_admin_new_key", { p_agent: id, p_label: `made on the HQ page ${new Date().toISOString().slice(0, 10)}` });
    if (error) return toast(error.message);
    newKey = { agent: id, key: data };
    renderKeys();
  } else if (act === "revoke") {
    const id = b.dataset.agent;
    if (!confirm(`Turn off every HQ key for ${fullName(id)}? It loses HQ until you give it a new key.`)) return;
    const { data, error } = await sb.rpc("hq_admin_revoke_keys", { p_agent: id });
    toast(error ? error.message : `${data} key(s) turned off for ${nameOf(id)}.`);
  } else if (act === "copykey") {
    try { await navigator.clipboard.writeText(newKey.key); toast("Copied. Paste it into the agent's .env."); }
    catch { toast("Couldn't copy; select the key and copy it by hand."); }
  } else if (act === "hidekey") {
    newKey = null;
    renderKeys();
  }
});

// Tabs
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(t) {
  tabs.forEach((x) => {
    const on = x === t;
    x.setAttribute("aria-selected", String(on));
    x.tabIndex = on ? 0 : -1;
    document.getElementById(x.getAttribute("aria-controls")).hidden = !on;
  });
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; selectTab(n); n.focus(); }
  });
});

// ---------------------------------------------------------------------------

sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
    if (session && history.replaceState && /[?&#](code|access_token|error)=/.test(location.href)) {
      history.replaceState(null, "", location.pathname);   // drop the sign-in code from the address bar
    }
    setTimeout(() => start(session), 0);
  } else if (event === "SIGNED_OUT") {
    startedFor = null;
    showSignin();
  }
});
