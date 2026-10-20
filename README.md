# dsh-meeting · 九派私人助理（局域网多智能体约会议 / 团建）

DeepSeek Harness（dsh）插件。**每个人在自己的电脑上跑一个 dsh 助理**，同一局域网里的助理自动发现彼此，用 A2A 协商排会、约周末团建、投票点奶茶；每台电脑有自己的手机页，本人在上面说话、点「同意 / 不同意」。人和人之间还能 @ 私聊、建群聊。

> ⚠️ **没有鉴权，只在可信的局域网里用。** 插件会在局域网上监听 4500（手机页 / 节点）和 41500（A2A）端口，同一网络里的任何人都能打开你的手机页、给你的助理发报文和消息。团队码只防串台，不是密码。

## 快速安装（DSH 网页版 / 桌面版）

1. DSH 左侧栏 **插件 → 添加插件**，填下面任意一个，点安装，再点「立即启用」：
   - npm 包名：`@maximehu97/dsh-meeting`
   - 或安装包链接：`https://github.com/maximehu97/dsh-meeting/releases/latest/download/dsh-meeting.tgz`
   - 命令行：`dsh plugin --profile web add @maximehu97/dsh-meeting`
2. 重启 DSH，左侧栏出现「📅 约会议」。第一次打开选「我是谁」（公司里的 13 个示例人物之一，或自己填），每台电脑选不同的人。
3. 助理用这个 profile 的默认模型：先在 DSH 里登录 DeepSeek 账号或配好 API Key。
4. macOS 第一次弹「允许 node 接受传入网络连接」时点允许。

更新：插件页卸载旧版再装新版（本人数据在 `~/.dsh-meeting`，卸载不会删）。旧版包名叫 `dsh-meeting`（本地 tgz），先卸掉它再装 `@maximehu97/dsh-meeting`。

## 架构

```
 电脑 A（李经理）                                           电脑 B（刘经理）
 手机页 http://A:4500/ ◄─SSE/REST─┐                ┌─SSE/REST─► 手机页 http://B:4500/
                                  │                │
            dsh-meeting 本机节点 :4500             dsh-meeting 本机节点 :4500
   本人数据 / MCP 工具 / 出站 A2A / mDNS ◄── mDNS _dshmeet._tcp ──► 同左
        ▲ MCP (127.0.0.1:4500/mcp)  │                │  ▲
        │                           │ ① /peer/envelope（让对方手机显示来信、记下回信地址）
   dsh 助理（preset meeting）       │ ② A2A message/send + tasks/get ──► :41500/a2a  @amaster.ai/dsh-a2a ──► dsh 助理
   @amaster.ai/dsh-a2a :41500  ◄────┘ ③ 对方助理调 reply_a2a → POST A:4500/peer/reply（结构化回复）
```

- 一个 dsh 进程里有三样东西（都由本插件的 bundle patch 插入）：本机节点 `dsh-meeting`、助理 preset `meeting`（persona = 合并后的私人助理提示词，工具 = 本机节点的 MCP 工具，没有 bash / 文件工具）、入站 A2A `@amaster.ai/dsh-a2a`（监听 0.0.0.0:41500）。
- **出站 A2A**：`@amaster.ai/dsh-a2a` 只收不发，所以出站由节点代发：助理调 `send_a2a` → 节点直接向对方电脑的 dsh-a2a 发 A2A JSON-RPC（`message/send` 非阻塞 + `tasks/get` 轮询），对方助理处理完调 `reply_a2a`，对方节点把结构化回复 POST 回发起方节点。和原 demo 中枢的路由方式一样，只是没有中枢了。
- **局域网发现**：默认 mDNS / Bonjour（服务类型 `_dshmeet._tcp`，同一团队码 `team` 才互认），每 15 秒心跳一次。路由器屏蔽组播（很多公司 / 酒店 Wi‑Fi、手机热点）时，在手机页 👥 页手动填对方的 IP、`IP:端口` 或邀请码（`C0A8-89CE` = 192.168.137.206 的十六进制），加一次双方就都记住了。
- **隐私**：每个助理只能读写本机本人的数据；对外只给「可用 / 勉强 / 本人可豁免」三类时段，不给原因。
- **本人确认**：`ask_owner` 在本人手机页弹卡片并一直等；`grant_exemption` 在本人 30 分钟内没点过同意时会被拒绝。

