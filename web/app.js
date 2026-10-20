// dsh-meeting 手机页：状态全部来自本机节点（/api/state + SSE）。
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const T = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const dayLabel = (s) => { const d = fromYmd(s); return `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}`; };
const winOf = (s) => ([0, 6].includes(fromYmd(s).getDay()) ? ["09:00", "21:00"] : ["09:00", "18:00"]);
const TY = {
  NOTICE: { c: "#b69cff", n: "通知" }, RCPT: { c: "#9fb8b5", n: "回执" }, SYN: { c: "#5ad1ff", n: "① 请求" },
  "SYN-ACK": { c: "#ffb85c", n: "② 回可用" }, PROPOSE: { c: "#ff8fc8", n: "③ 提案" }, ACK: { c: "#7fe3c0", n: "确认" },
  RELAX: { c: "#ff9a5c", n: "松绑请求" }, CONFIRM: { c: "#4fd69c", n: "定稿" }, ERROR: { c: "#ff7f6e", n: "错误" },
  REPORT: { c: "#5aaeff", n: "上报" }, DECIDE: { c: "#4fd69c", n: "拍板" }, VOTE: { c: "#ffd27a", n: "投票" }, BALLOT: { c: "#d8e58f", n: "选票" },
};
const KIND = { busy: "原有", one: "1on1", lead: "上级会", peer: "已定", up: "上报会", hold: "暂锁", bump: "被挤掉" };
const FLEX = { hard: "走不开", owner_exemptible: "本人点头可让", tentative: "勉强" };

let S = null, tab = "chat", day = null, sel = null, lastChat = 0, toastT;
let thread = null, groupForm = null, inviting = false, lastThreadLen = 0; // thread: "dm:<id>" | "g:<gid>"
const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "HTTP " + r.status);
  return j;
};
const person = (id) => (id === S.me?.id ? S.me : S.directory.find((m) => m.id === id) || S.peers.find((p) => p.id === id)?.me || { id, n: id, a: "?", c: "#ddd" });
const nameOf = (id) => person(id).n;

async function load() {
  S = await (await fetch("/api/state")).json();
  S.dms ||= {}; S.groups ||= {}; S.directory ||= []; S.outbox ||= [];
  if (thread && !threadMsgs(thread).length && thread.startsWith("g:") && !S.groups[thread.slice(2)]) thread = null;
  render();
}
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (!S) return;
    switch (ev.type) {
      case "hello": case "reset": return load();
      case "chat": S.chat.push(ev.msg); if (ev.msg.ask) S.asks.push(ev.msg.ask); notifyChat(ev.msg); break;
      case "status": S.status = ev.status; break;
      case "cal": Object.assign(S, { cal: ev.cal, prefs: ev.prefs, exemptions: ev.exemptions, profile: ev.profile, roomBook: ev.roomBook }); break;
      case "a2a": S.a2a.push(ev.rec); break;
      case "peers": S.peers = ev.peers; refreshDirectory(); break;
      case "answer": { const a = S.asks.find((x) => x.id === ev.askId); if (a) a.answer = ev.key; break; }
      case "board": S.board = ev.board; break;
      case "tally": S.tally = ev.tally; break;
      case "order": S.order = ev.order; break;
      case "dm": { const l = (S.dms[ev.peer] ||= []); if (!l.some((m) => m.id === ev.msg.id)) l.push(ev.msg); notifyMsg("dm:" + ev.peer, ev.msg); break; }
      case "gmsg": { const g = S.groups[ev.gid]; if (g && !g.msgs.some((m) => m.id === ev.msg.id)) g.msgs.push(ev.msg); notifyMsg("g:" + ev.gid, ev.msg); break; }
      case "group": S.groups[ev.group.id] = { ...S.groups[ev.group.id], ...ev.group }; break;
      case "group-gone": delete S.groups[ev.gid]; if (thread === "g:" + ev.gid) { thread = null; syncInput(); } break;
      case "outbox": S.outbox = ev.outbox; break;
      default: return;
    }
    render();
  };
  es.onerror = () => { $(".st").textContent = "⚠ 连不上本机节点"; $(".st").className = "st warn"; };
}

function toast(title, sub) {
  const t = $(".toast");
  t.innerHTML = `<b>${esc(title)}</b>${esc(sub || "")}`;
  t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 4000);
  try { if (document.hidden && Notification.permission === "granted") new Notification(title, { body: sub || "" }); } catch {}
}
function notifyChat(m) {
  if (m.ask) toast(m.ask.toast || "👤 需要你决定", m.ask.question);
  else if (m.toast) toast(m.toast, m.x?.slice(0, 40));
}


