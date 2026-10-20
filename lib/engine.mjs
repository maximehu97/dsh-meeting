// 忙闲 / 求交 / 松绑 / 计票：全部由本机数据实时算出。
// 和两个 demo 的引擎同源，但日期是真实日期（每条日程带 d=YYYY-MM-DD），一个节点可以同时排会议和周末活动。
// 时段对外统一写成 "10/22(周四) 14:00-15:00"。

export const T = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const pad = (n) => String(n).padStart(2, "0");
export const F = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
export const STEP = 15;
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/* ---------------- 日期 ---------------- */
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const isWeekend = (date) => [0, 6].includes(fromYmd(date).getDay());
export const dayLabel = (date) => { const d = fromYmd(date); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
// 工作日 09:00-18:00，周末 09:00-21:00
export const windowOf = (date) => isWeekend(date) ? ["09:00", "21:00"] : ["09:00", "18:00"];

// 接受 2026-10-22 / 10/22 / 10月22日 / 周四 / 星期六 / 今天 / 明天 / 后天（周X 取今天起最近的那一天）
export function normDate(x, today = new Date()) {
  const s = String(x ?? "").trim();
  let m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  if ((m = s.match(/(\d{1,2})\s*[/月]\s*(\d{1,2})/))) {
    let y = today.getFullYear();
    const d = new Date(y, +m[1] - 1, +m[2]);
    if (d < new Date(today.getFullYear(), today.getMonth(), today.getDate() - 60)) y++;
    return `${y}-${pad(+m[1])}-${pad(+m[2])}`;
  }
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const add = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return ymd(d); };
  if (/今天/.test(s)) return add(0);
  if (/后天/.test(s)) return add(2);
  if (/明天/.test(s)) return add(1);
  if ((m = s.match(/(?:周|星期|礼拜)([一二三四五六日天])/))) {
    const want = "日一二三四五六".indexOf(m[1] === "天" ? "日" : m[1]);
    return add((want - base.getDay() + 7) % 7);
  }
  if (/sat/i.test(s)) return add((6 - base.getDay() + 7) % 7);
  if (/sun/i.test(s)) return add((7 - base.getDay()) % 7);
  throw new Error(`无法识别的日期：${x}（用 10/22、周四 或 2026-10-22）`);
}
export function normTime(x) {
  const m = String(x || "").match(/(\d{1,2})[:：](\d{2})/);
  if (!m) throw new Error(`无法识别的时间：${x}`);
  return pad(+m[1]) + ":" + m[2];
}
// "10/22(周四) 14:00-15:00" → { d, s, e }；没写日期时用 defDate
export function parseSlot(slot, defDate, today) {
  const str = String(slot);
  const m = str.match(/(\d{1,2}[:：]\d{2})\s*[-–~至到]\s*(\d{1,2}[:：]\d{2})/);
  if (!m) throw new Error(`无法识别的时段：${slot}（格式：10/22(周四) 14:00-15:00）`);
  const head = str.slice(0, m.index);
  let d;
  try { d = normDate(head, today); } catch { if (!defDate) throw new Error(`时段里没有日期：${slot}（格式：10/22(周四) 14:00-15:00）`); d = normDate(defDate, today); }
  return { d, s: normTime(m[1]), e: normTime(m[2]) };
}
export const fmtSlot = (x) => `${dayLabel(x.d)} ${x.s}-${x.e}`;

