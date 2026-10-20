#!/usr/bin/env node
// dsh 配置片段：
//  - bundlePatch()：插件自己的 bundle patch（scripts/build.mjs 写成 cordis.patch.yml）
//  - overlay()：换端口 / 团队码 / 数据目录时用的 --patch 叠加层。dsh 的 patch 按 id 整份替换 config，
//    所以叠加层要把节点、preset（里面的 MCP 地址）、A2A 三个条目完整重写一遍。
// 命令行：node lib/patch.mjs --port 4501 --a2a-port 41501 --data-dir ~/.dsh-meeting-b [--team muse] > overlay.yml
import { PROMPT } from "./prompt.mjs";

const q = (s) => JSON.stringify(s);
const ind = (s, n) => s.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

// 助理默认用所在 profile 的默认模型；--provider / --model 只作用于 meeting 这个 agent。
function entries({ port = 4500, a2aPort = 41500, team = "muse", dataDir = "", provider = "", model = "" }) {
  return `- id: meeting
  name: '@maximehu97/dsh-meeting'
  config:
    port: ${port}
    host: 0.0.0.0
    a2aPort: ${a2aPort}
    team: ${q(team)}
    mdns: true${dataDir ? `\n    dataDir: ${q(dataDir)}` : ""}
- id: preset-meeting
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: meeting
    order: 0
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          complete: true
          includeRuntimeContext: false
          prefix: ${q(PROMPT)}
      - id: meeting-tools
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          transport: streamable-http
          serverName: meeting
          url: http://127.0.0.1:${port}/mcp
          toolCallTimeoutMs: 3600000
          failOnStartupError: false
- id: meeting-a2a
  name: '@amaster.ai/dsh-a2a'
  config:
    enabled: true
    host: 0.0.0.0
    port: ${a2aPort}
    basePath: /a2a
    agent:${provider ? `\n      provider: ${provider}\n      model: ${model || "deepseek-flash"}` : ""}
      preset: meeting
    card:
      name: 九派私人助理（dsh-meeting）
      description: 九派私人智能体（DeepSeek Harness），通过 dsh-meeting 和局域网同事协商
      version: 0.3.0
    taskStore: memory`;
}

// bundle 只插入自己的三个条目，不动所在 profile 的模型、会话目录等（插件也可能装进别人的 web / desktop profile）。
// 独立 profile「meeting」里的模型和会话目录由 kit/install.sh 写进 profile 自己的 cordis.patch.yml。
export function bundlePatch() {
  return `# dsh-meeting bundle patch（由 scripts/build.mjs 生成，别手改；要改端口等用 lib/patch.mjs 生成 --patch 叠加层）
- insert:
${ind(entries({}), 4)}
`;
}

export function overlay(o) {
  const dirs = o.dataDir ? `
- id: session-persistence-jsonl
  config:
    root: ${q(o.dataDir + "/sessions")}
- id: storage-json
  config:
    root: ${q(o.dataDir + "/storages")}` : "";
  return `# dsh-meeting 叠加层（node lib/patch.mjs 生成）：端口 ${o.port} / A2A ${o.a2aPort}
${entries(o)}${dirs}
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const home = process.env.HOME || "";
  const dataDir = arg("--data-dir", "").replace(/^~/, home);
  process.stdout.write(overlay({ port: +arg("--port", 4500), a2aPort: +arg("--a2a-port", 41500), team: arg("--team", "muse"), dataDir, provider: arg("--provider", ""), model: arg("--model", "") }));
}
