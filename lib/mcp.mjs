// 本机 MCP 服务器（Streamable HTTP，只对 127.0.0.1 开放），挂进 dsh 的 agent preset。
// tools/call 一律用 SSE 回包并定时发心跳：ask_owner / send_a2a 可能要等本人点按钮或对方协商好几分钟，
// 不能被 HTTP 客户端的 300 秒超时打断。
const str = (d) => ({ type: "string", description: d });
const strs = (d) => ({ type: "array", items: { type: "string" }, description: d });
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });
const SLOT = "时段，带日期，如 10/22(周四) 14:00-15:00";
const KINDS = ["lead", "peer", "up", "one", "hold", "busy", "bump"];
const pick = obj({ item_id: str("菜单里的饮品 id，如 A3"), sugar: str("糖度"), ice: str("冰量"), mods: strs("如 换燕麦奶、去芝士") });

export const TOOLS = [
  { name: "whoami", description: "本人是谁（姓名、职位、部门、层级 L、上级）、现在时间、局域网里在线的同事（id、名字、职位、部门、层级）、全公司通讯录、本人所在的群。每轮开始先调一次。", inputSchema: obj({}) },
  { name: "my_calendar", description: "查看本人的日程（含日期、会议名、类型、发起人、参会人、会议室）、结构化偏好和已同意的豁免。只有你能看。", inputSchema: obj({}) },
  { name: "my_history", description: "读取本人手机里的原始记录（聊天、备忘、日历、订单、体检备注）。只有你能读。", inputSchema: obj({}) },
  { name: "my_profile", description: "读取你之前替本人存的偏好档案（没有则 profile 为 null）。", inputSchema: obj({}) },
  { name: "save_profile", description: "把你从本人原始记录里提取的偏好存档（会显示在本人手机上）。整份覆盖。",
    inputSchema: obj({
      schedule: { type: "array", description: "本人没空 / 不方便的时段", items: obj({ date: str("10/24 或 周六"), start: str("HH:MM"), end: str("HH:MM"), what: str("干什么"), why: str("从哪条记录看出来的"),
        flex: { type: "string", enum: ["hard", "owner_exemptible", "tentative"], description: "hard 走不开 / owner_exemptible 本人点头才能让 / tentative 勉强、可改" } }, ["date", "start", "end", "flex"]) },
      tea: obj({ likes: strs(""), dislikes: strs(""), usual: str("常点的饮品和糖冰习惯") }),
      diet: obj({ hard: strs("绝对不能碰"), soft: strs("不喜欢但能将就") }), notes: str("其他值得记住的"),
    }, ["schedule", "tea", "diet"]) },
  { name: "my_availability", description: "按本人日程 + 偏好 + 档案算出可对外公布的忙闲（available 可用 / tentative 勉强 / owner_exemptible 仅本人可豁免），不含原因。回 SYN-ACK 时把结果原样作为 payload。",
    inputSchema: obj({ dates: strs("要算的日期，如 [\"10/22\"] 或 [\"周六\",\"周日\"]"), duration_min: { type: "number" }, ignore: strs("不计为忙的会议 id：只填被挤掉、正在重约的旧会") }, ["dates"]) },
  { name: "intersect_availability", description: "发起方求交：传入各方 SYN-ACK 的 payload（会自动加上你自己的忙闲），返回 ≥ duration 的共同时段；为空时返回代价最小的松绑方案 relax_options 和少一个人的方案 without_one_options。",
    inputSchema: obj({ duration_min: { type: "number" }, dates: strs("可选；不填就从各方 payload 里看"), ignore: strs("计算你自己的忙闲时忽略的会议 id"),
      parties: { type: "array", items: obj({ who: str("对方 id"), available: strs(""), tentative: strs(""), owner_exemptible: strs("") }) } }, ["duration_min", "parties"]) },
  { name: "calendar_add", description: "在本人日程里写入一场会 / 活动（同 id 覆盖），返回与之重叠的已有日程（冲突）。",
    inputSchema: obj({ id: str("会议 id，如 joint / bud / outing"), title: str("名称"), slot: str(SLOT), date: str("或分开写：日期"), start: str("HH:MM"), end: str("HH:MM"),
      kind: { type: "string", enum: KINDS }, organizer: str("发起人 id"), participants: strs("参会人 id"), room: str("会议室 / 地点") }, ["id", "title", "kind"]) },
  { name: "calendar_update", description: "修改本人日程里的一场会：改类型（如 bump / peer）、改时间（顺延）、补会议室。",
    inputSchema: obj({ id: str("会议 id"), kind: { type: "string", enum: KINDS }, slot: str(SLOT), date: str(""), start: str("HH:MM"), end: str("HH:MM"), title: str(""), room: str(""), note: str("备注") }, ["id"]) },
  { name: "calendar_remove", description: "从本人日程删除一场会（本机订的会议室一并释放）。", inputSchema: obj({ id: str("会议 id") }, ["id"]) },
  { name: "grant_exemption", description: "本人已在手机上同意后，把本人某个「仅本人可豁免」的时段让出来（偏好里的或档案里的都行）。没有本人同意会被拒绝。",
    inputSchema: obj({ slot: str("让出的时段，" + SLOT), note: str("补救安排 / 说明") }, ["slot", "note"]) },
  { name: "book_room", description: "为一场已定的会订会议室（按人数挑最小的空闲会议室）。", inputSchema: obj({ meeting_id: str(""), title: str(""), slot: str(SLOT), attendees: { type: "number" } }, ["meeting_id", "title", "slot", "attendees"]) },
  { name: "shop_menus", description: "查看两家奶茶店的菜单（成分 contains、可换燕麦奶 / 可去芝士等选项）和团单规则。", inputSchema: obj({}) },
  { name: "tally_votes", description: "发起方计票：传入所有人的选票（含你自己的），被否决的店先排除，再按总分；平票需本人拍板。",
    inputSchema: obj({ ballots: { type: "array", items: obj({ who: str("id"), scores: obj({ A: { type: "number" }, B: { type: "number" } }), veto: strs(""), picks: obj({ A: pick, B: pick }) }, ["who", "scores"]) } }, ["ballots"]) },
  { name: "place_order", description: "发起方下团单：一家店，每人一杯（会校验菜单和选项）。",
    inputSchema: obj({ shop: str("A 或 B"), deliver_at: str("如 10/24(周六) 13:00"), place: str("送达地点"), items: { type: "array", items: obj({ who: str("id"), ...pick.properties }, ["who", "item_id"]) } }, ["shop", "items"]) },
  { name: "send_a2a", description: "给一个或多个同事的助理发 A2A 报文（直接发到对方电脑上的 dsh），并行投递，等所有人用 reply_a2a 回复后一起返回各自的回复。",
    inputSchema: obj({ to: strs("同事 id（whoami 里的 colleagues_online）"), type: { type: "string", enum: ["NOTICE", "SYN", "PROPOSE", "RELAX", "CONFIRM", "REPORT", "VOTE"] },
      conv: str("会话 id，如 conv-joint、conv-time、conv-tea"), text: str("一句话摘要，会显示在双方手机上"), payload: { type: "object", description: "结构化报文体" } }, ["to", "type", "conv", "text"]) },
  { name: "send_message", description: "替本人给同事发一条普通消息（不是协商报文）：to 填一个或多个同事 id 是私聊；group 填群 id 或群名是发到群里。对方不在线时上线后自动送达。只在本人让你转告、或群里需要你替本人说话时用。",
    inputSchema: obj({ to: strs("同事 id（company 通讯录里的 id）"), group: str("群 id 或群名（whoami 的 groups）"), text: str("消息内容") }, ["text"]) },
  { name: "my_messages", description: "读本人和同事的私聊、本人所在群聊的最近消息（本人问「谁找我了」「群里在聊什么」时用）。", inputSchema: obj({ limit: { type: "number", description: "每个对话最多几条，默认 20" } }) },
  { name: "reply_a2a", description: "回复一条收到的 A2A 来信（每条来信必须回复一次）。",
    inputSchema: obj({ reply_to: str("来信的 msg_id"), type: { type: "string", enum: ["RCPT", "SYN-ACK", "ACK", "DECIDE", "BALLOT"] }, text: str("一句话摘要"), payload: { type: "object" } }, ["reply_to", "type", "text"]) },
  { name: "ask_owner", description: "在本人手机上弹出决定卡片并等待本人点选（会一直等到本人点）。用于突破本人偏好、替本人拍板、本人要求确认的邀请等关键节点。",
    inputSchema: obj({ toast: str("通知横幅标题，如：🍱 需要你决定"), context: str("给本人的一段说明"), question: str("卡片标题"), lines: strs("要点，每条一行"),
      options: { type: "array", items: obj({ key: str("yes / no 等"), label: str("按钮文字") }) } }, ["question", "options"]) },
  { name: "tell_owner", description: "在本人手机上发一条助理消息（可带通知横幅和卡片）。",
    inputSchema: obj({ text: str("消息正文"), toast: str("通知横幅标题（可选）"), card: obj({ title: str(""), when: str(""), who: str(""), room: str("会议室 / 地点"), note: str("") }) }, ["text"]) },
  { name: "defer_task", description: "给自己安排一个后台任务：当前这条来信回复完以后，再以【后台任务】的身份执行（例如重新协商被挤掉的会）。",
    inputSchema: obj({ title: str("短标题"), instruction: str("要做什么，写清楚会议 id、名称、时长、日期、参会人、原因") }, ["title", "instruction"]) },
];