/* ---------------- 格子 ---------------- */
// 每 15 分钟格：busy / human（仅本人可豁免）/ soft（勉强）/ free
// 来源：日程（bump 和 ignore 里的会不算）、结构化偏好 prefs、助理从原始记录里提取的档案 profile.schedule、本人点头后的豁免 exemptions
export function cells(st, date, ignore = []) {
  const [ws, we] = windowOf(date).map(T);
  const n = (we - ws) / STEP, out = [];
  const weekend = isWeekend(date);
  for (let i = 0; i < n; i++) {
    const t = ws + i * STEP, te = t + STEP;
    const hit = (x) => T(x.s) < te && T(x.e) > t;
    const exempt = (st.exemptions || []).some((g) => g.d === date && T(g.s) <= t && T(g.e) >= te);
    if ((st.cal || []).some((x) => x.d === date && x.k !== "bump" && !ignore.includes(x.id) && hit(x))) { out.push("busy"); continue; }
    const flags = [];
    for (const p of st.prefs || []) {
      if (!p.s || !p.k) continue;
      if (p.days === "weekday" && weekend) continue;
      if (p.days === "weekend" && !weekend) continue;
      if (hit(p)) flags.push(p.k === "soft" ? "soft" : p.k === "human" ? "human" : "busy");
    }
    for (const x of st.profile?.schedule || []) if (x.d === date && hit(x)) flags.push(x.flex === "hard" ? "busy" : x.flex === "owner_exemptible" ? "human" : "soft");
    const f = flags.map((x) => (x === "human" && exempt ? null : x)).filter(Boolean);
    out.push(f.includes("busy") ? "busy" : f.includes("human") ? "human" : f.length ? "soft" : "free");
  }
  return { ws, cells: out };
}
function runs(arr, ok, ws) {
  const out = []; let cur = null;
  arr.forEach((v, i) => {
    if (ok(v, i)) { if (cur) cur.e = ws + (i + 1) * STEP; else { cur = { s: ws + i * STEP, e: ws + (i + 1) * STEP }; out.push(cur); } }
    else cur = null;
  });
  return out;
}

// 对外只给忙闲三类（不给原因）
export function availability(st, dates, ignore = []) {
  const out = { dates: dates.map(dayLabel), available: [], tentative: [], owner_exemptible: [], reasons: "withheld（原因不外露）" };
  for (const d of dates) {
    const { ws, cells: c } = cells(st, d, ignore);
    for (const [k, v] of [["available", "free"], ["tentative", "soft"], ["owner_exemptible", "human"]])
      out[k].push(...runs(c, (x) => x === v, ws).map((w) => `${dayLabel(d)} ${F(w.s)}-${F(w.e)}`));
  }
  return out;
}
export const datesOfSlots = (lists, today) => {
  const s = new Set();
  for (const l of lists) for (const x of l || []) { try { s.add(parseSlot(x, null, today).d); } catch {} }
  return [...s].sort();
};

// 把对外格式还原成格子
function toCells(av, date, today) {
  const [ws, we] = windowOf(date).map(T), n = (we - ws) / STEP;
  const c = Array(n).fill("busy");
  const paint = (list, v) => (list || []).forEach((sl) => {
    let x; try { x = parseSlot(sl, null, today); } catch { return; }
    if (x.d !== date) return;
    for (let i = 0; i < n; i++) { const t = ws + i * STEP; if (t >= T(x.s) && t + STEP <= T(x.e)) c[i] = v; }
  });
  paint(av.tentative, "soft"); paint(av.owner_exemptible, "human"); paint(av.available, "free");
  return c;
}