## DSH 界面入口

装好后 DSH 网页（`./start.sh` 时是 http://127.0.0.1:3500/ ，带 token 的完整地址在 `~/.dsh-meeting/dsh.log`）左侧栏会多一个「📅 约会议」，点开就是本机的约会议页面（嵌在主区里，右上角可以改端口或在新窗口打开）。

插件也可以直接装进你平时用的 profile（网页版 `web` 或桌面版），比如插件市场一键安装，或 `dsh plugin --profile web add <包>`：它只插入自己的三个条目（本机节点 `meeting`、助理 preset `meeting`、入站 A2A `meeting-a2a`），不改那个 profile 的模型和会话目录。重启 DSH 后侧栏就有「约会议」。注意那个 profile 的默认模型要能用。

## 用安装包装进独立 profile（不用 DSH 界面时）

需要：macOS 或 Linux，Node.js ≥ 20.19（建议 22）。插件的依赖（@amaster.ai/dsh-a2a、bonjour-service 等）已经打包在 tgz 里；只有这台电脑还没装 pnpm / dsh 时才需要联网（`npm i -g pnpm @deepseek-ai/dsh`）。Windows 没有现成脚本，可以在 WSL 里跑，或者照 `install.sh` 里的几条命令手动执行（建 profile → `dsh plugin --profile meeting add file:<tgz 路径>` → 把 `@maximehu97/dsh-meeting` 加进 bundles → `dsh --profile meeting --no-open --port 3500`）。

```bash
unzip dsh-meeting-kit-0.2.0.zip && cd dsh-meeting-kit-0.2.0
./install.sh        # 没装 pnpm / dsh 会自动 npm -g 装；新建 profile「meeting」并装插件
```

模型默认是 `deepseek-account / deepseek-flash`，用这台电脑上 dsh 登录的 DeepSeek 账号：没登录过的话，先跑一次 `dsh web` 在网页里登录（或打开 DeepSeek Harness 桌面版登录），再回来。想用 API Key：把 `~/.dsh/profiles/meeting/cordis.patch.yml` 改成

```yaml
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
```

并在启动前 `export DEEPSEEK_API_KEY=sk-...`。

## 运行

```bash
./start.sh          # 后台启动 dsh（profile meeting），就绪后打开 http://127.0.0.1:4500/
./stop.sh
```

1. 手机页第一次打开会问「我是谁」：选公司里的一个人（自带日程 / 偏好 / 聊天记录），或者自己填。每台电脑选不同的人。之后想换：🧠 记住的 → 换身份。
2. 等 👥 页出现同事（或手动加 IP / 邀请码）。
3. 在发起人的手机页点示例指令，或者用自己的话说。真正的手机也能打开 `http://<这台电脑的 IP>:4500/`（同一 Wi‑Fi）。

### 一家公司，13 个人

两个 demo 的人合并成了一家公司：总经办（陈总）、销售部（李经理、小王、小张、小周）、产品部（刘经理、小林、小美、Kiki）、研发部（赵经理、阿杰、小雨、老周）。小美、Kiki、阿杰、小雨、老周同属跨部门的「九派App项目组」。每个人都有工作日日程和原始记录（奶茶口味、忌口、周末安排），谁都可以约会、约团建、投票点奶茶。👥 页的「公司通讯录」列出所有人和在线状态。

### 人和人直接聊：@ 和群聊

- **@**：在助理页输入「@小美 周五记得带伞」，这句话直接发给小美本人，不经过助理；「@小美@阿杰 …」就是同时发给两个人。输入 @ 会弹出选人列表。
- **💭 消息**：私聊和群聊都在这里，有未读角标。私聊也可以在 👥 通讯录里点「私聊」开始。
- **群聊**：💭 消息 → 新建群聊，勾选要拉的人；群里任何人都能「＋拉人」，也可以退出。群里 @某人 会提醒他。
- 对方不在线时消息先存在本机，对方上线后自动补发（显示「⏳ 上线后送达」）。
- 助理也能用：对助理说「帮我跟刘经理说一声我晚到十分钟」「群里大家在聊什么」，它会用 send_message / my_messages。