/* ---------------- 消息：私聊 / 群聊 ---------------- */
function refreshDirectory() {
  const on = new Set(S.peers.filter((p) => p.online && !p.clash).map((p) => p.id));
  for (const m of S.directory) m.online = on.has(m.id);
  for (const p of S.peers) if (!S.directory.some((m) => m.id === p.id) && p.id !== S.me?.id) S.directory.push({ ...p.me, online: on.has(p.id) });
}
const seenKey = () => "dsh-meeting:seen:" + (S.me?.id || "");
function seenMap() { try { return JSON.parse(localStorage.getItem(seenKey()) || "{}"); } catch { return {}; } }
function markSeen(key) {
  const m = seenMap(), list = threadMsgs(key);
  if (!list.length) return;
  m[key] = list[list.length - 1].t;
  try { localStorage.setItem(seenKey(), JSON.stringify(m)); } catch {}
}
function threadMsgs(key) {
  if (key.startsWith("dm:")) return S.dms[key.slice(3)] || [];
  return S.groups[key.slice(2)]?.msgs || [];
}
function unreadOf(key, seen = seenMap()) {
  const t = seen[key] || "";
  return threadMsgs(key).filter((m) => m.t > t && m.from !== S.me?.id && m.from !== "sys").length;
}
function threads() {
  const seen = seenMap();
  const list = [
    ...Object.keys(S.dms).map((id) => ({ key: "dm:" + id, title: nameOf(id), p: person(id) })),
    ...Object.values(S.groups).map((g) => ({ key: "g:" + g.id, title: g.name, group: g })),
  ];
  for (const x of list) { const m = threadMsgs(x.key); x.last = m[m.length - 1]; x.unread = unreadOf(x.key, seen); }
  return list.sort((a, b) => (b.last?.t || b.group?.t || "").localeCompare(a.last?.t || a.group?.t || ""));
}
function notifyMsg(key, m) {
  if (m.from === S.me?.id) return;
  if (tab === "msg" && thread === key && !document.hidden) { markSeen(key); return; }
  const g = key.startsWith("g:") ? S.groups[key.slice(2)] : null;
  if (m.from === "sys") return;
  const atMe = (m.at || []).includes(S.me?.id);
  toast(g ? (atMe ? `📣 ${nameOf(m.from)} 在「${g.name}」里@了你` : `💭 ${g.name} · ${nameOf(m.from)}`) : `💭 ${nameOf(m.from)}`, m.x.slice(0, 60));
}
// 把 @名字 高亮
function richText(x) {
  const names = [S.me, ...S.directory].filter(Boolean).map((m) => m.n).sort((a, b) => b.length - a.length);
  let out = esc(x);
  if (names.length) out = out.replace(new RegExp("@(" + names.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g"), '<span class="at">@$1</span>');
  return out;
}
function avHtml(p, cls = "") { return `<span class="av ${cls}" style="background:${esc(p.c || "#ddd")}">${esc(p.a || "?")}</span>`; }
function pickHtml(exclude = []) {
  const ppl = S.directory.filter((m) => !exclude.includes(m.id));
  const depts = [...new Set(ppl.map((m) => m.dept || "其他"))];
  return `<div class="pick">${depts.map((d) => `<div class="dp">${esc(d)}</div>` + ppl.filter((m) => (m.dept || "其他") === d).sort((a, b) => b.online - a.online || a.L - b.L)
    .map((m) => `<label><input type="checkbox" value="${esc(m.id)}"><span class="pd ${m.online ? "on" : ""}"></span>${avHtml(m)}${esc(m.n)} <span class="dim">${esc(m.r)}</span></label>`).join("")).join("")}</div>`;
}
function renderMsg() {
  const v = $(".v-msg");
  if (v.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type !== "checkbox") return;
  if (groupForm) {
    v.innerHTML = `<div class="th-hdr"><button class="back">‹</button><b>新建群聊</b></div>
      <div class="pcard"><div class="row2"><input class="g-name" placeholder="群名（可不填）" value="${esc(groupForm.name || "")}"></div>
      <div class="row2 dim">拉谁进群（不在线的人上线后会收到）</div>${pickHtml()}
      <div class="row2"><button class="pbtn g-ok">创建</button><span class="err g-err"></span></div></div>`;
    $(".back", v).onclick = () => { groupForm = null; syncInput(); renderMsg(); };
    $(".g-name", v).oninput = (e) => (groupForm.name = e.target.value);
    $(".g-ok", v).onclick = () => {
      const members = $$(".pick input:checked", v).map((x) => x.value);
      post("/api/group/create", { name: $(".g-name", v).value, members })
        .then((r) => { S.groups[r.group.id] ||= { ...r.group, msgs: [] }; openThread("g:" + r.group.id); })
        .catch((e) => ($(".g-err", v).textContent = e.message));
    };
    return;
  }
  if (!thread) {
    const list = threads();
    v.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><button class="pbtn g-new" style="white-space:nowrap">➕ 新建群聊</button><span style="font-size:10.5px;color:var(--phone-dim);line-height:1.35">私聊：助理页输入 @名字，或在 👥 通讯录点「私聊」</span></div>`
      + (list.length ? list.map((x) => `<div class="thr" data-k="${esc(x.key)}">${x.group ? '<span class="av gav">👥</span>' : avHtml(x.p)}
        <div class="tx"><div class="tt">${esc(x.title)}${x.group ? ` <span class="dim" style="font-weight:400;font-size:11px">${x.group.members.length} 人</span>` : ""}<small>${x.last ? esc(new Date(x.last.t).toTimeString().slice(0, 5)) : ""}</small></div>
        <div class="lm">${x.last ? esc((x.last.from === "sys" ? "" : x.last.from === S.me?.id ? "我：" : nameOf(x.last.from) + "：") + x.last.x) : "（还没有消息）"}</div></div>${x.unread ? `<span class="ub">${x.unread}</span>` : ""}</div>`).join("")
        : `<div class="empty" style="color:var(--phone-dim)">还没有消息。<br>在助理页输入「@小美 周五记得带伞」就直接发给小美；@A@B 就是同时发给两个人。</div>`);
    $(".g-new", v).onclick = () => { groupForm = { name: "" }; syncInput(); renderMsg(); };
    $$(".thr", v).forEach((t) => (t.onclick = () => openThread(t.dataset.k)));
    return;
  }
  const isG = thread.startsWith("g:"), g = isG ? S.groups[thread.slice(2)] : null;
  if (isG && !g) { thread = null; return renderMsg(); }
  const peerId = isG ? null : thread.slice(3), p = peerId && person(peerId);
  const pend = new Set((S.outbox || []).map((o) => o.mid));
  const msgs = threadMsgs(thread);
  let h = `<div class="th-hdr"><button class="back">‹</button><b>${isG ? esc(g.name) + ` <small>${g.members.length} 人</small>` : esc(p.n) + ` <small>${esc(p.r || "")}${S.directory.find((m) => m.id === peerId)?.online ? " · 在线" : " · 不在线"}</small>`}</b>
    ${isG ? '<button class="pbtn g g-inv">＋拉人</button><button class="pbtn g g-quit">退出</button>' : ""}</div>`;
  if (isG && inviting) h += `<div class="pcard"><h4>拉人进「${esc(g.name)}」</h4>${pickHtml(g.members)}<div class="row2"><button class="pbtn i-ok">邀请</button><button class="pbtn g i-no">取消</button><span class="err i-err"></span></div></div>`;
  if (isG) h += `<div class="msg sys">成员：${g.members.map((x) => esc(g.names?.[x] || nameOf(x))).join("、")}</div>`;
  h += msgs.map((m) => {
    if (m.from === "sys") return `<div class="msg sys">${esc(m.x)}</div>`;
    const mine = m.from === S.me?.id, who = person(m.from);
    const atMe = (m.at || []).includes(S.me?.id);
    return `<div class="pm ${mine ? "mine" : "theirs"}">${!mine && isG ? `<span class="who">${esc(who.n)}</span>` : ""}<div class="msg ${mine ? "me" : "bot"} ${atMe ? "atme" : ""}">${richText(m.x)}</div>
      <span class="meta">${esc(new Date(m.t).toTimeString().slice(0, 5))}${m.bot ? " · 助理代发" : ""}${mine && pend.has(m.id) ? " · ⏳ 对方不在线，上线后送达" : ""}</span></div>`;
  }).join("") || `<div class="msg sys">说点什么吧</div>`;
  const near = v.scrollHeight - v.scrollTop - v.clientHeight < 80;
  v.innerHTML = h;
  if (near || msgs.length !== lastThreadLen) v.scrollTop = v.scrollHeight;
  lastThreadLen = msgs.length;
  markSeen(thread);
  $(".back", v).onclick = () => { thread = null; inviting = false; syncInput(); render(); };
  if (isG) {
    $(".g-inv", v).onclick = () => { inviting = !inviting; renderMsg(); };
    $(".g-quit", v).onclick = () => confirm(`退出「${g.name}」？`) && post("/api/group/leave", { gid: g.id }).then(() => { thread = null; syncInput(); render(); });
    const ok = $(".i-ok", v);
    if (ok) {
      ok.onclick = () => post("/api/group/invite", { gid: g.id, members: $$(".pick input:checked", v).map((x) => x.value) }).then(() => { inviting = false; render(); }).catch((e) => ($(".i-err", v).textContent = e.message));
      $(".i-no", v).onclick = () => { inviting = false; renderMsg(); };
    }
  }
}
function openThread(key) {
  thread = key; inviting = false; groupForm = null; lastThreadLen = 0;
  switchTab("msg");
}
function renderBadge() {
  const seen = seenMap();
  const n = [...Object.keys(S.dms).map((id) => "dm:" + id), ...Object.keys(S.groups).map((g) => "g:" + g)].reduce((k, key) => k + (tab === "msg" && thread === key ? 0 : unreadOf(key, seen)), 0);
  const b = $(".badge"); b.hidden = !n; b.textContent = n > 99 ? "99+" : n;
}

/* ---------------- @ 选人 ---------------- */
let menIdx = 0;
function mentionCands() {
  if (tab === "msg" && thread?.startsWith("g:")) {
    const g = S.groups[thread.slice(2)];
    return (g?.members || []).filter((x) => x !== S.me?.id).map((x) => person(x));
  }
  return [...S.directory].sort((a, b) => b.online - a.online);
}
function updateMention() {
  const box = $(".mention"), inp = $(".inp input");
  const m = inp.value.slice(0, inp.selectionStart).match(/@([^\s@]*)$/);
  if (!m) { box.hidden = true; return; }
  const q = m[1].toLowerCase();
  const list = mentionCands().filter((p) => !q || p.n.toLowerCase().includes(q) || p.id.toLowerCase().startsWith(q) || (p.dept || "").includes(q)).slice(0, 30);
  if (!list.length) { box.hidden = true; return; }
  menIdx = Math.min(menIdx, list.length - 1);
  box.innerHTML = list.map((p, i) => `<div data-id="${esc(p.id)}" class="${i === menIdx ? "on" : ""}">${avHtml(p)}${esc(p.n)}<small>${esc(p.r || "")}${p.dept ? " · " + esc(p.dept) : ""}${p.online ? "" : " · 不在线"}</small></div>`).join("");
  box.hidden = false;
  $$("div", box).forEach((d) => (d.onmousedown = (e) => { e.preventDefault(); pickMention(d.dataset.id); }));
}
function pickMention(id) {
  const inp = $(".inp input"), pos = inp.selectionStart;
  const before = inp.value.slice(0, pos).replace(/@([^\s@]*)$/, "@" + nameOf(id) + " ");
  inp.value = before + inp.value.slice(pos);
  inp.setSelectionRange(before.length, before.length);
  $(".mention").hidden = true; menIdx = 0;
  inp.focus();
}

/* ---------------- 手机 ---------------- */
function renderHeader() {
  const me = S.me;
  const d = new Date();
  $(".clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const av = $(".hdr .av");
  av.textContent = me?.a || "?"; av.style.background = me?.c || "#ddd";
  $(".nm").textContent = me ? `${me.n}的助理` : "九派私人助理";
  $(".rl").textContent = me ? `${me.r}${me.dept ? " · " + me.dept : ""} · 本机 dsh` : "还没选身份";
  const st = $(".st"); st.textContent = S.status.x; st.className = "st " + S.status.cls;
  document.title = me ? `九派 · ${me.n}的助理` : "九派 · 私人助理";
}

function msgHtml(m) {
  if (m.from === "me") return `<div class="msg me${m.tap ? " tap" : ""}">${esc(m.x)}</div>`;
  if (m.from === "sys") return `<div class="msg sys">${esc(m.x)}</div>`;
  if (m.kind === "ask") {
    const a = S.asks.find((x) => x.id === m.ask.id) || m.ask;
    const ans = a.answer || (S.asks.some((x) => x.id === a.id) ? null : "（已处理）");
    return `<div class="msg bot">${esc(a.context || "")}<div class="mcard ask" data-ask="${a.id}">
      <div class="q">${esc(a.question)}</div>${(a.lines || []).map((l) => `<div class="ln">${esc(l)}</div>`).join("")}
      <div class="btns">${a.options.map((o, i) => `<button data-k="${esc(o.key)}" class="${i === 0 ? "p" : ""}" ${ans ? "disabled" : ""}>${esc(o.label)}</button>`).join("")}</div>
      ${ans ? `<div class="done">✓ ${a.answer === "expired" ? "已失效" : "已选择：" + esc(a.options.find((o) => o.key === a.answer)?.label || ans)}</div>` : ""}</div></div>`;
  }
  const c = m.card;
  return `<div class="msg bot">${esc(m.x)}${c ? `<div class="mcard"><b>📅 ${esc(c.title)}</b>${esc(c.when || "")}${c.who ? `<br>👥 ${esc(c.who)}` : ""}${c.room ? `<br>📍 ${esc(c.room)}` : ""}${c.note ? `<br><span style="color:#6c7f80">${esc(c.note)}</span>` : ""}</div>` : ""}</div>`;
}
function renderChat() {
  const body = $(".v-chat");
  const near = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const items = S.chat.map((m) => ({ t: m.t, html: msgHtml(m) }));
  for (const r of S.a2a) {
    const ty = TY[r.ty]?.n || r.ty;
    const peer = r.dir === "out" ? "→ " + r.to.map(nameOf).join("、") : "← " + nameOf(r.from);
    items.push({ t: r.t, html: `<div class="msg sys">📡 ${esc(r.ty)} ${esc(ty)} ${esc(peer)}：${esc(r.x)}</div>` });
  }
  items.sort((a, b) => a.t.localeCompare(b.t));
  let html = items.map((i) => i.html).join("");
  if (!S.chat.some((m) => m.from === "me")) {
    html += `<div class="msg sys">${S.peers.filter((p) => p.online).length ? `局域网里有 ${S.peers.filter((p) => p.online).length} 位同事在线（👥 页）。` : "还没发现同事：让同事也打开 dsh-meeting，或在 👥 页手动加 IP / 邀请码。"}点示例，或用自己的话说</div>`;
    html += (S.openers || []).map((o) => `<div class="chip">🎙 ${esc(o)}</div>`).join("");
  }
  if (["run", "wait"].includes(S.status.cls)) html += `<div class="typing">${esc(S.status.x)} …</div>`;
  body.innerHTML = html;
  $$(".chip", body).forEach((c) => (c.onclick = () => say(c.textContent.replace(/^🎙 /, ""))));
  $$(".ask", body).forEach((card) => $$("button", card).forEach((b) => (b.onclick = () => {
    $$("button", card).forEach((x) => (x.disabled = true));
    post("/api/answer", { askId: card.dataset.ask, key: b.dataset.k });
  })));
  if (near || items.length !== lastChat) body.scrollTop = body.scrollHeight;
  lastChat = items.length;
}

function calDays() {
  const s = new Set(S.cal.map((e) => e.d));
  const base = new Date();
  for (let i = 0; i < 7; i++) { const d = new Date(base); d.setDate(d.getDate() + i); s.add(ymd(d)); }
  for (const x of S.profile?.schedule || []) s.add(x.d);
  return [...s].sort().filter((d) => d >= ymd(base));
}
function renderCal() {
  const days = calDays();
  if (!day || !days.includes(day)) day = S.cal.find((e) => e.d >= ymd(new Date()))?.d || days[0];
  const [ws, we] = winOf(day).map(T), H = 520, y = (m) => ((T(m) - ws) / (we - ws)) * H;
  let h = `<div class="days">${days.map((d) => `<span data-d="${d}" class="${d === day ? "on" : ""} ${S.cal.some((e) => e.d === d) ? "has" : ""}">${esc(dayLabel(d))}</span>`).join("")}</div>`;
  h += `<div class="legend">${["lead", "peer", "up", "one", "hold", "bump", "busy"].map((k) => `<span><i class="k-${k}"></i>${KIND[k]}</span>`).join("")}<span><i style="background:#ffd9ec"></i>偏好/档案</span></div><div class="cal" style="height:${H}px">`;
  for (let m = ws; m <= we; m += 60) h += `<div class="hr" style="top:${((m - ws) / (we - ws)) * H}px"><span>${pad(m / 60)}:00</span></div>`;
  const weekend = [0, 6].includes(fromYmd(day).getDay());
  for (const p of S.prefs) if (p.s && p.k && !(p.days === "weekday" && weekend)) h += `<div class="pf ${p.k}" style="top:${y(p.s)}px;height:${y(p.e) - y(p.s)}px">${esc(p.x)}</div>`;
  for (const x of S.profile?.schedule || []) if (x.d === day) h += `<div class="pf ${x.flex === "hard" ? "" : x.flex === "owner_exemptible" ? "human" : "soft"}" style="top:${y(x.s)}px;height:${Math.max(14, y(x.e) - y(x.s))}px">${esc(x.what)}（${FLEX[x.flex]}）</div>`;
  for (const x of S.exemptions) if (x.d === day) h += `<div class="pf exempt" style="top:${y(x.s)}px;height:${y(x.e) - y(x.s)}px">✓ 本人同意让出 · ${esc(x.note)}</div>`;
  for (const e of S.cal.filter((e) => e.d === day)) {
    h += `<div class="ev k-${e.k}" style="top:${y(e.s)}px;height:${Math.max(16, y(e.e) - y(e.s) - 1)}px" title="${esc(e.id)}">${esc(e.s)}–${esc(e.e)} ${esc(e.t)}<small>${esc(KIND[e.k] || "")}${e.room ? " · " + esc(e.room) : ""}${e.who?.length ? " · " + esc(e.who.map(nameOf).join("、")) : ""}</small></div>`;
  }
  h += `</div><div class="pcard" style="margin-top:10px"><h4>➕ 手动加一条忙碌</h4>
    <div class="row2"><input class="c-t" placeholder="事情，如 看牙" style="flex:2"><input class="c-s" placeholder="开始 14:00"><input class="c-e" placeholder="结束 15:00"></div>
    <div class="row2"><button class="pbtn c-add">加到 ${esc(dayLabel(day))}</button><span class="dim">助理排时间时会避开</span></div></div>`;
  const v = $(".v-cal");
  const st = v.scrollTop;
  v.innerHTML = h; v.scrollTop = st;
  $$(".days span", v).forEach((s) => (s.onclick = () => { day = s.dataset.d; renderCal(); }));
  $(".c-add", v).onclick = () => post("/api/cal/add", { date: day, start: $(".c-s", v).value, end: $(".c-e", v).value, title: $(".c-t", v).value }).catch((e) => alert(e.message));
}

function renderMem() {
  const v = $(".v-mem"), p = S.profile;
  if (v.contains(document.activeElement)) return;
  let h = "";
  if (S.prefs.length) h += `<div class="pcard"><h4>⚙️ 本人偏好</h4>${S.prefs.map((x) => `<div class="row2">${esc(x.x)}${x.k ? ` <span class="tag">${{ hard: "硬约束", human: "仅本人可豁免", soft: "勉强" }[x.k]}</span>` : ""}</div>`).join("")}</div>`;
  h += `<div class="pcard"><h4>🧠 助理从记录里提取的档案</h4>${p ? `
    ${p.schedule.map((x) => `<div class="row2"><span>${esc(dayLabel(x.d))} ${esc(x.s)}-${esc(x.e)} ${esc(x.what)}</span><span class="tag flex-${x.flex}" style="margin-left:auto">${FLEX[x.flex]}</span></div>`).join("")}
    ${p.tea ? `<div class="row2">🧋 ${esc([p.tea.usual, (p.tea.likes || []).length ? "喜欢 " + p.tea.likes.join("、") : "", (p.tea.dislikes || []).length ? "不要 " + p.tea.dislikes.join("、") : ""].filter(Boolean).join("；"))}</div>` : ""}
    ${(p.diet?.hard || []).length ? `<div class="row2">⛔ 不能碰：${esc(p.diet.hard.join("、"))}</div>` : ""}
    ${p.notes ? `<div class="row2 dim">${esc(p.notes)}</div>` : ""}` : `<div class="dim">还没有。助理第一次需要了解你（比如有人约周末、投票奶茶）时，会自己读下面的记录并整理出来。</div>`}</div>`;
  h += `<div class="pcard"><h4>📒 我的原始记录 <span class="dim">（只有我的助理能读）</span></h4><textarea class="hist">${esc(S.history)}</textarea>
    <div class="row2"><button class="pbtn h-save">保存（档案会重新提取）</button></div></div>`;
  if (S.order) h += `<div class="pcard"><h4>🧋 团单 · ${esc(S.order.shopName)}</h4>${S.order.items.map((x) => `<div class="row2">${esc(x.name_cn)}：${esc(x.name)} ${esc(x.sugar)} ${esc(x.ice)} ${esc((x.mods || []).join(" "))}<span style="margin-left:auto">¥${x.price}</span></div>`).join("")}<div class="row2 dim">送达 ${esc(S.order.deliver_at)} · ${esc(S.order.place)} · 合计 ¥${S.order.total}</div></div>`;
  h += `<div class="pcard"><h4>👤 我是谁</h4><div class="row2">${esc(S.me?.n)} · ${esc(S.me?.r)} · ${esc(S.me?.dept || "")} · L${esc(S.me?.L)} · id <code>${esc(S.me?.id)}</code></div>
    <div class="row2"><button class="pbtn g re-setup">换身份</button><button class="pbtn g re-seed">恢复示例数据</button></div></div>`;
  v.innerHTML = h;
  $(".h-save", v).onclick = () => post("/api/history", { text: $(".hist", v).value }).then(() => toast("已保存", "助理下次会重新读"));
  $(".re-setup", v).onclick = () => { S.forceSetup = true; render(); };
  $(".re-seed", v).onclick = () => confirm("把日程、档案、对话恢复成示例的初始状态？") && post("/api/reset", { reseed: true });
}

function peersHtml(compact) {
  const addr = S.addresses[0];
  let h = addr ? `<div class="${compact ? "me-addr" : "pcard"}">${compact ? "" : "<h4>📶 本机地址（告诉同事）</h4>"}
    手机页 <code>${esc(addr.url)}</code><br>邀请码 <span class="code">${esc(addr.code)}</span> · 团队码 ${esc(S.team)}${S.addresses.length > 1 ? `<br><span class="dim">其他网卡：${S.addresses.slice(1).map((a) => esc(a.address)).join("、")}</span>` : ""}</div>`
    : `<div class="err">本机没有局域网 IP</div>`;
  const list = S.peers.map((p) => `<div class="${compact ? "peer" : "row2"}"><span class="pd ${p.online ? "on" : ""}"></span><span class="av" style="width:24px;height:24px;font-size:11px;background:${esc(p.me.c)}">${esc(p.me.a)}</span>
      <span>${esc(p.me.n)} <span class="${compact ? "sm" : "dim"}">${esc(p.me.r)}${p.me.dept ? " · " + esc(p.me.dept) : ""} · ${esc(p.id)}${p.clash ? " · ⚠ id 重复" : ""}</span><br><span class="${compact ? "sm" : "dim"}">${esc(p.node.replace("http://", ""))} · ${p.via === "manual" ? "手动添加" : "自动发现"}${p.online ? "" : " · 离线"}</span></span>
      <button class="pbtn g x" data-forget="${esc(p.id)}" title="忘掉">✕</button></div>`).join("");
  h += compact ? list || `<div class="empty">还没有发现同事</div>` : `<div class="pcard"><h4>👥 局域网同事 <span class="dim">mDNS ${esc(S.mdns)}</span></h4>${list || `<div class="dim">还没有发现同事。同一 Wi‑Fi 下对方启动后一般几秒内出现；路由器屏蔽组播时，用下面手动添加。</div>`}</div>`;
  h += `<div class="${compact ? "" : "pcard"}">${compact ? "" : "<h4>➕ 手动添加</h4>"}<div class="addp"><input class="paddr" placeholder="对方 IP、IP:端口 或邀请码"><button class="${compact ? "btn mini" : "pbtn"} padd">添加</button></div><div class="err perr"></div></div>`;
  return h;
}
function bindPeers(el) {
  const btn = $(".padd", el);
  if (btn) btn.onclick = async () => {
    $(".perr", el).textContent = "";
    try { const r = await post("/api/peers/add", { address: $(".paddr", el).value }); toast("已添加", `${r.peer.me.n} 在线`); }
    catch (e) { $(".perr", el).textContent = e.message; }
  };
  $$("[data-forget]", el).forEach((b) => (b.onclick = () => post("/api/peers/forget", { id: b.dataset.forget })));
}
function directoryHtml() {
  const ppl = [S.me, ...S.directory].filter(Boolean);
  const order = [...new Set(S.seeds.map((p) => p.me.dept))];
  const depts = [...new Set(ppl.map((m) => m.dept || "其他"))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return `<div class="pcard dir"><h4>🏢 公司通讯录 <span class="dim">${S.directory.filter((m) => m.online).length} 人在线 · 点「私聊」直接发消息</span></h4>${depts.map((d) => `<div class="row2 dept">${esc(d)}</div>` + ppl.filter((m) => (m.dept || "其他") === d).sort((a, b) => a.L - b.L)
    .map((m) => `<div class="row2"><span class="pd ${m.id === S.me?.id || m.online ? "on" : ""}"></span>${avHtml(m)}<span>${esc(m.n)} <span class="dim">${esc(m.r)} · L${esc(m.L)}${m.up ? " · 上级 " + esc(nameOf(m.up)) : ""}</span>${m.squad ? ` <span class="sqd">${esc(m.squad)}</span>` : ""}</span>
      ${m.id === S.me?.id ? '<span class="tag" style="margin-left:auto">我</span>' : `<button class="pbtn g" style="margin-left:auto;white-space:nowrap" data-dm="${esc(m.id)}">私聊</button>`}</div>`).join("")).join("")}</div>`;
}
function renderNet() {
  const v = $(".v-net");
  if (v.contains(document.activeElement)) return;
  v.innerHTML = directoryHtml() + peersHtml(false); bindPeers(v);
  $$("[data-dm]", v).forEach((b) => (b.onclick = () => { S.dms[b.dataset.dm] ||= []; openThread("dm:" + b.dataset.dm); }));
}

function renderSetup() {
  const el = $(".setup");
  const show = !S.me || S.forceSetup;
  el.hidden = !show;
  if (!show || el.contains(document.activeElement)) return;
  const taken = new Set(S.peers.filter((p) => p.online).map((p) => p.id));
  const groups = {};
  for (const p of S.seeds) (groups[p.groupName] ||= []).push(p);
  el.innerHTML = `<h2>👋 我是谁？</h2><div class="dim" style="font-size:12px">这台电脑上的助理只代表你一个人。选公司里的一个人（自带日程 / 偏好 / 聊天记录），或者填自己的。灰色的人已经被局域网里别的电脑用了。</div>
    ${Object.entries(groups).map(([g, list]) => `<div class="grp">${esc(g)}</div><div class="opts">${list.map((p) => `<div class="opt ${taken.has(p.id) ? "taken" : ""}" data-p="${esc(p.id)}"><span class="av" style="background:${esc(p.me.c)}">${esc(p.me.a)}</span><span>${esc(p.me.n)}<small>${esc(p.me.r)}</small></span></div>`).join("")}</div>`).join("")}
    <div class="grp">自己填</div><div class="pcard">
      <div class="row2"><input class="s-n" placeholder="名字，如 小明"><input class="s-id" placeholder="英文 id，如 xiaoming"></div>
      <div class="row2"><input class="s-r" placeholder="职位，如 产品经理"><input class="s-d" placeholder="部门"><select class="s-l"><option value="1">L1 总监</option><option value="2">L2 经理</option><option value="3" selected>L3 员工</option></select></div>
      <div class="row2"><button class="pbtn s-go">就是我</button>${S.me ? `<button class="pbtn g s-cancel">取消</button>` : ""}</div><div class="err s-err"></div></div>`;
  const go = (body) => post("/api/setup", body).then(() => { S.forceSetup = false; }).catch((e) => { $(".s-err", el).textContent = e.message; });
  $$(".opt", el).forEach((o) => (o.onclick = () => go({ persona: o.dataset.p })));
  $(".s-go", el).onclick = () => go({ custom: { n: $(".s-n", el).value, id: $(".s-id", el).value, r: $(".s-r", el).value, dept: $(".s-d", el).value, L: $(".s-l", el).value } });
  const c = $(".s-cancel", el); if (c) c.onclick = () => { S.forceSetup = false; render(); };
}

/* ---------------- 侧栏（宽屏） ---------------- */
function renderSide() {
  const seq = $(".seq");
  if (!S.a2a.length) seq.innerHTML = `<div class="empty">还没有报文。本人发起协商、或同事的助理发来报文时会出现在这里。</div>`;
  else {
    let conv = null, h = "";
    S.a2a.forEach((r, i) => {
      if (r.conv && r.conv !== conv) { conv = r.conv; h += `<div class="conv">🔁 ${esc(conv)}</div>`; }
      const ty = TY[r.ty] || { c: "#ccc", n: r.ty };
      h += `<div class="a2r ${sel === i ? "sel" : ""}" data-i="${i}"><div><b style="background:${ty.c}">${esc(r.ty)}</b><div class="tm">${esc(new Date(r.t).toTimeString().slice(0, 8))}</div></div>
        <div><span class="who">${esc(nameOf(r.from))} → ${esc(r.to.map(nameOf).join("、"))}</span><br>${esc(r.x)}</div></div>`;
    });
    const near = seq.scrollHeight - seq.scrollTop - seq.clientHeight < 60;
    seq.innerHTML = h;
    if (near) seq.scrollTop = seq.scrollHeight;
    $$(".a2r", seq).forEach((row) => (row.onclick = () => { sel = +row.dataset.i; renderSide(); }));
  }
  const r = S.a2a[sel];
  $(".detail").innerHTML = r ? `<div class="json">${esc(JSON.stringify({ from: "agent://" + r.from, to: r.to.map((x) => "agent://" + x), type: r.ty, conv: r.conv, payload: r.p }, null, 2))}</div>` : "";
  $(".mdns").textContent = `mDNS ${S.mdns} · 团队码 ${S.team}`;
  const ps = $(".peers-side");
  if (!ps.contains(document.activeElement)) { ps.innerHTML = peersHtml(true); bindPeers(ps); }
  const ex = $(".extra");
  const b = S.board, t = S.tally;
  ex.hidden = !b && !t;
  if (b || t) ex.innerHTML = `<h3>🧮 求交 / 投票 <small>本机算的</small></h3>
    ${b ? `<div style="font-size:12px">${b.common?.length ? "共同时段：" + b.common.slice(0, 4).map((x) => esc(x.slot)).join("；") : "交集为空" + (b.relax?.length ? "；松绑：" + esc(b.relax[0].slot) + " 需 " + esc(b.relax[0].needs_owner_exemption_from.map(nameOf).join("、")) + " 本人同意" : "")}</div>` : ""}
    ${t ? `<div style="font-size:12px;margin-top:6px">${t.rows.map((r) => `${esc(r.name)} ${r.score} 分${r.vetoed_by.length ? "（" + esc(r.vetoed_by.map(nameOf).join("、")) + " 否决）" : ""}`).join(" · ")} → ${esc(t.status === "winner" ? t.rows.find((r) => r.shop === t.winner)?.name : t.status)}</div>` : ""}`;
}

function render() {
  if (!S) return;
  renderHeader(); renderSetup();
  if (tab === "chat") renderChat();
  if (tab === "cal") renderCal();
  if (tab === "mem") renderMem();
  if (tab === "net") renderNet();
  if (tab === "msg") renderMsg();
  renderBadge();
  renderSide();
}

function say(x) { if (!x.trim()) return; post("/api/say", { text: x.trim() }).catch((e) => toast("⚠ 没发出去", e.message)); }
// 输入框：助理页发给助理（@某人 则直接发给那个人）；消息页发到当前对话
function send(x) {
  x = x.trim();
  if (!x) return;
  if (tab === "msg" && thread) {
    const p = thread.startsWith("g:") ? post("/api/group/send", { gid: thread.slice(2), text: x }) : post("/api/dm", { to: [thread.slice(3)], text: x });
    return p.catch((e) => toast("⚠ 没发出去", e.message));
  }
  say(x);
}
function syncInput() {
  const show = tab === "chat" || (tab === "msg" && !!thread && !groupForm);
  $(".inp").hidden = !show;
  $(".mention").hidden = true;
  input.placeholder = tab === "chat" ? "对你的助理说…（@某人 直接发给他）" : thread?.startsWith("g:") ? "在群里说…（@某人 提醒他）" : `发给 ${thread ? nameOf(thread.slice(3)) : ""}…`;
}
function switchTab(t) {
  tab = t;
  $$(".tab").forEach((x) => x.classList.toggle("on", x.dataset.t === t));
  for (const k of ["chat", "msg", "cal", "mem", "net"]) $(".v-" + k).hidden = k !== tab;
  syncInput();
  render();
}
$$(".tab").forEach((t) => (t.onclick = () => { if (t.dataset.t === "msg" && tab === "msg") { thread = null; groupForm = null; } switchTab(t.dataset.t); }));
const input = $(".inp input");
$(".inp button").onclick = () => { send(input.value); input.value = ""; $(".mention").hidden = true; };
input.oninput = () => { menIdx = 0; updateMention(); };
input.onclick = updateMention;
input.onblur = () => setTimeout(() => ($(".mention").hidden = true), 150);
input.onkeydown = (e) => {
  const box = $(".mention");
  if (!box.hidden) {
    const n = $$("div", box).length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); menIdx = (menIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n; updateMention(); return; }
    if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); pickMention($$("div", box)[menIdx].dataset.id); return; }
    if (e.key === "Escape") { box.hidden = true; return; }
  }
  if (e.key === "Enter" && !e.isComposing) { send(input.value); input.value = ""; }
};
$("[data-act=reset]").onclick = () => confirm("清空对话和报文，开新一轮（日程保留）？") && post("/api/reset", {});
document.addEventListener("click", () => { try { if (Notification.permission === "default") Notification.requestPermission(); } catch {} }, { once: true });
setInterval(() => S && renderHeader(), 30000);
await load();
connect();