export function mcpHandler(node) {
  const readBody = (req) => new Promise((res, rej) => {
    const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { try { res(c.length ? JSON.parse(Buffer.concat(c)) : null); } catch (e) { rej(e); } });
  });
  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const callOne = async (msg) => {
    const { id, method, params } = msg;
    if (method === "initialize")
      return ok(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "dsh-meeting", version: "0.1.0" } });
    if (method === "tools/list") return ok(id, { tools: TOOLS });
    if (method === "ping") return ok(id, {});
    if (method === "tools/call") {
      node.emit("tool", { name: params.name, args: params.arguments });
      try {
        const r = await node.runTool(params.name, params.arguments || {});
        return ok(id, { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 1) }], isError: false });
      } catch (e) {
        node.emit("tool-error", { name: params.name, error: e.message });
        return ok(id, { content: [{ type: "text", text: "错误：" + e.message }], isError: true });
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `未知方法 ${method}` } };
  };
  return async (req, res) => {
    if (req.method === "GET") { res.writeHead(405, { allow: "POST" }); return res.end(); }
    if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    let body;
    try { body = await readBody(req); } catch { res.writeHead(400); return res.end(); }
    const list = Array.isArray(body) ? body : [body];
    const calls = list.filter((m) => m && m.id !== undefined && m.method);
    if (!calls.length) { res.writeHead(202); return res.end(); } // 通知 / 响应
    const hasTool = calls.some((m) => m.method === "tools/call");
    if (!hasTool) {
      const out = await Promise.all(calls.map(callOne));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const hb = setInterval(() => res.write(": hb\n\n"), 15000);
    req.on("close", () => clearInterval(hb));
    const out = await Promise.all(calls.map(callOne));
    clearInterval(hb);
    for (const m of out) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    res.end();
  };
}