两台电脑的推荐剧本：

| 剧本 | 电脑 A（发起） | 电脑 B | 看点 |
|---|---|---|---|
| 同级三次握手 | 李经理：「约刘经理周四开个一小时的双十一联合方案会，越早越好。」 | 刘经理 | SYN → SYN-ACK（午休不外露）→ PROPOSE → 刘经理手机弹「跨部门会议，要接吗？」→ ACK → 订会议室 → CONFIRM |
| 自上而下 | 陈总：「周四下午三点，三位经理开个经营分析会，一小时。」 | 刘经理（+ 其他经理） | NOTICE → 刘经理的助理发现撞上 1on1，按偏好顺延 |
| 团建 + 奶茶 | 小美：「这周末拉组里的人去奥森骑行野餐…」 | 小雨（+ 阿杰 / 老周 / Kiki） | 各自读原始记录提取档案 → 求交 → 向小雨 RELAX，小雨手机弹卡片 → 投票 → 下单 |

## 端口与防火墙

| 端口 | 谁用 | 要对局域网开放 |
|---|---|---|
| 4500 | 本机节点：手机页、`/peer/*`（同事节点之间）、`/mcp`（只接受 127.0.0.1） | 是 |
| 41500 | 入站 A2A（@amaster.ai/dsh-a2a） | 是 |
| 5353/UDP | mDNS 组播 | 是（自动发现用；不通就手动加 IP） |
| 3500 | dsh 自己的调试网页（只在 127.0.0.1） | 否 |

macOS 第一次启动时如果弹「允许 node 接受传入网络连接」，点允许；开了「阻止所有传入连接」或第三方防火墙时，要放行 node。Linux 用 ufw：`sudo ufw allow 4500,41500/tcp && sudo ufw allow 5353/udp`。

**没有鉴权**：任何同一局域网的人都能打开你的手机页、给你的助理发报文。只在可信的局域网里用；团队码只是防串台，不是密码。

## 改配置

dsh 的 patch 按 id 整份替换 config，改端口要同时改三处（节点、preset 里 MCP 的 url、A2A 端口）。`start.sh` 已经包好了：

```bash
DSH_MEETING_PORT=4600 ./start.sh                  # 手机页 4600、A2A 41600、数据 ~/.dsh-meeting-4600
DSH_MEETING_TEAM=myteam ./start.sh                # 换团队码
DSH_MEETING_PORT=4501 ./start.sh                  # 同一台电脑再起一个人（测试用），停：DSH_MEETING_PORT=4501 ./stop.sh
```

它在背后用 `node ~/.dsh/profiles/meeting/node_modules/dsh-meeting/lib/patch.mjs --port … --a2a-port … --data-dir …` 生成 `--patch` 叠加层。

数据在 `~/.dsh-meeting/state.json`（日程、档案、对话），日志在 `~/.dsh-meeting/dsh.log`。手机页右上「重来一轮」清空对话和报文（日程保留），🧠 页「恢复示例数据」回到示例初始状态。

## 开发

```bash
cd dsh-meeting
node scripts/build.mjs     # 生成 lib/seeds.json（来自两个 demo 的 data.mjs）和 cordis.patch.yml，打包 dist/*.tgz 和 dist/dsh-meeting-kit-*.zip
```

| 路径 | 作用 |
|---|---|
| `lib/index.js` | cordis 插件入口（配置 schema、启停本机节点） |
| `lib/client.js` | 浏览器端：DSH 侧栏「约会议」+ 主区页面（手写的 dsh 客户端模块，不需要打包） |
| `lib/node.mjs` | 本机节点：状态、工具实现、出站 A2A、mDNS / 手动发现、HTTP |
| `lib/mcp.mjs` | MCP 工具清单 + Streamable HTTP 处理（长工具调用用 SSE 心跳保活） |
| `lib/engine.mjs` | 带日期的忙闲 / 求交 / 松绑 / 计票 |
| `lib/prompt.mjs` | 私人助理提示词（两个 demo 的流程合并） |
| `web/` | 手机页 |
| `kit/` | 安装包里的 install / start / stop 脚本 |