// 多人求交：返回 ≥ duration 的共同时段（按时间先后）；为空时给出代价最小的松绑方案和「少一个人」的方案
export function intersect(parties, duration, dates, today) {
  const step = duration >= 60 ? 30 : STEP, k = step / STEP, len = duration / STEP;
  const slots = [], relax = [], partial = [];
  const board = {};
  for (const d of dates) {
    const [ws] = windowOf(d).map(T);
    const grid = parties.map((p) => ({ who: p.who, c: toCells(p, d, today) }));
    board[d] = grid;
    const n = grid[0]?.c.length || 0;
    for (let a = 0; a + len <= n; a += k) {
      const seg = grid.map((g) => ({ who: g.who, c: g.c.slice(a, a + len) }));
      const slot = `${dayLabel(d)} ${F(ws + a * STEP)}-${F(ws + (a + len) * STEP)}`;
      const soft = seg.filter((g) => g.c.includes("soft")).map((g) => g.who);
      if (seg.every((g) => g.c.every((x) => x === "free" || x === "soft"))) { slots.push({ slot, tentative_for: soft }); continue; }
      if (seg.every((g) => g.c.every((x) => x !== "busy"))) {
        const need = seg.filter((g) => g.c.includes("human")).map((g) => g.who);
        const hc = seg.reduce((s, g) => s + g.c.filter((x) => x === "human").length, 0);
        relax.push({ slot, needs_owner_exemption_from: need, also_tentative_for: soft, exempt_minutes: hc * STEP, cost: need.length * 100 + hc + soft.length * 2 });
      }
      if (grid.length > 2) for (const out of seg) {
        const rest = seg.filter((g) => g !== out);
        if (rest.every((g) => g.c.every((x) => x === "free" || x === "soft")) && !partial.some((p) => p.without === out.who && p.slot.startsWith(dayLabel(d))))
          partial.push({ slot, without: out.who });
      }
    }
  }
  const common = slots.slice(0, 8);
  const best = [...slots].sort((x, y) => x.tentative_for.length - y.tentative_for.length)[0] || null;
  relax.sort((x, y) => x.cost - y.cost);
  return {
    duration_min: duration, parties: parties.map((p) => p.who), dates: dates.map(dayLabel),
    common_slots: common, empty: slots.length === 0,
    earliest: slots[0]?.slot || null, fewest_tentative: best?.slot || null,
    relax_options: slots.length ? [] : relax.slice(0, 3).map(({ cost, ...x }) => x),
    without_one_options: slots.length ? [] : partial.slice(0, 4),
    note: slots.length ? "有共同时段：本人要「越早越好」就用 earliest；团建等活动用 fewest_tentative（勉强的人最少）"
      : relax.length ? "交集为空：relax_options 按代价从小到大排序。向 needs_owner_exemption_from 里的人发 RELAX，请他本人松绑；不要替别人决定"
      : "交集为空，也没有可松绑的时段：看 without_one_options（少一个人可行），用 ask_owner 请本人选，或改天",
    _board: board,
  };
}

export const overlaps = (a, b) => a.d === b.d && T(a.s) < T(b.e) && T(a.e) > T(b.s);

/* ---------------- 奶茶 ---------------- */
export function tally(ballots, shops) {
  const rows = shops.map((s) => {
    const score = ballots.reduce((k, b) => k + Math.max(0, Math.min(3, +(b.scores?.[s.id] ?? 0))), 0);
    const vetoed_by = ballots.filter((b) => (b.veto || []).map((v) => String(v).toUpperCase()[0]).includes(s.id)).map((b) => b.who);
    return { shop: s.id, name: s.n, score, vetoed_by };
  });
  const ok = rows.filter((r) => !r.vetoed_by.length);
  let status, winner = null, tie = [], note;
  if (!ok.length) { status = "all_vetoed"; note = "两家都有人否决：找否决人数最少的那家，向否决人发 RELAX，请对方本人决定是否将就"; }
  else {
    const top = Math.max(...ok.map((r) => r.score));
    tie = ok.filter((r) => r.score === top);
    if (tie.length > 1) { status = "tie"; note = "平票：用 ask_owner 请本人拍板"; }
    else { status = "winner"; winner = tie[0].shop; note = `「${tie[0].name}」胜出；用各人选票里这家店的 picks 下单`; tie = []; }
  }
  const picks = winner ? ballots.map((b) => ({ who: b.who, pick: b.picks?.[winner] || "（没给）" })) : [];
  return { status, winner, tie: tie.map((r) => r.shop), rows, picks, note };
}
export function checkItem(shop, it, SUGAR, ICE) {
  const item = shop.items.find((x) => x.id === it.item_id || x.n === it.item || x.n === it.name || x.id === it.item);
  if (!item) throw new Error(`${shop.n} 没有「${it.item_id || it.item || it.name}」。菜单：${shop.items.map((x) => x.id + " " + x.n).join("、")}`);
  const sugar = it.sugar || "五分糖", ice = it.ice || "少冰";
  if (!SUGAR.includes(sugar)) throw new Error(`糖度只能是 ${SUGAR.join("/")}`);
  if (!ICE.includes(ice)) throw new Error(`冰量只能是 ${ICE.join("/")}`);
  const mods = [].concat(it.mods || []);
  for (const m of mods) {
    const ok = (item.milk_swap || []).some((x) => x.startsWith(m.replace(/^换/, ""))) || (item.removable || []).some((x) => m.includes(x));
    if (!ok) throw new Error(`「${item.n}」不支持「${m}」`);
  }
  const extra = mods.some((m) => m.includes("燕麦")) ? 3 : 0;
  return { item_id: item.id, name: item.n, sugar, ice, mods, price: item.price + extra };
}
