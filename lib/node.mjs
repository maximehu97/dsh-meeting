// dsh-meeting 本机节点：每台电脑一个，跑在 dsh 进程里（由 lib/index.js 挂载）。
//  1) 本人的数据：日程 / 偏好 / 原始记录 / 助理档案 / 会议室预订 / 奶茶订单（存 dataDir/state.json）
//  2) MCP 工具（Streamable HTTP，/mcp）：本机 dsh 助理通过它读写本人数据、发 A2A
//  3) 出站 A2A：send_a2a → 直接用 A2A JSON-RPC（message/send + tasks/get）投递到对方电脑上的 @amaster.ai/dsh-a2a；
//     对方助理调 reply_a2a → 对方节点把结构化回复 POST 回本节点 /peer/reply
//  4) 局域网发现：mDNS（_dshmeet._tcp）+ 手动 IP / 邀请码
//  5) 手机页：/（SSE 实时推送，本人说话 / 点按钮）
//  6) 人和人的消息：@ 私聊、群聊（节点之间 /peer/msg 直接转发，不经过助理；对方不在线时进发件箱，上线后补发）
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as E from "./engine.mjs";
import { mcpHandler } from "./mcp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "web");
const SEEDS = JSON.parse(fs.readFileSync(path.join(HERE, "seeds.json"), "utf8"));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
const clone = (x) => JSON.parse(JSON.stringify(x));
const nowIso = () => new Date().toISOString();
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const nowTag = () => { const d = new Date(); return `[现在 ${E.ymd(d)} ${WD[d.getDay()]} ${E.F(d.getHours() * 60 + d.getMinutes())}]`; };
const KIND_CN = { busy: "原有", one: "1on1", lead: "上级会", peer: "同级会/已定", up: "上报会", hold: "暂锁", bump: "被挤掉待重约" };
const TYPES = ["NOTICE", "SYN", "PROPOSE", "RELAX", "CONFIRM", "REPORT", "VOTE"];
const RTYPES = ["RCPT", "SYN-ACK", "ACK", "DECIDE", "BALLOT"];
const DONE = new Set(["input-required", "completed", "failed", "canceled", "rejected"]);

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || [])
    if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push({ name, address: a.address });
  const rank = (a) => (/^(en|eth|wl)/.test(a.name) ? 0 : 1) + (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address) ? 0 : 2);
  return out.sort((x, y) => rank(x) - rank(y));
}
// 邀请码：IPv4 的 8 位十六进制（端口不是默认 4500 时加 -端口），例如 C0A8-89CE
export const inviteCode = (ip, port) => ip.split(".").map((n) => (+n).toString(16).padStart(2, "0")).join("").toUpperCase().replace(/^(.{4})/, "$1-") + (port !== 4500 ? `-${port}` : "");
export function parseAddress(x) {
  const s = String(x || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  let m;
  if ((m = s.match(/^([0-9a-f]{4})-?([0-9a-f]{4})(?:-(\d+))?$/i))) {
    const hex = m[1] + m[2];
    return { host: [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).join("."), port: +(m[3] || 4500) };
  }
  if ((m = s.match(/^([\w.-]+)(?::(\d+))?$/))) return { host: m[1], port: +(m[2] || 4500) };
  throw new Error("看不懂这个地址：" + x + "（填对方手机页上显示的 IP、IP:端口 或邀请码）");
}

export class MeetingNode {
  constructor(config) {
    this.cfg = config;
    this.dataDir = config.dataDir || path.join(os.homedir(), ".dsh-meeting");
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.file = path.join(this.dataDir, "state.json");
    this.instance = randomBytes(6).toString("hex");
    this.clients = new Set();
    this.waiters = {};
    this.pending = {}; // 出站报文 msgId -> { resolve, reply }
    this.peers = {}; // id -> peer
    this.localBusy = 0;
    this.inboundBusy = 0;
    this.load();
  }

  /* ============================== 状态 ============================== */
  blank(me = null) {
    return { v: 1, me, cal: [], prefs: [], history: "", profile: null, exemptions: [], openers: [], persona: null,
      chat: [], a2a: [], asks: {}, deferred: [], inbound: {}, roomBook: [], order: null, tally: null, board: null,
      manualPeers: [], status: { x: "💤 待命", cls: "idle" }, seq: 0, run: Date.now().toString(36),
      dms: {}, groups: {}, outbox: [] };
  }
  load() {
    try { this.S = { ...this.blank(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) }; }
    catch { this.S = this.blank(); }
    // 示例人物的岗位 / 部门 / 上级随版本更新（两个 demo 合并成一家公司），本人的日程和记录不动
    const seed = this.S.persona && SEEDS.personas.find((p) => p.id === this.S.persona);
    if (seed) {
      this.S.me = clone(seed.me);
      if (!this.S.history?.trim() && seed.history) this.S.history = seed.history;
      if (!this.S.cal.length && seed.cal.length) this.S.cal = clone(seed.cal);
      if (!this.S.prefs.length && seed.prefs.length) this.S.prefs = clone(seed.prefs);
      this.S.openers = seed.openers;
    }
    // 重启后没人等的卡片作废
    for (const a of Object.values(this.S.asks)) if (!a.answer) a.answer = "expired";
    this.S.inbound = {};
    this.S.status = { x: "💤 待命", cls: "idle" };
  }
  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.S));
      fs.renameSync(tmp, this.file);
    }, 300);
  }
  emit(type, data = {}) {
    const line = `data: ${JSON.stringify({ type, t: nowIso(), ...data })}\n\n`;
    for (const res of this.clients) res.write(line);
    this.save();
  }
  setStatus(x, cls) { this.S.status = { x, cls }; this.emit("status", { status: this.S.status }); }
  chat(m) {
    const msg = { id: "c" + ++this.S.seq, t: nowIso(), ...m };
    this.S.chat.push(msg);
    if (this.S.chat.length > 400) this.S.chat.splice(0, this.S.chat.length - 400);
    this.emit("chat", { msg });
    return msg;
  }
  logA2A(rec) {
    rec = { id: "a" + ++this.S.seq, t: nowIso(), ...rec };
    this.S.a2a.push(rec);
    if (this.S.a2a.length > 400) this.S.a2a.splice(0, this.S.a2a.length - 400);
    this.emit("a2a", { rec });
    return rec;
  }
  get me() { return this.S.me; }
  info() {
    return { app: "dsh-meeting", version: VERSION, instance: this.instance, team: this.cfg.team, me: this.me,
      nodePort: this.cfg.port, a2a: { port: this.cfg.a2aPort, path: this.cfg.a2aPath } };
  }
  addresses() {
    const ips = this.cfg.advertiseHost ? [{ name: "config", address: this.cfg.advertiseHost }] : lanAddresses();
    return ips.map((a) => ({ ...a, url: `http://${a.address}:${this.cfg.port}/`, code: inviteCode(a.address, this.cfg.port) }));
  }
  snapshot() {
    return {
      me: this.me, persona: this.S.persona, cal: this.S.cal, prefs: this.S.prefs, history: this.S.history, profile: this.S.profile,
      exemptions: this.S.exemptions, openers: this.S.openers, chat: this.S.chat, a2a: this.S.a2a, status: this.S.status,
      asks: Object.values(this.S.asks).filter((a) => !a.answer), roomBook: this.S.roomBook, order: this.S.order, tally: this.S.tally, board: this.S.board,
      peers: Object.values(this.peers).map(this.pubPeer), addresses: this.addresses(), team: this.cfg.team, run: this.S.run,
      seeds: SEEDS.personas.map((p) => ({ id: p.id, group: p.group, groupName: p.groupName, me: p.me })), rooms: SEEDS.rooms,
      directory: this.directory(), dms: this.S.dms, groups: this.S.groups, outbox: this.S.outbox.map((o) => ({ to: o.to, mid: o.mid })),
      ports: { node: this.cfg.port, a2a: this.cfg.a2aPort }, mdns: this.mdnsState || "off", today: E.ymd(new Date()),
    };
  }
  pubPeer = (p) => ({ id: p.id, me: p.me, node: p.node, a2a: p.a2a, online: p.online, via: p.via, lastSeen: p.lastSeen, clash: p.clash });

  setup(body) {
    let next;
    if (body.persona) {
      const p = SEEDS.personas.find((x) => x.id === body.persona);
      if (!p) throw new Error("没有这个示例人物：" + body.persona);
      next = this.blank(clone(p.me));
      Object.assign(next, { cal: clone(p.cal), prefs: clone(p.prefs), history: p.history, openers: p.openers, persona: p.id });
    } else {
      const c = body.custom || {};
      const n = String(c.n || "").trim();
      if (!n) throw new Error("请填名字");
      const id = String(c.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "u" + randomBytes(3).toString("hex");
      next = this.blank({ id, n, r: c.r || "同事", L: +c.L || 3, dept: c.dept || "", up: c.up || null, c: "#9fe3c8", a: n.slice(0, 1) });
      next.history = c.history || "";
      next.openers = ["约同事明天下午开个半小时的会。", "这周末约大家出去玩半天，顺便团一波奶茶～"];
    }
    next.manualPeers = this.S.manualPeers;
    for (const k of Object.keys(this.waiters)) { this.waiters[k]("no"); delete this.waiters[k]; }
    this.S = next;
    this.save();
    this.emit("reset");
    this.onIdentity?.();
  }
  resetRound(reseed) {
    for (const k of Object.keys(this.waiters)) { this.waiters[k]("no"); delete this.waiters[k]; }
    if (reseed && this.S.persona) return this.setup({ persona: this.S.persona });
    Object.assign(this.S, { chat: [], a2a: [], asks: {}, deferred: [], inbound: {}, order: null, tally: null, board: null, run: Date.now().toString(36) });
    this.emit("reset");
  }

  /* ============================== A2A 客户端 ============================== */
  async rpc(url, method, params, who) {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${who} A2A ${method} 失败：${j.error.message}`);
    return j.result;
  }
  // 投递一条文本到某个 dsh-a2a 端点，轮询到任务结束
  async deliver(url, text, contextId, who) {
    const message = { kind: "message", role: "user", messageId: randomUUID(), contextId, parts: [{ kind: "text", text: `${nowTag()} ${text}` }] };
    let task = await this.rpc(url, "message/send", { message, configuration: { blocking: false } }, who);
    const textOf = (m) => (m?.parts || []).filter((p) => (p.kind || "text") === "text" && p.text).map((p) => p.text).join("");
    if (task.kind === "message") return { state: "completed", text: textOf(task) };
    let fails = 0;
    while (!DONE.has(task.status?.state)) {
      await new Promise((r) => setTimeout(r, 800));
      try { task = await this.rpc(url, "tasks/get", { id: task.id }, who); fails = 0; }
      catch (e) { if (++fails > 8) throw e; }
    }
    if (task.status.state === "failed") throw new Error(`${who}的助理执行失败：${textOf(task.status.message) || "unknown"}`);
    return { state: task.status.state, text: textOf(task.status.message) };
  }
  localA2A() { return `http://127.0.0.1:${this.cfg.a2aPort}${this.cfg.a2aPath}`; }
  async deliverLocal(text, contextId) {
    this.localBusy++;
    try { return await this.deliver(this.localA2A(), text, contextId, "本机"); }
    finally { this.localBusy--; this.kickDeferred(); }
  }
  kickDeferred() {
    setTimeout(() => { if (!this.localBusy && !this.inboundBusy && this.S.deferred.length) this.runDeferred(); }, 500);
  }
  async runDeferred() {
    const job = this.S.deferred.shift();
    if (!job) return;
    this.setStatus("🤖 " + job.title, "run");
    try {
      await this.deliverLocal(`【后台任务】${job.instruction}`, `task-${job.id}__${this.me.id}__${this.S.run}`);
      this.setStatus("✓ 已处理", "ok");
    } catch (e) {
      this.chat({ from: "sys", x: "⚠ 后台任务失败：" + e.message });
      this.setStatus("⚠ 出错", "warn");
    }
  }

  /* ============================== 本人 ============================== */
  async ownerSay(text) {
    if (!this.me) throw new Error("先在手机上选好「我是谁」");
    const at = this.parseMentions(text);
    if (at.ids.length) {
      // 「@A@B 说的话」：直接发给这些人（私聊），不经过助理
      this.chat({ from: "me", x: text });
      if (!at.text) { this.chat({ from: "sys", x: "@ 后面写上要说的话" }); return; }
      const r = await this.sendDM(at.ids, at.text);
      const late = r.filter((x) => !x.delivered).map((x) => x.name);
      this.chat({ from: "sys", x: `✉️ 已发给 ${r.map((x) => x.name).join("、")}${late.length ? `（${late.join("、")} 不在线，上线后自动送达）` : ""}，在「💭 消息」里看回复` });
      return;
    }
    this.chat({ from: "me", x: text });
    this.setStatus("🎙 收到指令", "run");
    try {
      const r = await this.deliverLocal(`【本人】${text}`, `owner__${this.me.id}__${this.S.run}`);
      if (r.text?.trim()) this.chat({ from: "bot", x: r.text.trim() });
      this.setStatus("✓ 完成", "ok");
    } catch (e) {
      this.chat({ from: "sys", x: "⚠ " + e.message });
      this.setStatus("⚠ 出错", "warn");
    }
  }
  ownerAnswer(askId, key) {
    const ask = this.S.asks[askId];
    if (!ask) throw new Error("没有这个待决定事项");
    if (ask.answer) return;
    ask.answer = key; ask.at = nowIso();
    const opt = ask.options.find((o) => o.key === key);
    this.chat({ from: "me", x: opt?.label || key, tap: true });
    this.emit("answer", { askId, key });
    this.waiters[askId]?.(key);
    delete this.waiters[askId];
  }

  /* ============================== 局域网同事 ============================== */
  async fetchJson(url, opts = {}) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 4000),
      headers: opts.body ? { "content-type": "application/json" } : undefined });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  }
  // host:port 是对方节点（手机页）的地址；info 是对方 /peer/info 的内容
  upsertPeer(host, info, via) {
    if (!info?.me?.id || info.instance === this.instance) return null;
    if (info.team !== this.cfg.team) return null;
    const id = info.me.id;
    // 同一台电脑换了身份：去掉它的旧条目
    for (const [k, q] of Object.entries(this.peers)) if (q.instance === info.instance && k !== id) delete this.peers[k];
    const prev = this.peers[id];
    const clash = prev && prev.instance !== info.instance && prev.online && prev.host !== host;
    const p = { id, me: info.me, instance: info.instance, host, node: `http://${host}:${info.nodePort}`,
      a2a: `http://${host}:${info.a2a.port}${info.a2a.path}`, online: true, via: prev?.via === "manual" ? "manual" : via, lastSeen: nowIso(), clash: !!clash };
    const changed = !prev || prev.node !== p.node || !prev.online || JSON.stringify(prev.me) !== JSON.stringify(p.me);
    this.peers[id] = p;
    if (this.me && id === this.me.id) p.clash = true;
    if (changed) this.emit("peers", { peers: Object.values(this.peers).map(this.pubPeer) });
    if (changed && this.S.outbox.some((o) => o.to === id)) setTimeout(() => this.flushOutbox().catch(() => {}), 300);
    return p;
  }
  async probe(host, port, via) {
    const info = await this.fetchJson(`http://${host}:${port}/peer/info`);
    const p = this.upsertPeer(host, info, via);
    if (p && this.me) this.fetchJson(`${p.node}/peer/hello`, { method: "POST", body: JSON.stringify(this.info()) }).catch(() => {});
    return p;
  }
  async addManual(address) {
    const { host, port } = parseAddress(address);
    const info = await this.fetchJson(`http://${host}:${port}/peer/info`).catch((e) => { throw new Error(`连不上 ${host}:${port}（${e.cause?.code || e.message}）。检查对方是否已启动、是否同一局域网、防火墙是否放行 ${port} 和 A2A 端口`); });
    if (info.app !== "dsh-meeting") throw new Error("对方不是 dsh-meeting 节点");
    if (info.team !== this.cfg.team) throw new Error(`对方的团队码是「${info.team}」，和本机「${this.cfg.team}」不一致`);
    if (!info.me) throw new Error("对方还没在手机页上选「我是谁」");
    const p = await this.probe(host, port, "manual");
    if (!p) throw new Error("这是本机自己");
    if (!this.S.manualPeers.includes(`${host}:${port}`)) this.S.manualPeers.push(`${host}:${port}`);
    this.save();
    return this.pubPeer(p);
  }
  async heartbeat() {
    for (const p of Object.values(this.peers)) {
      try {
        const info = await this.fetchJson(`${p.node}/peer/info`, { timeout: 3000 });
        if (info.instance !== p.instance || info.me?.id !== p.id) {
          if (p.online) { p.online = false; this.emit("peers", { peers: Object.values(this.peers).map(this.pubPeer) }); }
          this.upsertPeer(p.host, info, p.via);
          continue;
        }
        p.lastSeen = nowIso();
        if (!p.online) { p.online = true; this.emit("peers", { peers: Object.values(this.peers).map(this.pubPeer) }); }
      } catch {
        if (p.online) { p.online = false; this.emit("peers", { peers: Object.values(this.peers).map(this.pubPeer) }); }
      }
    }
    for (const a of this.S.manualPeers) {
      const { host, port } = parseAddress(a);
      if (!Object.values(this.peers).some((p) => p.host === host && p.online)) this.probe(host, port, "manual").catch(() => {});
    }
    this.flushOutbox().catch(() => {});
  }
  startDiscovery() {
    this.hbTimer = setInterval(() => this.heartbeat().catch(() => {}), 15000);
    this.heartbeat().catch(() => {});
    if (!this.cfg.mdns) { this.mdnsState = "off"; return; }
    import("bonjour-service").then(({ Bonjour }) => {
      this.bonjour = new Bonjour();
      this.mdnsState = "on";
      const seen = (svc) => {
        if (process.env.DSH_MEETING_DEBUG) console.error("[dsh-meeting] mdns up", svc.name, svc.port, svc.txt);
        if (svc.txt?.instance === this.instance || svc.txt?.team !== this.cfg.team) return;
        const hosts = [svc.referer?.address, ...(svc.addresses || [])].filter((a) => a && /^\d+\.\d+\.\d+\.\d+$/.test(a));
        (async () => { for (const h of [...new Set(hosts)]) { try { if (await this.probe(h, svc.port, "mdns")) return; } catch (e) { if (process.env.DSH_MEETING_DEBUG) console.error("[dsh-meeting] probe", h, svc.port, e.message); } } })();
      };
      this.browser = this.bonjour.find({ type: "dshmeet" });
      this.browser.on("up", seen);
      this.publish();
      this.rescanT = setInterval(() => { try { this.browser.update(); } catch {} }, 20000);
    }).catch((e) => { this.mdnsState = "error: " + e.message; console.error("[dsh-meeting] mDNS 不可用：", e.message); });
  }
  publish() {
    if (!this.bonjour || !this.me) return;
    try { this.service?.stop?.(); } catch {}
    this.service = this.bonjour.publish({
      name: `dsh-meeting ${this.me?.n || "未设置"} ${this.instance.slice(0, 4)}`, type: "dshmeet", port: this.cfg.port, probe: false,
      txt: { instance: this.instance, team: this.cfg.team, id: this.me?.id || "", a2a: String(this.cfg.a2aPort) },
    });
  }
  onIdentity() {
    this.publish();
    // 告诉已知同事我换了身份
    for (const p of Object.values(this.peers)) this.fetchJson(`${p.node}/peer/hello`, { method: "POST", body: JSON.stringify(this.info()) }).catch(() => {});
  }
  peerOf(id) {
    const p = this.peers[id];
    if (!p) throw new Error(`没有发现同事 ${id}。当前在线：${this.onlinePeers().map((x) => `${x.id}（${x.me.n}）`).join("、") || "无"}`);
    if (!p.online) throw new Error(`${p.me.n}（${id}）的电脑现在不在线`);
    return p;
  }
  onlinePeers() { return Object.values(this.peers).filter((p) => p.online && !p.clash); }
  nameOf(id) { return id === this.me?.id ? this.me.n : this.peers[id]?.me?.n || SEEDS.personas.find((p) => p.id === id)?.me.n || id; }
  // 公司通讯录：示例人物（同一家公司）+ 局域网里发现的自定义身份，带在线状态。本人不在内。
  directory() {
    const out = new Map();
    for (const p of SEEDS.personas) out.set(p.id, { ...p.me });
    for (const p of Object.values(this.peers)) out.set(p.id, { ...out.get(p.id), ...p.me });
    if (this.me) out.delete(this.me.id);
    return [...out.values()].map((m) => ({ ...m, online: !!this.peers[m.id]?.online && !this.peers[m.id]?.clash }));
  }

  /* ============================== 人和人的消息（@ 私聊 / 群聊），不经过助理 ============================== */
  // 「@小美@阿杰 周五记得带伞」→ { ids: [mei, jie], text: "周五记得带伞" }。名字或 id 都行，最长匹配。
  parseMentions(text) {
    const people = this.directory().flatMap((m) => [[m.n, m.id], [m.id, m.id]]).sort((a, b) => b[0].length - a[0].length);
    const ids = [];
    const rest = String(text).replace(/@\s*([^\s@，,：:]+)/g, (all, word) => {
      const hit = people.find(([k]) => word.toLowerCase().startsWith(k.toLowerCase()));
      if (!hit) return all;
      if (!ids.includes(hit[1])) ids.push(hit[1]);
      return word.slice(hit[0].length);
    });
    return { ids, text: rest.replace(/^[\s，,：:]+/, "").trim() };
  }
  // 发给某个同事的节点；对方不在线（或还没发现）就进发件箱，上线后补发
  async postPeer(id, body) {
    const p = this.peers[id];
    if (p?.online && !p.clash) {
      try { await this.fetchJson(`${p.node}/peer/msg`, { method: "POST", body: JSON.stringify({ ...body, sender: this.info() }), timeout: 6000 }); return true; }
      catch { p.online = false; this.emit("peers", { peers: Object.values(this.peers).map(this.pubPeer) }); }
    }
    this.S.outbox.push({ to: id, mid: body.msg?.id, body, t: nowIso() });
    if (this.S.outbox.length > 300) this.S.outbox.splice(0, this.S.outbox.length - 300);
    this.emit("outbox", { outbox: this.S.outbox.map((o) => ({ to: o.to, mid: o.mid })) });
    return false;
  }
  async flushOutbox() {
    if (this.flushing || !this.S.outbox.length) return;
    this.flushing = true;
    try {
      const keep = [];
      for (const o of this.S.outbox) {
        const p = this.peers[o.to];
        if (!p?.online || p.clash) { keep.push(o); continue; }
        try { await this.fetchJson(`${p.node}/peer/msg`, { method: "POST", body: JSON.stringify({ ...o.body, sender: this.info() }), timeout: 6000 }); }
        catch { keep.push(o); }
      }
      if (keep.length !== this.S.outbox.length) { this.S.outbox = keep; this.emit("outbox", { outbox: keep.map((o) => ({ to: o.to, mid: o.mid })) }); }
    } finally { this.flushing = false; }
  }
  dmPush(peerId, msg) {
    const list = (this.S.dms[peerId] ||= []);
    if (list.some((m) => m.id === msg.id)) return false;
    list.push(msg);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.emit("dm", { peer: peerId, msg });
    return true;
  }
  // 私聊：发给一个或多个人（各自一个对话）。byBot = 助理替本人发的
  async sendDM(ids, text, byBot = false) {
    if (!this.me) throw new Error("先选「我是谁」");
    ids = [...new Set(ids)].filter((id) => id && id !== this.me.id);
    if (!ids.length) throw new Error("要发给谁？用 @名字");
    if (!String(text || "").trim()) throw new Error("消息是空的");
    const res = [];
    for (const id of ids) {
      const msg = { id: `${this.me.id}.d${++this.S.seq}.${randomBytes(2).toString("hex")}`, from: this.me.id, to: id, x: String(text).trim(), t: nowIso(), bot: byBot || undefined };
      this.dmPush(id, msg);
      res.push({ to: id, name: this.nameOf(id), delivered: await this.postPeer(id, { kind: "dm", msg }) });
    }
    return res;
  }
  groupMeta(g) { return { id: g.id, name: g.name, owner: g.owner, members: g.members, names: g.names, ver: g.ver }; }
  namesOf(ids) { return Object.fromEntries(ids.map((id) => [id, this.nameOf(id)])); }
  groupSys(g, x) {
    const msg = { id: `${this.me.id}.s${++this.S.seq}.${randomBytes(2).toString("hex")}`, gid: g.id, from: "sys", x, t: nowIso() };
    g.msgs.push(msg);
    return msg;
  }
  async broadcastGroup(g, extra = {}) {
    const res = [];
    for (const id of g.members.filter((x) => x !== this.me.id)) res.push({ to: id, name: this.nameOf(id), delivered: await this.postPeer(id, { kind: "group", meta: this.groupMeta(g), ...extra }) });
    return res;
  }
  async createGroup(name, ids) {
    if (!this.me) throw new Error("先选「我是谁」");
    const members = [this.me.id, ...new Set(ids.filter((x) => x && x !== this.me.id))];
    if (members.length < 2) throw new Error("至少拉一个人进群");
    const g = { id: `g-${this.me.id}-${Date.now().toString(36)}`, name: String(name || "").trim() || members.map((x) => this.nameOf(x)).join("、").slice(0, 20), owner: this.me.id, members, ver: 1, msgs: [], t: nowIso() };
    g.names = this.namesOf(members);
    const sys = this.groupSys(g, `${this.me.n} 创建了群聊，成员：${members.map((x) => g.names[x]).join("、")}`);
    this.S.groups[g.id] = g;
    this.emit("group", { group: g });
    return { group: this.groupMeta(g), sent: await this.broadcastGroup(g, { msg: sys }) };
  }
  async inviteGroup(gid, ids) {
    const g = this.S.groups[gid];
    if (!g) throw new Error("没有这个群");
    const add = [...new Set(ids)].filter((x) => x && !g.members.includes(x));
    if (!add.length) throw new Error("这些人已经在群里了");
    g.members.push(...add); g.ver++; g.names = this.namesOf(g.members);
    const sys = this.groupSys(g, `${this.me.n} 邀请 ${add.map((x) => g.names[x]).join("、")} 加入了群聊`);
    this.emit("group", { group: g });
    return { group: this.groupMeta(g), sent: await this.broadcastGroup(g, { msg: sys }) };
  }
  async leaveGroup(gid) {
    const g = this.S.groups[gid];
    if (!g) return;
    g.members = g.members.filter((x) => x !== this.me.id); g.ver++;
    const sys = this.groupSys(g, `${this.me.n} 退出了群聊`);
    await this.broadcastGroup(g, { msg: sys });
    delete this.S.groups[gid];
    this.emit("group-gone", { gid });
  }
  async sendGroup(gid, text, byBot = false) {
    const g = this.S.groups[gid];
    if (!g) throw new Error(`没有这个群：${gid}。现有群：${Object.values(this.S.groups).map((x) => `${x.id}（${x.name}）`).join("、") || "无"}`);
    if (!String(text || "").trim()) throw new Error("消息是空的");
    const { ids } = this.parseMentions(text);
    const msg = { id: `${this.me.id}.g${++this.S.seq}.${randomBytes(2).toString("hex")}`, gid, from: this.me.id, x: String(text).trim(), t: nowIso(), at: ids.filter((x) => g.members.includes(x)), bot: byBot || undefined };
    g.msgs.push(msg);
    if (g.msgs.length > 500) g.msgs.splice(0, g.msgs.length - 500);
    this.emit("gmsg", { gid, msg });
    return { group: g.name, sent: await this.broadcastGroup(g, { msg }) };
  }
  // 对方节点发来的私聊 / 群消息 / 群成员变化
  onPeerMsg(b, remoteHost) {
    if (!this.me) throw new Error("本机还没选身份");
    if (b.sender?.me?.id) this.upsertPeer(remoteHost, b.sender, this.peers[b.sender.me.id]?.via || "hello");
    if (b.kind === "dm") {
      if (b.msg?.to !== this.me.id) throw new Error("收件人不是本机");
      this.dmPush(b.msg.from, b.msg);
      return { ok: true };
    }
    if (b.kind === "group") {
      const m = b.meta;
      // 自己已不在群里（退群后的回声）：忽略
      if (!m?.members?.includes(this.me.id)) return { ok: true };
      let g = this.S.groups[m.id];
      if (!g) { g = { ...m, msgs: [], t: nowIso() }; this.S.groups[m.id] = g; this.emit("group", { group: g }); }
      else if (m.ver > g.ver) { Object.assign(g, { name: m.name, members: m.members, names: m.names, ver: m.ver }); this.emit("group", { group: g }); }
      if (b.msg && !g.msgs.some((x) => x.id === b.msg.id)) {
        g.msgs.push(b.msg);
        if (g.msgs.length > 500) g.msgs.splice(0, g.msgs.length - 500);
        this.emit("gmsg", { gid: g.id, msg: b.msg });
      }
      return { ok: true };
    }
    throw new Error("看不懂的消息类型 " + b.kind);
  }

  /* ============================== 出站报文 ============================== */
  async sendA2A(a) {
    const me = this.me;
    const to = [...new Set([].concat(a.to || []).map(String).filter((x) => x && x !== me.id))];
    if (!to.length) throw new Error("to 为空");
    if (!TYPES.includes(a.type)) throw new Error("type 必须是 " + TYPES.join("/"));
    const peers = to.map((id) => this.peerOf(id));
    const conv = a.conv || "conv-" + Date.now().toString(36);
    const group = this.logA2A({ dir: "out", conv, from: me.id, to, ty: a.type, x: a.text, p: a.payload || {} });
    this.setStatus(`⏳ 等回复 0/${to.length}`, "wait");
    let got = 0;
    const replies = await Promise.all(peers.map(async (p) => {
      const msgId = `${me.id}.${++this.S.seq}.${randomBytes(2).toString("hex")}`;
      const env = { msg_id: msgId, from: me.id, to: p.id, type: a.type, conv, text: a.text, payload: a.payload || {}, sender: this.info(), reply_port: this.cfg.port };
      const box = { reply: null };
      const replied = new Promise((resolve) => { box.resolve = resolve; });
      this.pending[msgId] = box;
      let reply;
      try {
        await this.fetchJson(`${p.node}/peer/envelope`, { method: "POST", body: JSON.stringify(env) }).catch(() => {});
        const body = `【A2A 来信】
msg_id: ${msgId}
from: agent://${me.id}（${me.n}的助理，${me.r}${me.dept ? "，" + me.dept : ""}，L${me.L}${me.up ? "，上级 " + this.nameOf(me.up) : ""}）
type: ${a.type}
conv: ${conv}
text: ${a.text}
payload: ${JSON.stringify(a.payload || {})}

请按协同规则处理，并调用 reply_a2a（reply_to=${msgId}）回复。`;
        const r = await this.deliver(p.a2a, body, `${conv}__${me.id}-${p.id}__${this.S.run}`, p.me.n);
        // 回复一般在任务结束前就到了；再等一会儿以防网络先后
        reply = box.reply || await Promise.race([replied, new Promise((res) => setTimeout(() => res(null), 5000))]);
        if (!reply) reply = { type: "RCPT", text: (r.text || "（对方未结构化回复）").slice(0, 160), payload: { raw: r.text } };
      } catch (e) {
        reply = { type: "ERROR", text: e.message, payload: {} };
      }
      delete this.pending[msgId];
      got++;
      this.setStatus(got < to.length ? `⏳ 等回复 ${got}/${to.length}` : "🤖 汇总回复", got < to.length ? "wait" : "run");
      this.logA2A({ dir: "in", conv, from: p.id, to: [me.id], ty: reply.type, x: reply.text, p: reply.payload, re: group.id });
      return { from: p.id, name: p.me.n, type: reply.type, text: reply.text, payload: reply.payload };
    }));
    return { conv, replies };
  }

  /* ============================== 入站（对方节点调用） ============================== */
  onEnvelope(env, remoteHost) {
    if (!this.me || env.to !== this.me.id) throw new Error("收件人不是本机");
    if (env.sender) this.upsertPeer(remoteHost, env.sender, this.peers[env.from]?.via || "mdns");
    this.S.inbound[env.msg_id] = { from: env.from, type: env.type, conv: env.conv, replyUrl: `http://${remoteHost}:${env.reply_port}/peer/reply`, t: nowIso() };
    this.inboundBusy++;
    setTimeout(() => { if (this.S.inbound[env.msg_id] && !this.S.inbound[env.msg_id].done) { this.S.inbound[env.msg_id].done = true; this.inboundBusy = Math.max(0, this.inboundBusy - 1); this.kickDeferred(); } }, 15 * 60 * 1000);
    this.logA2A({ dir: "in", conv: env.conv, from: env.from, to: [this.me.id], ty: env.type, x: env.text, p: env.payload });
    this.setStatus(`📥 收到 ${this.nameOf(env.from)} 的 ${env.type}`, "run");
  }
  onReply(r) {
    const box = this.pending[r.msg_id];
    if (!box) return { ok: false, error: "没有在等这条回复（可能已超时）" };
    box.reply = { type: r.type, text: r.text, payload: r.payload || {} };
    box.resolve(box.reply);
    return { ok: true };
  }

  /* ============================== 工具 ============================== */
  findEv(id) {
    const e = this.S.cal.find((x) => x.id === id);
    if (!e) throw new Error(`本人日程里没有 id=${id} 的会。现有：${this.S.cal.map((x) => `${x.id} ${E.dayLabel(x.d)} ${x.s} ${x.t}`).join("；") || "（空）"}`);
    return e;
  }
  pubEv = (e) => ({ id: e.id, date: E.dayLabel(e.d), slot: `${e.s}-${e.e}`, title: e.t, kind: e.k, kind_cn: KIND_CN[e.k],
    organizer: e.org ? this.nameOf(e.org) : undefined, participants: e.who?.map((x) => this.nameOf(x)), room: e.room, note: e.note });
  calChanged() { this.emit("cal", { cal: this.S.cal, prefs: this.S.prefs, exemptions: this.S.exemptions, profile: this.S.profile, roomBook: this.S.roomBook }); }
  datesArg(a) {
    let list = [].concat(a.dates || a.date || []).filter(Boolean);
    if (!list.length) throw new Error("请给 dates，例如 [\"10/22\"] 或 [\"周六\",\"周日\"]");
    return [...new Set(list.flatMap((x) => String(x).split(/[、,，]/)).map((x) => E.normDate(x)))].sort();
  }
  slotArg(a) {
    if (a.slot) return E.parseSlot(a.slot, a.date);
    if (!a.date || !a.start || !a.end) throw new Error("需要 slot（如 10/22(周四) 14:00-15:00），或 date + start + end");
    return { d: E.normDate(a.date), s: E.normTime(a.start), e: E.normTime(a.end) };
  }

  async runTool(name, a) {
    const S = this.S, me = this.me;
    if (!me) throw new Error("本人还没在手机页上选「我是谁」");
    switch (name) {
      case "whoami": {
        const d = new Date();
        return {
          me: { ...me, up: me.up ? `${me.up}（${this.nameOf(me.up)}）` : null }, now: `${E.ymd(d)} ${WD[d.getDay()]} ${E.F(d.getHours() * 60 + d.getMinutes())}`,
          colleagues_online: this.onlinePeers().map((p) => ({ id: p.id, name: p.me.n, role: p.me.r, dept: p.me.dept, level: "L" + p.me.L, up: p.me.up ? this.nameOf(p.me.up) : null })),
          colleagues_offline: Object.values(this.peers).filter((p) => !p.online).map((p) => `${p.id}（${p.me.n}）`),
          company: this.directory().map((m) => `${m.id} ${m.n} ${m.r} · ${m.dept || ""} · L${m.L}${m.up ? " · 上级 " + this.nameOf(m.up) : ""}${m.squad ? " · " + m.squad : ""}${m.online ? "" : " · 不在线"}`),
          groups: Object.values(S.groups).map((g) => ({ id: g.id, name: g.name, members: g.members.map((x) => this.nameOf(x)) })),
          history_available: !!S.history?.trim(), has_profile: !!S.profile,
          hint: "company 是全公司通讯录；只有 colleagues_online 里的人能发 A2A。层级：L 数字越小越高；同 L 是同级；dept 不同是跨部门；squad 是跨部门项目组。to 填同事 id。",
        };
      }
      case "my_calendar":
        return { owner: me.n, events: S.cal.map(this.pubEv), preferences: S.prefs.map(({ id, x, s, e, k }) => ({ id, x, slot: s ? `${s}-${e}` : undefined, kind: k || "行为偏好" })),
          exemptions: S.exemptions.map((x) => ({ slot: E.fmtSlot(x), note: x.note })), history_available: !!S.history?.trim(), profile_saved: !!S.profile };
      case "my_history":
        this.setStatus("📖 读本人记录", "run");
        return { owner: me.n, records: S.history || "（没有记录）" };
      case "my_profile":
        return { profile: S.profile && { ...S.profile, schedule: S.profile.schedule.map((x) => ({ ...x, date: E.dayLabel(x.d) })) } };
      case "save_profile": {
        const schedule = (a.schedule || []).map((x, i) => {
          const sl = x.slot ? E.parseSlot(x.slot, x.date || x.day) : { d: E.normDate(x.date || x.day), s: E.normTime(x.start), e: E.normTime(x.end) };
          if (E.T(sl.e) <= E.T(sl.s)) throw new Error(`第 ${i + 1} 条 ${x.what || ""} 结束时间要晚于开始时间`);
          return { ...sl, what: x.what || "", why: x.why || "", flex: ["hard", "owner_exemptible", "tentative"].includes(x.flex) ? x.flex : "hard" };
        });
        S.profile = { schedule, tea: a.tea || {}, diet: { hard: a.diet?.hard || [], soft: a.diet?.soft || [] }, notes: a.notes || "", t: nowIso() };
        this.calChanged();
        return { saved: true, schedule: schedule.map((x) => `${E.fmtSlot(x)} ${x.what}（${x.flex}）`) };
      }
      case "my_availability":
        return E.availability(S, this.datesArg(a), a.ignore || []);
      case "intersect_availability": {
        const parties = (a.parties || []).filter((p) => p.who && p.who !== me.id).map((p) => ({ ...p, ...(p.payload || {}) }));
        let dates = a.dates ? this.datesArg(a) : E.datesOfSlots(parties.flatMap((p) => [p.available, p.tentative, p.owner_exemptible]));
        if (!dates.length) throw new Error("没法从各方 payload 里看出日期，请给 dates");
        const mine = { who: me.id, ...E.availability(S, dates, a.ignore || []) };
        const r = E.intersect([mine, ...parties], +a.duration_min || 60, dates);
        S.board = { t: nowIso(), dates, board: r._board, common: r.common_slots, relax: r.relax_options };
        this.emit("board", { board: S.board });
        delete r._board;
        return r;
      }
      case "calendar_add": {
        const sl = this.slotArg(a);
        const e = { id: a.id, d: sl.d, s: sl.s, e: sl.e, t: a.title, k: a.kind || "busy", org: a.organizer || me.id, who: a.participants, room: a.room };
        if (!e.id || !e.t) throw new Error("需要 id 和 title");
        const booked = S.roomBook.find((b) => b.mid === a.id);
        if (booked) e.room = booked.room;
        S.cal = S.cal.filter((x) => x.id !== e.id);
        const conflicts = S.cal.filter((x) => x.k !== "bump" && E.overlaps(x, e)).map(this.pubEv);
        S.cal.push(e);
        S.cal.sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s));
        this.calChanged();
        return { written: this.pubEv(e), conflicts, hint: conflicts.length ? "有冲突：按优先级 上级会 > 同级已定会 / 上报会 > 1on1 处理被挤掉的会" : "无冲突" };
      }
      case "calendar_update": {
        const e = this.findEv(a.id);
        if (a.kind) e.k = a.kind;
        if (a.slot || a.start || a.date) {
          const sl = a.slot ? E.parseSlot(a.slot, e.d) : { d: a.date ? E.normDate(a.date) : e.d, s: a.start ? E.normTime(a.start) : e.s, e: a.end ? E.normTime(a.end) : e.e };
          Object.assign(e, { d: sl.d, s: sl.s, e: sl.e });
        }
        if (a.title) e.t = a.title;
        if (a.room) e.room = a.room;
        if (a.note) e.note = a.note;
        S.cal.sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s));
        this.calChanged();
        return { updated: this.pubEv(e) };
      }
      case "calendar_remove": {
        const e = this.findEv(a.id);
        S.cal = S.cal.filter((x) => x.id !== a.id);
        const n = S.roomBook.length;
        S.roomBook = S.roomBook.filter((b) => b.mid !== a.id);
        this.calChanged();
        return { removed: this.pubEv(e), room_released: n !== S.roomBook.length };
      }
      case "grant_exemption": {
        const ok = Object.values(S.asks).some((k) => k.answer && !["no", "expired"].includes(k.answer) && Date.now() - Date.parse(k.at || k.t) < 30 * 60 * 1000);
        if (!ok) throw new Error("本人还没有在手机上同意，不能豁免");
        const sl = this.slotArg(a);
        S.exemptions.push({ ...sl, note: a.note || "" });
        this.calChanged();
        return { exempted: E.fmtSlot(sl), note: a.note };
      }
      case "book_room": {
        const sl = this.slotArg(a), n = +a.attendees || 2;
        S.roomBook = S.roomBook.filter((b) => b.mid !== a.meeting_id);
        const free = [...SEEDS.rooms].filter((r) => r.cap >= n).sort((x, y) => x.cap - y.cap)
          .find((r) => !S.roomBook.some((b) => b.room === r.n && E.overlaps(b, sl)));
        if (!free) return { booked: false, reason: "该时段没有足够大的空会议室" };
        S.roomBook.push({ room: free.n, mid: a.meeting_id, t: a.title, ...sl, by: me.id });
        const ev = S.cal.find((x) => x.id === a.meeting_id);
        if (ev) ev.room = free.n;
        this.calChanged();
        return { booked: true, room: free.n, capacity: free.cap, note: "会议室名写进 CONFIRM / NOTICE 的 payload.room" };
      }
      case "shop_menus":
        return { rule: SEEDS.orderRule, place: SEEDS.place, sugar_levels: SEEDS.sugar, ice_levels: SEEDS.ice, shops: SEEDS.shops };
      case "tally_votes": {
        const ballots = (a.ballots || []).map((b) => ({ ...b, ...(b.payload || {}), who: b.who }));
        const r = E.tally(ballots, SEEDS.shops);
        S.tally = { t: nowIso(), ballots, ...r };
        this.emit("tally", { tally: S.tally });
        return r;
      }
      case "place_order": {
        const shop = SEEDS.shops.find((s) => s.id === String(a.shop || "").trim().toUpperCase()[0] || s.n === a.shop);
        if (!shop) throw new Error("shop 只能是 " + SEEDS.shops.map((s) => s.id).join(" / "));
        const items = (a.items || []).map((it) => ({ who: it.who, name_cn: this.nameOf(it.who), ...E.checkItem(shop, it, SEEDS.sugar, SEEDS.ice) }));
        const free = items.length >= 5;
        S.order = { t: nowIso(), shop: shop.id, shopName: shop.n, deliver_at: a.deliver_at || "", place: a.place || SEEDS.place, items,
          delivery_fee: free ? 0 : 6, total: items.reduce((k, x) => k + x.price, 0) + (free ? 0 : 6) };
        this.emit("order", { order: S.order });
        return { ordered: true, ...S.order, note: free ? "满 5 杯免配送费" : "不满 5 杯，配送费 6 元" };
      }
      case "send_a2a": return this.sendA2A(a);
      case "send_message": {
        const text = String(a.text || "").trim();
        if (a.group) {
          const g = S.groups[a.group] || Object.values(S.groups).find((x) => x.name === a.group);
          if (!g) throw new Error(`没有这个群：${a.group}`);
          return this.sendGroup(g.id, text, true);
        }
        return { sent: await this.sendDM([].concat(a.to || []).map(String), text, true) };
      }
      case "my_messages": {
        const n = Math.min(+a.limit || 20, 100);
        const fmt = (m) => `${m.t.slice(5, 16).replace("T", " ")} ${m.from === "sys" ? "【系统】" : this.nameOf(m.from)}：${m.x}`;
        return {
          direct: Object.entries(S.dms).map(([id, list]) => ({ with: `${id}（${this.nameOf(id)}）`, recent: list.slice(-n).map(fmt) })),
          groups: Object.values(S.groups).map((g) => ({ id: g.id, name: g.name, members: g.members.map((x) => this.nameOf(x)), recent: g.msgs.slice(-n).map(fmt) })),
        };
      }
      case "reply_a2a": {
        const inb = S.inbound[a.reply_to];
        let replyUrl = inb?.replyUrl, from = inb?.from;
        if (!inb) {
          from = String(a.reply_to || "").split(".")[0];
          const p = this.peers[from];
          if (!p) throw new Error(`没有待回复的来信 ${a.reply_to}`);
          replyUrl = `${p.node}/peer/reply`;
        }
        if (inb?.replied) throw new Error("这条来信已经回复过了");
        if (!RTYPES.includes(a.type)) throw new Error("type 必须是 " + RTYPES.join("/"));
        const body = { msg_id: a.reply_to, from: me.id, type: a.type, text: a.text, payload: a.payload || {} };
        const r = await this.fetchJson(replyUrl, { method: "POST", body: JSON.stringify(body), timeout: 10000 });
        if (inb) {
          inb.replied = true;
          if (!inb.done) { inb.done = true; setTimeout(() => { this.inboundBusy = Math.max(0, this.inboundBusy - 1); this.kickDeferred(); }, 4000); }
        }
        this.logA2A({ dir: "out", conv: inb?.conv || "", from: me.id, to: [from], ty: a.type, x: a.text, p: a.payload || {} });
        this.setStatus(`↩ 已回 ${a.type}`, "ok");
        return r.ok ? { ok: true, note: "回复已送达，处理完本条来信后结束本轮即可" } : { ok: false, note: r.error };
      }
      case "ask_owner": {
        const id = "ask" + ++S.seq;
        const ask = { id, t: nowIso(), toast: a.toast, context: a.context, question: a.question, lines: a.lines || [],
          options: a.options?.length ? a.options : [{ key: "yes", label: "同意" }, { key: "no", label: "不同意" }] };
        S.asks[id] = ask;
        this.chat({ from: "bot", kind: "ask", ask });
        const prev = S.status;
        this.setStatus(`👤 等${me.n}决定`, "human");
        const answer = await new Promise((resolve) => { this.waiters[id] = resolve; });
        this.setStatus(prev.cls === "human" ? "🤖 处理中" : prev.x, prev.cls === "human" ? "run" : prev.cls);
        const opt = ask.options.find((o) => o.key === answer);
        return { owner_answer: answer, label: opt?.label || answer };
      }
      case "tell_owner":
        this.chat({ from: "bot", x: a.text, toast: a.toast, card: a.card });
        return { shown: true };
      case "defer_task": {
        const job = { id: "j" + ++S.seq, title: a.title, instruction: a.instruction };
        S.deferred.push(job);
        this.chat({ from: "sys", x: "🗓 助理安排了后台任务：" + a.title });
        return { scheduled: true, note: "会在你回复完当前来信后自动开始" };
      }
    }
    throw new Error("未知工具 " + name);
  }

  /* ============================== HTTP ============================== */
  async listen() {
    const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
    const readBody = (req) => new Promise((res, rej) => {
      const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { try { res(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch (e) { rej(e); } });
    });
    const mcp = mcpHandler(this);
    this.server = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://x");
      const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }); res.end(JSON.stringify(o)); };
      const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      const isLocal = remote === "127.0.0.1" || remote === "::1";
      try {
        if (u.pathname === "/mcp") {
          if (!isLocal) return json({ error: "MCP 只对本机开放" }, 403);
          return mcp(req, res);
        }
        // ---- 对方节点 ----
        if (u.pathname === "/peer/info") return json(this.info());
        if (u.pathname === "/peer/hello" && req.method === "POST") {
          const info = await readBody(req);
          if (info.app === "dsh-meeting") this.upsertPeer(remote, info, this.peers[info.me?.id]?.via || "hello");
          return json(this.info());
        }
        if (u.pathname === "/peer/envelope" && req.method === "POST") { this.onEnvelope(await readBody(req), remote); return json({ ok: true }); }
        if (u.pathname === "/peer/reply" && req.method === "POST") return json(this.onReply(await readBody(req)));
        if (u.pathname === "/peer/msg" && req.method === "POST") return json(this.onPeerMsg(await readBody(req), remote));
        // ---- 手机页 ----
        if (u.pathname === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
          this.clients.add(res);
          const hb = setInterval(() => res.write(": hb\n\n"), 15000);
          req.on("close", () => { this.clients.delete(res); clearInterval(hb); });
          return;
        }
        if (u.pathname === "/api/state") return json(this.snapshot());
        if (req.method === "POST") {
          const b = await readBody(req);
          switch (u.pathname) {
            case "/api/setup": this.setup(b); return json({ ok: true });
            case "/api/say": if (!b.text) return json({ error: "空消息" }, 400); if (!this.me) return json({ error: "先选「我是谁」" }, 400); this.ownerSay(b.text); return json({ ok: true });
            case "/api/answer": this.ownerAnswer(b.askId, b.key); return json({ ok: true });
            case "/api/dm": return json({ ok: true, sent: await this.sendDM([].concat(b.to || []), b.text) });
            case "/api/group/create": return json({ ok: true, ...(await this.createGroup(b.name, [].concat(b.members || []))) });
            case "/api/group/invite": return json({ ok: true, ...(await this.inviteGroup(b.gid, [].concat(b.members || []))) });
            case "/api/group/leave": await this.leaveGroup(b.gid); return json({ ok: true });
            case "/api/group/send": return json({ ok: true, ...(await this.sendGroup(b.gid, b.text)) });
            case "/api/reset": this.resetRound(!!b.reseed); return json({ ok: true });
            case "/api/peers/add": return json({ ok: true, peer: await this.addManual(b.address) });
            case "/api/peers/forget": this.S.manualPeers = this.S.manualPeers.filter((x) => !x.startsWith(this.peers[b.id]?.host + ":")); delete this.peers[b.id]; this.emit("peers", { peers: Object.values(this.peers).map(this.pubPeer) }); return json({ ok: true });
            case "/api/history": this.S.history = String(b.text || ""); this.S.profile = null; this.calChanged(); return json({ ok: true });
            case "/api/cal/add": { const sl = this.slotArg(b); this.S.cal.push({ id: "m" + ++this.S.seq, ...sl, t: b.title || "忙", k: "busy", org: this.me?.id }); this.S.cal.sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s)); this.calChanged(); return json({ ok: true }); }
            case "/api/cal/remove": this.S.cal = this.S.cal.filter((x) => x.id !== b.id); this.calChanged(); return json({ ok: true });
          }
        }
        // 静态文件
        const p = u.pathname === "/" ? "/index.html" : u.pathname;
        const file = path.join(WEB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
        if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
          return fs.createReadStream(file).pipe(res);
        }
        json({ error: "not found" }, 404);
      } catch (e) {
        json({ error: e.message }, 500);
      }
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.timeout = 0;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.cfg.port, this.cfg.host, resolve); });
    const addr = this.addresses()[0];
    console.log(`[dsh-meeting] 手机页 http://127.0.0.1:${this.cfg.port}/${addr ? `  局域网 ${addr.url}  邀请码 ${addr.code}` : ""}`);
  }
  async start() { await this.listen(); this.startDiscovery(); }
  async stop() {
    clearInterval(this.hbTimer); clearInterval(this.rescanT);
    for (const k of Object.keys(this.waiters)) { this.waiters[k]("no"); delete this.waiters[k]; }
    for (const res of this.clients) res.end();
    try { this.service?.stop?.(); } catch {}
    await new Promise((r) => { try { this.bonjour ? this.bonjour.unpublishAll(() => { this.bonjour.destroy(); r(); }) : r(); } catch { r(); } });
    this.server?.closeAllConnections?.();
    await new Promise((r) => this.server ? this.server.close(() => r()) : r());
    clearTimeout(this._saveT);
    try { fs.writeFileSync(this.file, JSON.stringify(this.S)); } catch {}
  }
}
