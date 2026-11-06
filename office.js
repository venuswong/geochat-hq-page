// GeoChat Agent HQ: the office (phase 2). A picture of the ledger, never the
// record: every state shown here also shows as colour and words in the chips
// and on the status board. Drawn in code from docs/mockup/agent-hq.html (the
// same original pixel dwarfs); driven by app.js's data (D) and agentState().
//
// Until Gate 1 passes it only appears with ?office=1 in the address.
"use strict";

(() => {
  const OFFICE_DEFAULT = false;   // flip to true when Gate 1 passes
  const q = new URLSearchParams(location.search).get("office");
  const enabled = q === "1" || (q !== "0" && OFFICE_DEFAULT);
  if (!enabled) return;

  // Original looks per agent (the hat is the role colour from the registry).
  const LOOK = {
    data:           { skin: "#E3B48A", hair: "#ECE7DC", tunic: "#8A6A43" },
    qa:             { skin: "#8A573A", hair: "#B9B4AA", tunic: "#4F6B8A" },
    web:            { skin: "#F0CBA6", hair: "#C0703A", tunic: "#6E7F3A" },
    opportunities:  { skin: "#C4875A", hair: "#5A3A22", tunic: "#6E4A73" },
    "hq-assistant": { skin: "#A56B48", hair: "#8A6A52", tunic: "#8C5A3A" },
    ux:             { skin: "#EBC29C", hair: "#2E2A3A", tunic: "#3F6F6A" },
    company:        { skin: "#D6A27A", hair: "#2A1E18", tunic: "#7A4E36" },
  };
  const DEFAULT_LOOK = { skin: "#D9A57E", hair: "#5A3A22", tunic: "#5A5F8C" };
  const VENUS = { id: "venus", name: "You", color: "--a-you", skin: "#D9A57E", hair: "#1C1410", tunic: "#5A5F8C", beard: false, glasses: true, state: "working" };
  const WORDS = {
    working: "Working", waiting: "Waiting on another agent", question: "Question for you",
    permission: "Needs approval in its session", blocked: "Blocked", idle: "Idle",
    scheduled: "Scheduled", offline: "Offline", handoff: "Handing off",
  };
  // Chip state: icon, colour token, hollow (the same colours as the status board).
  const STATE_LOOK = {
    working: ["⌨", "--good", false], waiting: ["⏳", "--muted", false], question: ["?", "--warn", false],
    permission: ["✋", "--warn", false], blocked: ["!", "--crit", false], idle: ["z", "--line-strong", true],
    scheduled: ["◷", "--line-strong", true], offline: ["–", "--line-strong", true], handoff: ["📁", "--good", false],
  };
  const WHERE = {
    working: "at the desk, typing", waiting: "at the desk, waiting", question: "at your door",
    permission: "at the desk with a hand raised", blocked: "at the desk", idle: "in the break room",
    scheduled: "away until the next scheduled run", offline: "away; the desk is empty", handoff: "at the handoff counter",
  };

  // ---------------------------------------------------------------- page
  const panel = document.getElementById("officePanel");
  panel.hidden = false;
  document.querySelector(".layout").classList.add("with-office");
  const cv = document.getElementById("office");
  const ctx = cv.getContext("2d");
  const motion = document.getElementById("motionToggle");
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  try { motion.checked = localStorage.getItem("hq-reduce-motion") === null ? mq.matches : localStorage.getItem("hq-reduce-motion") === "1"; }
  catch { motion.checked = mq.matches; }
  motion.addEventListener("change", () => {
    try { localStorage.setItem("hq-reduce-motion", motion.checked ? "1" : "0"); } catch { /* private mode */ }
    if (reduce()) finishWalks();
  });
  const reduce = () => motion.checked;
  mq.addEventListener?.("change", () => {
    let chosen = null; try { chosen = localStorage.getItem("hq-reduce-motion"); } catch { /* private mode */ }
    if (chosen === null) { motion.checked = mq.matches; if (reduce()) finishWalks(); kick(); }
  });

  // ---------------------------------------------------------------- floor plan (logical 640 x 360)
  const W = 640, H = 360, CORR = 210, SPEED = 95, DESK_W = 86;
  const SLOTS = [[0, 0], [0, 1], [1, 0], [1, 1], [0, 2], [1, 2], [0, 3], [1, 3]];   // four desks a row fit left of the office wall (x 470)
  const deskOf = (i) => { const [r, c] = SLOTS[i] || SLOTS[SLOTS.length - 1]; return { x: 20 + c * 112, y: r ? 284 : 64 }; };
  const BREAK = [{ x: 500, y: 318 }, { x: 546, y: 318 }, { x: 592, y: 318 }, { x: 598, y: 262 }, { x: 526, y: 334 }];
  const VENUS_FEET = { x: 555, y: 84 };
  function locPoint(loc) {
    switch (loc.kind) {
      case "desk": { const d = deskOf(loc.i); return { x: d.x + 43, y: d.y + 8 }; }
      case "counter": return { x: 204 + (loc.slot % 3) * 24, y: 198 };
      case "door": return { x: 452 - Math.min(loc.slot, 5) * 30, y: 126 };
      case "break": return BREAK[loc.slot % BREAK.length];
      default: return { x: 624, y: 198 };
    }
  }
  function exitPath(loc) {
    const p = locPoint(loc);
    switch (loc.kind) {
      case "desk": { const d = deskOf(loc.i); return [p, { x: d.x - 14, y: p.y }, { x: d.x - 14, y: CORR }]; }
      case "counter": case "door": return [p, { x: p.x, y: CORR }];
      case "break": return [p, { x: p.x, y: 282 }, { x: 440, y: 282 }, { x: 440, y: CORR }];
      default: return [p, { x: 600, y: CORR }];
    }
  }
  const sameLoc = (a, b) => a && b && a.kind === b.kind && a.i === b.i && a.slot === b.slot;

  // ---------------------------------------------------------------- model
  let data = {};               // app.js's ledger (D), handed over on every render
  const ORDER = ["data", "qa", "web", "opportunities", "ux", "company", "hq-assistant"];   // desk order (config/agents.yaml)
  let people = [];             // one per active agent, in registry order
  let seenHandoffs = null;     // handoff ids already known (null until first load)
  let selected = null;

  function sync() {
    const rank = (id) => { const k = ORDER.indexOf(id); return k < 0 ? 99 : k; };
    const agents = (data.agents || []).filter((a) => a.status === "active").sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    const byId = Object.fromEntries(people.map((p) => [p.id, p]));
    people = agents.map((a, i) => {
      const p = byId[a.id] || { id: a.id, x: 0, y: 0, path: [], moving: false, loc: null };
      const s = window.agentState(a);
      Object.assign(p, LOOK[a.id] || DEFAULT_LOOK, {
        name: a.name, job: a.job, i, color: `--a-${a.id}`, beard: a.look?.beard ?? false,
        state: s.st === "quiet" ? "idle" : s.st === "background" ? "working" : s.st, quiet: s.st === "quiet", helpers: s.helpers || 0, since: s.since,
        task: (data.status_posts || []).find((x) => x.agent_id === a.id)?.text || "",
      });
      p.hidden = p.state === "offline" || p.state === "scheduled";
      return p;
    });

    // New handoffs: the sender walks a folder to the counter (scripted, then back).
    const handoffs = data.handoffs || [];
    if (seenHandoffs) {
      for (const h of handoffs) {
        if (seenHandoffs.has(h.id)) continue;
        const p = people.find((x) => x.id === h.from_agent);
        if (p && !p.hidden && !p.scripted && Date.now() - new Date(h.created_at) < 10 * 60 * 1000) walkHandoff(p, h);
      }
    }
    seenHandoffs = new Set(handoffs.map((h) => h.id));
    place(seenHandoffs.size && !people.some((p) => p.loc));   // first sync: put everyone in place
    describe();
  }

  function place(teleport) {
    const open = (data.questions || []).filter((x) => x.status === "open").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const rank = (p) => { const k = open.findIndex((x) => x.from_agent === p.id); return k < 0 ? 99 : k; };
    const door = people.filter((p) => p.state === "question" && !p.scripted).sort((a, b) => rank(a) - rank(b));
    const idle = people.filter((p) => p.state === "idle" && !p.scripted);
    for (const p of people) {
      if (p.scripted) continue;
      const loc = p.state === "question" ? { kind: "door", slot: door.indexOf(p) }
        : p.state === "idle" ? { kind: "break", slot: idle.indexOf(p) }
        : p.hidden ? { kind: "away" }
        : { kind: "desk", i: p.i };
      if (teleport || !p.loc || reduce()) { p.loc = loc; const pt = locPoint(loc); p.x = pt.x; p.y = pt.y; p.path = []; p.moving = false; }
      else if (!sameLoc(p.loc, loc)) goTo(p, loc);
    }
  }

  function goTo(p, loc) {
    return new Promise((res) => {
      if (p.onArrive) { const f = p.onArrive; p.onArrive = null; f(); }
      const from = p.loc; p.loc = loc;
      const target = locPoint(loc);
      let path;
      if (!from || reduce()) path = [];
      else if (from.kind === loc.kind && loc.kind !== "desk") path = [target];
      else path = exitPath(from).slice(1).concat(exitPath(loc).reverse());
      if (!path.length) { p.x = target.x; p.y = target.y; p.path = []; p.moving = false; res(); return; }
      p.path = path; p.moving = true; p.onArrive = res;
      kick();
    });
  }

  async function walkHandoff(p, h) {
    if (reduce()) return;   // the folder simply appears on the counter
    p.scripted = true;
    p.carry = h.type === "qa_finding" ? "finding" : "folder";
    p.state = "handoff";
    await goTo(p, { kind: "counter", slot: (people.indexOf(p) + 1) % 3 });
    p.carry = null;
    await new Promise((r) => setTimeout(r, 900));
    p.scripted = false;
    const a = (data.agents || []).find((x) => x.id === p.id);
    if (a) { const r = window.agentState(a); p.quiet = r.st === "quiet"; p.helpers = r.helpers || 0; p.state = p.quiet ? "idle" : r.st === "background" ? "working" : r.st; }
    place(false);
    describe();
  }

  function update(dt) {
    for (const p of people) {
      if (!p.moving) continue;
      let step = SPEED * dt;
      while (step > 0 && p.path.length) {
        const t = p.path[0], dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy);
        if (d <= step) { p.x = t.x; p.y = t.y; step -= d; p.path.shift(); }
        else { p.x += (dx / d) * step; p.y += (dy / d) * step; step = 0; }
      }
      if (!p.path.length) { p.moving = false; const f = p.onArrive; p.onArrive = null; if (f) f(); }
    }
  }
  function finishWalks() {
    for (const p of people) {
      if (!p.moving) continue;
      const pt = locPoint(p.loc); p.x = pt.x; p.y = pt.y; p.path = []; p.moving = false;
      const f = p.onArrive; p.onArrive = null; if (f) f();
    }
  }

  // ---------------------------------------------------------------- theme tokens
  let T = {};
  const TOKS = ["--floor", "--floor-grid", "--wall", "--room", "--desk", "--desk-edge", "--monitor", "--counter", "--counter-edge",
    "--couch", "--chair", "--plant", "--legs", "--shadow", "--lamp-off", "--folder", "--gold", "--apple", "--apple-hi", "--leaf",
    "--ink", "--muted", "--surface", "--surface-2", "--line-strong", "--accent", "--accent-soft", "--good", "--warn", "--crit",
    "--a-data", "--a-qa", "--a-web", "--a-opportunities", "--a-hq-assistant", "--a-ux", "--a-company", "--a-you"];
  function readTokens() { const cs = getComputedStyle(document.documentElement); TOKS.forEach((k) => { T[k] = cs.getPropertyValue(k).trim(); }); }
  readTokens();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", readTokens);

  // ---------------------------------------------------------------- drawing
  let s = 1, dpr = 1, lastW = 0;
  function resize() {
    const w = Math.max(cv.parentElement.clientWidth, 560);
    if (w === lastW && (window.devicePixelRatio || 1) === dpr) return;
    lastW = w; dpr = window.devicePixelRatio || 1;
    cv.style.width = w + "px"; cv.style.height = (w * H / W) + "px";
    cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round((w * H / W) * dpr));
    s = cv.width / W;
  }
  new ResizeObserver(() => { resize(); kick(); }).observe(cv.parentElement);
  window.addEventListener("resize", () => { resize(); kick(); });
  resize();

  function R(x, y, w, h, c) {
    ctx.fillStyle = c;
    const X = Math.round(x * s), Y = Math.round(y * s);
    ctx.fillRect(X, Y, Math.max(1, Math.round((x + w) * s) - X), Math.max(1, Math.round((y + h) * s) - Y));
  }
  function font(size, weight) {
    ctx.font = `${weight || 400} ${Math.round(Math.max(size * s, 9 * dpr))}px "Pixelify Sans", ui-monospace, monospace`;
  }
  function TXT(str, x, y, c, size, align, weight, halo) {
    font(size || 7, weight); ctx.textAlign = align || "left"; ctx.textBaseline = "alphabetic";
    const X = Math.round(x * s), Y = Math.round(y * s);
    if (halo) { ctx.lineJoin = "round"; ctx.lineWidth = Math.max(2, 2.6 * dpr); ctx.strokeStyle = T["--surface"]; ctx.strokeText(str, X, Y); }
    ctx.fillStyle = c; ctx.fillText(str, X, Y);
    return ctx.measureText(str).width / s;
  }

  // Characters: storybook dwarfs, 10 x 22 sprite pixels; the pointed hat is the
  // role colour. Venus is the only one in glasses.
  function sprite(a, X, Y, P, t, live) {
    const px = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(X + x * P, Y + y * P, w * P, h * P); };
    const hat = T[a.color] || T["--muted"], tunic = a.tunic || T["--legs"];
    const walking = live && a.moving && !reduce();
    const ph = walking ? Math.floor(t / 150) % 2 : -1;
    const typing = live && !reduce() && a.state === "working" && a.loc?.kind === "desk" && !a.moving;
    const bob = typing ? Math.floor(t / 190) % 2 : 0;
    const boot = "#4A2F1E", belt = "#3B2616";
    px(1, 21, 8, 1, T["--shadow"]);
    const lL = ph === 0 ? 1 : 0, rL = ph === 1 ? 1 : 0;
    px(2, 16, 2, 4 - lL, T["--legs"]); px(6, 16, 2, 4 - rL, T["--legs"]);
    px(1, 20 - lL, 3, 1, boot); px(6, 20 - rL, 3, 1, boot);
    px(1, 9, 8, 7, tunic);
    px(1, 14, 8, 1, belt); px(4, 14, 2, 1, T["--gold"]);
    px(0, 10 + bob, 1, 4, tunic); px(0, 14 + bob, 1, 1, a.skin);
    if (a.state === "permission" && live) { px(9, 4, 1, 6, tunic); px(9, 3, 1, 1, a.skin); }
    else { const rb = typing ? 1 - bob : 0; px(9, 10 + rb, 1, 4, tunic); px(9, 14 + rb, 1, 1, a.skin); }
    px(2, 6, 6, 3, a.skin);
    px(3, 7, 1, 1, "#1B1F23"); px(6, 7, 1, 1, "#1B1F23");
    px(4, 8, 2, 1, "#D98572");
    if (a.beard) { px(2, 9, 6, 3, a.hair); px(3, 12, 4, 1, a.hair); px(4, 13, 2, 1, a.hair); }
    else { px(1, 6, 1, 5, a.hair); px(8, 6, 1, 5, a.hair); px(1, 11, 1, 1, T["--gold"]); px(8, 11, 1, 1, T["--gold"]); }
    if (a.glasses) {
      const lens = "#DCEBF5", rim = "#3B4656";
      px(2, 7, 3, 1, lens); px(5, 7, 3, 1, lens); px(3, 7, 1, 1, "#1B1F23"); px(6, 7, 1, 1, "#1B1F23");
      px(4, 7, 2, 1, rim); px(1, 7, 1, 1, rim); px(8, 7, 1, 1, rim);
    }
    px(1, 5, 8, 1, hat); px(2, 4, 6, 1, hat); px(3, 3, 5, 1, hat); px(4, 2, 4, 1, hat); px(5, 1, 3, 1, hat); px(8, 1, 1, 1, hat); px(7, 0, 2, 1, hat);
    if (live && a.carry) { const fc = a.carry === "finding" ? T["--crit"] : T["--folder"]; px(7, 10, 4, 4, fc); px(7, 9, 2, 1, fc); }
  }
  function drawPerson(p, t) {
    const P = Math.max(2, Math.round(s * 1.7));
    const X = Math.round(p.x * s) - 5 * P, Y = Math.round(p.y * s) - 22 * P;
    if (selected === p.id) {
      ctx.strokeStyle = T["--accent"]; ctx.lineWidth = Math.max(2, s * 1.2);
      ctx.beginPath(); ctx.ellipse(Math.round(p.x * s), Math.round((p.y + 1) * s), 11 * s, 4 * s, 0, 0, Math.PI * 2); ctx.stroke();
    }
    sprite(p, X, Y, P, t, true);
  }
  function bubbleBox(cx, by, bg, edge) {
    R(cx - 7, by - 12, 14, 12, bg); R(cx - 1.5, by, 3, 2.5, bg);
    if (edge) { R(cx - 7, by - 12, 14, 0.8, edge); R(cx - 7, by - 0.8, 14, 0.8, edge); R(cx - 7, by - 12, 0.8, 12, edge); R(cx + 6.2, by - 12, 0.8, 12, edge); }
  }
  function drawSign(p) {
    const atDesk = p.loc?.kind === "desk" && !p.moving;
    if (!atDesk) TXT(p.name, p.x, p.y - 39, (T[p.color] || T["--muted"]), 6.5, "center", 600, true);
    const by = atDesk ? p.y - 43 : p.y - 51, cx = p.x, k = p.state;
    if (k === "idle") { TXT("z", cx + 11, p.y - 22, T["--muted"], 7, "left", 600, true); TXT("z", cx + 15, p.y - 28, T["--muted"], 6, "left", 600, true); return; }
    if (k === "question") { bubbleBox(cx, by, T["--warn"]); TXT("?", cx, by - 2.5, T["--surface"], 10, "center", 600); }
    else if (k === "blocked") { bubbleBox(cx, by, T["--crit"]); TXT("!", cx, by - 2.5, T["--surface"], 10, "center", 600); }
    else if (k === "permission") {
      bubbleBox(cx, by, T["--warn"]); const c = T["--surface"];
      R(cx - 3, by - 6, 6, 4, c); R(cx - 3, by - 9, 1, 3, c); R(cx - 1.5, by - 10, 1, 4, c); R(cx, by - 10, 1, 4, c); R(cx + 1.5, by - 9, 1, 3, c); R(cx + 3, by - 6, 1.2, 1.5, c);
    } else if (k === "waiting") {
      bubbleBox(cx, by, T["--surface"], T["--line-strong"]); const c = T["--muted"];
      R(cx - 3, by - 10, 6, 1, c); R(cx - 2, by - 9, 4, 1, c); R(cx - 1, by - 8, 2, 2, c); R(cx - 2, by - 6, 4, 1, c); R(cx - 3, by - 5, 6, 1, c); R(cx - 3, by - 3, 6, 1, c);
    }
  }
  function drawDesk(p) {
    const d = deskOf(p.i), off = p.hidden;
    const lamp = off || p.state === "idle" ? T["--lamp-off"]
      : (p.state === "question" || p.state === "permission") ? T["--warn"]
      : p.state === "blocked" ? T["--crit"] : T["--good"];
    R(d.x, d.y, DESK_W, 20, T["--desk"]); R(d.x, d.y + 20, DESK_W, 4, T["--desk-edge"]);
    R(d.x + 8, d.y - 7, 7, 5, lamp); R(d.x + 11, d.y - 2, 1.5, 3, T["--monitor"]); R(d.x + 8, d.y + 1, 7, 1.5, T["--monitor"]);
    R(d.x + 58, d.y - 15, 22, 14, T["--monitor"]); if (!off) R(d.x + 58, d.y - 15, 22, 1.6, (T[p.color] || T["--muted"]));
    R(d.x + 67, d.y - 1, 4, 3, T["--monitor"]);
    R(d.x + 24, d.y + 7, 14, 8, T["--surface-2"]);
    font(7, 600);
    const tw = ctx.measureText(p.name).width / s, sx = d.x + 43 - (tw + 9) / 2;
    R(sx, d.y + 30, 6, 6, (T[p.color] || T["--muted"]));
    TXT(p.name, sx + 9, d.y + 36, T["--ink"], 7, "left", 600);
    if (off) TXT(p.state === "scheduled" ? "Scheduled" : "Offline", d.x + 43, d.y - 20, T["--muted"], 6, "center", 600, true);
  }
  function drawChair(p) { const d = deskOf(p.i); R(d.x + 35, d.y - 10, 16, 12, T["--chair"]); R(d.x + 35, d.y - 12, 16, 2, T["--counter-edge"]); }

  function drawScene(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    R(0, 0, W, H, T["--floor"]);
    ctx.fillStyle = T["--floor-grid"];
    const gw = Math.max(1, Math.round(s * 0.6));
    for (let gx = 20; gx < W; gx += 20) ctx.fillRect(Math.round(gx * s), 0, gw, cv.height);
    for (let gy = 20; gy < H; gy += 20) ctx.fillRect(0, Math.round(gy * s), cv.width, gw);
    R(474, 12, 154, 164, T["--room"]); R(474, 230, 154, 118, T["--room"]);
    const wl = T["--wall"];
    R(8, 8, 624, 4, wl); R(8, 348, 624, 4, wl); R(8, 8, 4, 344, wl); R(628, 8, 4, 176, wl); R(628, 214, 4, 138, wl);
    R(470, 8, 4, 96, wl); R(470, 148, 4, 30, wl); R(470, 176, 162, 4, wl);
    R(470, 226, 162, 4, wl); R(470, 226, 4, 36, wl); R(470, 302, 4, 50, wl);
    ctx.strokeStyle = T["--muted"]; ctx.lineWidth = Math.max(1, s * 0.7); ctx.setLineDash([3 * s, 3 * s]);
    ctx.beginPath(); ctx.arc(474 * s, 104 * s, 44 * s, 0, Math.PI / 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(474 * s, 262 * s, 40 * s, 0, Math.PI / 2); ctx.stroke();
    ctx.setLineDash([]);
    R(474, 103, 44, 1.5, T["--muted"]); R(474, 261, 40, 1.5, T["--muted"]);
    TXT("VENUS'S OFFICE", 551, 132, T["--muted"], 6, "center", 600);
    TXT("BREAK ROOM", 551, 246, T["--muted"], 6, "center", 600);
    TXT("HANDOFF COUNTER", 227, 157, T["--muted"], 6, "center", 600);
    TXT("ENTRY", 622, 196, T["--muted"], 5.5, "right", 600);
    R(600, 22, 14, 14, T["--plant"]); R(603, 36, 8, 6, T["--desk-edge"]);
    R(544, 66, 22, 12, T["--chair"]);
    R(496, 298, 104, 10, T["--couch"]); R(604, 238, 16, 20, T["--monitor"]); R(607, 242, 10, 3, T["--folder"]);
    R(510, 252, 40, 14, T["--desk"]);
    const apple = (x, y) => { R(x, y + 1, 5, 4, T["--apple"]); R(x + 0.6, y + 0.3, 3.8, 1.2, T["--apple"]); R(x + 1, y + 1.6, 1.2, 1.2, T["--apple-hi"]); R(x + 2.2, y - 1, 0.8, 1.5, T["--desk-edge"]); R(x + 2.9, y - 1.3, 1.8, 1, T["--leaf"]); };
    [[518, 251], [523, 250], [528, 251], [533, 250], [538, 251]].forEach(([x, y]) => apple(x, y));
    R(516, 255, 28, 4, T["--desk-edge"]); R(519, 259, 22, 1.5, T["--desk-edge"]);
    [[481, 233], [486, 232], [491, 233], [483.5, 229], [488.5, 229]].forEach(([x, y]) => apple(x, y));
    R(479, 236, 18, 10, T["--desk-edge"]); R(479, 239.5, 18, 1, T["--desk"]); R(479, 242.5, 18, 1, T["--desk"]);
    apple(576, 333);
    people.forEach(drawChair);

    // Open handoffs lie on the counter as folders (red for findings), oldest first.
    const open = (data.handoffs || []).filter((h) => h.status === "open").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const items = [];
    people.forEach((p) => { items.push({ z: deskOf(p.i).y + 12, f: () => drawDesk(p) }); if (!p.hidden || p.scripted) items.push({ z: p.y, f: () => drawPerson(p, t) }); });
    items.push({ z: 180, f: () => {
      R(182, 164, 90, 13, T["--counter"]); R(182, 177, 90, 4, T["--counter-edge"]);
      open.slice(0, 4).forEach((h, k) => {
        const fx = 186 + k * 21, c = h.type === "qa_finding" ? T["--crit"] : T["--folder"];
        R(fx, 167, 12, 8, c); R(fx, 165.5, 5, 1.8, c);
      });
      if (open.length > 4) TXT(`+${open.length - 4}`, 272, 175, T["--muted"], 5.5, "right", 600);
      if (open.length) TXT(open.slice(0, 4).map((h) => h.ref).join("  "), 227, 189, T["--muted"], 5, "center", 600, true);
    } });
    items.push({ z: 319, f: () => { R(496, 312, 104, 16, T["--couch"]); R(496, 326, 104, 3, T["--counter-edge"]); } });
    items.push({ z: VENUS_FEET.y, f: () => { const P = Math.max(2, Math.round(s * 1.7)); sprite(VENUS, Math.round(VENUS_FEET.x * s) - 5 * P, Math.round(VENUS_FEET.y * s) - 22 * P, P, t, false); } });
    items.push({ z: VENUS_FEET.y + 4, f: () => { R(524, 78, 62, 18, T["--desk"]); R(524, 96, 62, 4, T["--desk-edge"]); R(566, 66, 14, 10, T["--monitor"]); R(566, 66, 14, 1.6, T["--a-you"]); } });
    items.sort((a, b) => a.z - b.z).forEach((it) => it.f());
    TXT("You", 555, 116, T["--a-you"], 6.5, "center", 600, true);
    people.forEach((p) => { if (!p.hidden || p.scripted) drawSign(p); });
  }

  // Draw only while the office is on screen and the page is visible.
  let lastT = performance.now(), running = false, onScreen = true, lastTick = -1, dirty = true;
  function frame(t) {
    running = false;
    if (document.hidden || !onScreen) return;
    const walking = people.some((p) => p.moving);
    update(Math.min(0.05, (t - lastT) / 1000)); lastT = t;
    // Typing only changes the picture every ~150 ms: draw at that rate unless someone walks.
    const tick = Math.floor(t / 150);
    if (walking || dirty || tick !== lastTick) { drawScene(t); lastTick = tick; dirty = false; }
    if (people.some((p) => p.moving) || (!reduce() && people.some((p) => p.state === "working" && !p.hidden))) {
      running = true; requestAnimationFrame(frame);
    }
  }
  function kick() { dirty = true; if (!running) { running = true; lastT = performance.now(); requestAnimationFrame(frame); } }
  document.fonts?.ready?.then(kick);
  new IntersectionObserver((e) => { onScreen = e[0].isIntersecting; if (onScreen) kick(); }).observe(cv);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
  motion.addEventListener("change", kick);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", kick);

  // ---------------------------------------------------------------- words, chips, clicks
  const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function describe() {
    cv.setAttribute("aria-label", "Office floor plan. " + people.map((p) => `${p.name} is ${WHERE[p.state] || p.state}: ${(p.quiet ? "Idle, session open" : p.helpers ? `Working: ${p.helpers} helper ${p.helpers === 1 ? "agent" : "agents"} running` : (WORDS[p.state] || p.state)).toLowerCase()}`).join(". ") + ".");
    const chips = document.getElementById("chips");
    const focused = document.activeElement?.closest?.("#chips [data-person]")?.dataset.person;
    chips.innerHTML = people.map((p) => {
      const id = /^[a-z0-9-]+$/.test(p.id) ? p.id : "x";
      const st = STATE_LOOK[p.state] || STATE_LOOK.offline;
      return `<button class="agent-chip" type="button" data-person="${esc(p.id)}" aria-pressed="${selected === p.id}">`
        + `<span class="dot" style="--c:var(--a-${id}, var(--muted))"></span>`
        + `<span>${esc(p.name)} · ${esc(p.job)}</span>`
        + `<span class="st"><span class="st-dot" style="--sc:var(${st[1]})" data-hollow="${st[2]}"></span><span aria-hidden="true">${st[0]}</span> ${esc(p.quiet ? "Idle, session open" : p.helpers ? `Working: ${p.helpers} helper ${p.helpers === 1 ? "agent" : "agents"} running` : (WORDS[p.state] || p.state))}</span></button>`;
    }).join("");
    if (focused) chips.querySelector(`[data-person="${CSS.escape(focused)}"]`)?.focus();
    kick();
  }
  function show(p) {
    selected = p.id; describe();
    const where = WHERE[p.state] || p.state;
    window.toast?.(`${p.name} is ${where}${p.task ? `: "${p.task.slice(0, 120)}"` : ""}.`);
  }
  document.getElementById("chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-person]"); if (!b) return;
    const p = people.find((x) => x.id === b.dataset.person); if (p) show(p);
  });
  function hit(ev) {
    const r = cv.getBoundingClientRect();
    const lx = ((ev.clientX - r.left) / r.width) * W, ly = ((ev.clientY - r.top) / r.height) * H;
    const byChar = people.filter((p) => (!p.hidden || p.scripted) && Math.abs(lx - p.x) <= 11 && ly >= p.y - 40 && ly <= p.y + 3).sort((a, b) => b.y - a.y)[0];
    if (byChar) return { person: byChar };
    const byDesk = people.find((p) => { const d = deskOf(p.i); return lx >= d.x - 4 && lx <= d.x + DESK_W + 4 && ly >= d.y - 30 && ly <= d.y + 40; });
    if (byDesk) return { person: byDesk };
    if (lx >= 474 && ly <= 176) return { venus: true };
    return null;
  }
  cv.addEventListener("click", (ev) => {
    const h = hit(ev); if (!h) return;
    if (h.person) show(h.person);
    else { document.getElementById("inboxTitle").scrollIntoView({ behavior: reduce() ? "auto" : "smooth", block: "start" }); window.toast?.("Your office: questions queue at your door and land in your inbox."); }
  });
  cv.addEventListener("mousemove", (ev) => { cv.style.cursor = hit(ev) ? "pointer" : "default"; });

  // app.js calls this on sign-out: nothing about the agents stays in the page.
  window.clearOffice = () => {
    data = {}; people = []; seenHandoffs = null; selected = null;
    document.getElementById("chips").innerHTML = "";
    cv.setAttribute("aria-label", "Office floor plan");
    ctx.clearRect(0, 0, cv.width, cv.height);
  };
  // app.js calls this after every load.
  window.renderOffice = (d) => { data = d || {}; if (data.agents) sync(); };
})();
