/**
 * dsh-meeting — 九派多智能体协商（排会 + 团建）的 dsh 插件。
 *
 * 每个人在自己的电脑上跑一个 dsh（profile 里装这个插件），插件在 dsh 进程里起一个本机节点：
 * 手机页 + MCP 工具（Streamable HTTP，供 preset「meeting」里的助理使用）+ 出站 A2A + 局域网发现（mDNS / 手动 IP）。
 * 入站 A2A 由同一个 bundle 里的 @amaster.ai/dsh-a2a 提供（它只收不发，出站由本插件代发）。
 *
 * 安全：dsh 和 dsh-a2a 都没有鉴权。节点和 A2A 端口会监听局域网，只在可信的局域网里用；team 只是防串台，不是密码。
 */
import Schema from "@deepseek-ai/schemastery";
import { MeetingNode } from "./node.mjs";

export const name = "dsh-meeting";

export const Config = Schema.object({
  port: Schema.natural().default(4500).description("手机页 / 节点端口（局域网可访问）"),
  host: Schema.string().default("0.0.0.0").description("节点监听地址"),
  a2aPort: Schema.natural().default(41500).description("本机 dsh-a2a 的端口（要和 a2a 插件配置一致）"),
  a2aPath: Schema.string().default("/a2a"),
  dataDir: Schema.string().default("").description("本人数据目录，默认 ~/.dsh-meeting"),
  team: Schema.string().default("muse").description("团队码：只和团队码相同的节点互相发现"),
  mdns: Schema.boolean().default(true).description("用 mDNS（Bonjour）自动发现局域网同事"),
  advertiseHost: Schema.string().default("").description("对外显示的 IP（默认自动选局域网网卡）"),
});

export function apply(ctx, config) {
  let ready;
  ctx.effect(() => {
    const node = new MeetingNode(config);
    ready = node.start();
    return ready.then(() => async () => { await node.stop(); });
  });
  return ready;
}
