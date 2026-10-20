#!/usr/bin/env node
// 把两个 demo 的人物数据合并成一家公司，转成插件自带的种子（lib/seeds.json）。只读 ../hub/data.mjs 和 ../outing/data.mjs，不改它们。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "../../hub/data.mjs";
import * as O from "../../outing/data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personas = [];

// 两个 demo 的人合并成一家公司（13 人）：会议室 demo 的 8 人补上奶茶口味 / 忌口 / 周末安排（原始记录），
// 团建 demo 的 5 人补上部门、上级、工作日日程和午饭偏好。周四 10/22 排会，这周末 10/24-25 团建。
const cal2 = M.SCENES[1].cal;
const meetOpeners = {
  li: ["约刘经理、赵经理开个双十一联合方案会，周四，一小时，越早越好。", "约刘经理周四开个一小时的双十一联合方案会，越早越好。"],
  chen: [M.SCENES[0].opener.chen, M.OPENER.chen],
  wang: [M.SCENES[2].opener.wang],
};
const SQUAD = "九派App项目组";
// 会议室 demo 8 人的原始记录：只写和周末、奶茶有关的，助理需要时自己提取（save_profile）
const MEET_HISTORY = {
  chen: `[体检报告 · 9/28 医生备注]
空腹血糖偏高，饮品一律无糖，少喝含糖饮料。

[秘书备忘 · 10/19]
陈总周六 07:00–12:00 和客户打高尔夫（可以改期，但要陈总本人点头）
陈总周日全天陪家人，不安排工作

[微信 · 秘书 · 10/16]
秘书：下午茶给您点什么？
我：老样子，茉莉纯茶，无糖去冰。奶茶太甜，不碰。`,
  li: `[微信 · 客户王总 · 10/17]
王总：周六上午来我们厂里看看样品？
我：好，周六 9 点到 12 点我过去

[外卖记录]
奶茶研究所 · 原味奶茶（七分糖 · 正常冰）× 9 次
鲜果茶铺 · 满杯红柚 × 1 次（评价：太酸）

[微信 · 小王 · 10/14]
小王：经理喝什么？
我：原味奶茶七分糖，水果茶不爱喝`,
  liu: `[体检备注]
乳糖不耐受：鲜牛奶一喝就闹肚子，奶茶只能换燕麦奶。

[日历]
周日 15:00–17:00 带孩子上游泳课（已交学费）
周六 晚上 18:00 以后家庭聚餐

[外卖记录]
奶茶研究所 · 燕麦乌龙（五分糖 · 少冰）× 7 次`,
  zhao: `[日历]
周六 09:00–11:30 孩子足球课（我送，不能缺）
周日 10:00–12:00 家里装修师傅上门（换个时间也行）

[微信 · 老婆 · 10/15]
老婆：给你带杯奶茶？
我：芒芒甘露，正常糖去冰，别的都太腻了

[外卖记录]
鲜果茶铺 · 芒芒甘露（正常冰 · 全糖）× 5 次`,
  wang: `[外卖记录]
奶茶研究所 · 芋泥波波奶茶（全糖 · 正常冰）× 12 次

[微信 · 小张 · 10/18]
小张：周末干嘛
我：躺平，哪都不去，有活动叫我就行

[备忘录]
周日 20:00 以后要准备周一的客户报价，不想太晚回家`,
  zhang: `[医院 · 心内科 · 10/9 医嘱]
近期心悸，不要喝含咖啡因的饮品（茶、咖啡、奶茶都算）。

[外卖记录]
鲜果茶铺 · 芒芒甘露（少糖 · 去冰）× 4 次
奶茶研究所 · 芋泥牛奶（三分糖）× 3 次

[日历]
周六 14:00–17:00 驾校练车（可以跟教练改约）`,
  zhou: `[微信 · 球友 · 10/17]
球友：周六下午 3 点羽毛球？
我：先算我一个，有事再说

[外卖记录]
鲜果茶铺 · 满杯红柚（三分糖 · 少冰）× 8 次

[备忘录]
不爱喝奶：奶茶喝完嗓子黏，能不点就不点`,
  lin: `[过敏记录]
芒果过敏，碰到嘴唇就肿。

[外卖记录]
鲜果茶铺 · 多肉葡萄（去芝士 · 五分糖 · 少冰）× 6 次

[日历]
周日 09:00–12:00 线上考试（已报名，不能缺）`,
};
for (const id of M.IDS) {
  const p = M.PEOPLE[id];
  personas.push({
    id, group: p.dept, groupName: p.dept,
    me: { id, n: p.n, r: p.r, L: p.L, dept: p.dept, up: p.up || null, c: p.c, a: p.a },
    cal: (cal2[id] || []).map(({ room, ...e }) => ({ ...e, d: M.DATE, room: room ? M.ROOMS.find((r) => r.id === room)?.n : undefined })),
    prefs: (M.PREF0[id] || []).map((x) => ({ ...x, days: "weekday" })),
    history: MEET_HISTORY[id] || "",
    openers: [...(meetOpeners[id] || []), "这周末约大家出去玩半天，顺便团一波奶茶～"].slice(0, 3),
  });
}
// 团建 demo 5 人：公司里的岗位、上级、周四的工作日程（偏好仍由助理从原始记录提取）
const outId = (id) => (id === "zhou" ? "laozhou" : id);
const OUT_ORG = {
  mei: { dept: "产品部", up: "liu", cal: [["m-rev", "10:00", "11:00", "需求评审"], ["m-ui", "15:00", "16:00", "和 Kiki 过设计稿"]] },
  kiki: { dept: "产品部", up: "liu", cal: [["k-ui", "15:00", "16:00", "和小美过设计稿"]] },
  jie: { dept: "研发部", up: "zhao", cal: [["j-cr", "14:00", "15:00", "前端 Code Review"]] },
  yu: { dept: "研发部", up: "zhao", cal: [["y-ol", "16:00", "17:00", "接口联调"]] },
  zhou: { dept: "研发部", up: "zhao", cal: [["z-qa", "10:30", "11:30", "回归测试"]] },
};
for (const id of O.IDS) {
  const p = O.PEOPLE[id], org = OUT_ORG[id];
  personas.push({
    id: outId(id), group: org.dept, groupName: org.dept,
    me: { id: outId(id), n: p.n, r: p.r.replace(/ · 团建发起人$/, ""), L: 3, dept: org.dept, up: org.up, squad: SQUAD, c: p.c, a: p.a },
    cal: org.cal.map(([eid, s, e, t]) => ({ id: eid, d: M.DATE, s, e, t, k: "busy" })),
    prefs: [{ id: "lunch", x: "12:00–13:00 午饭", s: "12:00", e: "13:00", k: "hard", days: "weekday" }],
    history: O.HISTORY[id].replaceAll("产品组群", SQUAD + "群"),
    openers: id === "mei" ? ["这周末拉项目组的人（阿杰、小雨、老周、Kiki）去奥森骑行野餐，三个小时左右，顺便团一波奶茶，帮我约一下大家～", "约刘经理周四下午开半小时会，过一下需求评审结论。"] : [],
  });
}
// 部门顺序：总经办、销售部、产品部、研发部
const ORDER = ["总经办", "销售部", "产品部", "研发部"];
personas.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || a.me.L - b.me.L);
const seeds = {
  personas, squad: SQUAD,
  rooms: M.ROOMS.map((r) => ({ n: r.n, cap: r.cap })),
  shops: O.SHOPS, sugar: O.SUGAR, ice: O.ICE, orderRule: O.ORDER_RULE.replace("满 5 杯免配送费；", "满 5 杯免配送费（不满加 6 元）；"), place: O.PLACE,
};
fs.writeFileSync(path.join(ROOT, "lib", "seeds.json"), JSON.stringify(seeds, null, 1));
console.log("wrote lib/seeds.json:", personas.map((p) => p.id).join(" "));
