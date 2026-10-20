#!/bin/bash
# dsh-meeting 安装：建一个独立的 dsh profile（默认叫 meeting），把插件装进去。不碰 desktop / web / headless 等已有 profile。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_MEETING_PROFILE:-meeting}"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
DIR="${DSH_HOME}/profiles/${PROFILE}"
TGZ="__TGZ__"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "没有 node：先装 Node.js 22 或更新版本（https://nodejs.org）"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "${NODE_MAJOR}" -ge 20 ] || die "Node.js 版本太旧（$(node -v)），需要 ≥ 20.19"
command -v pnpm >/dev/null || { say "安装 pnpm（dsh 用它装插件）"; npm install -g pnpm; }
command -v dsh >/dev/null || { say "安装 DeepSeek Harness CLI"; npm install -g @deepseek-ai/dsh; }
say "dsh $(dsh --version)  node $(node -v)  pnpm $(pnpm -v)"

case "${PROFILE}" in desktop|web|headless|acp|sdk|sdk-minimal) die "profile 名 ${PROFILE} 是 dsh 自带的，换一个（DSH_MEETING_PROFILE=meeting）";; esac
mkdir -p "${DIR}" "${DSH_HOME}/data/dsh-meeting"
cp "${HERE}/${TGZ}" "${DSH_HOME}/data/dsh-meeting/${TGZ}"
if [ ! -f "${DIR}/package.json" ]; then
  say "新建 profile ${PROFILE}（${DIR}）"
  cat > "${DIR}/package.json" <<JSON
{
  "name": "dsh-profile-${PROFILE}",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
JSON
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "${DIR}/pnpm-workspace.yaml"
fi

# profile 自己的配置层：模型用本机 dsh 登录的 DeepSeek 账号，会话 / 存储和别的 profile 分开放。
# 只在文件还是空表（没有用户自己的条目）时写，改过的不动。
PATCH_FILE="${DIR}/cordis.patch.yml"
if [ ! -f "${PATCH_FILE}" ] || [ "$(grep -v '^#' "${PATCH_FILE}" | tr -d '[:space:]')" = "[]" ]; then
  cat > "${PATCH_FILE}" <<'YML'
# dsh-meeting 独立 profile 的配置层（install.sh 写的）。想用 API Key：把 provider 改成 deepseek-official，并 export DEEPSEEK_API_KEY
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('dsh-meeting-sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('dsh-meeting-storages')
YML
fi

say "安装插件 ${TGZ}（依赖已打包在里面，不用联网下载）"
# 旧版包名叫 dsh-meeting：先卸掉，免得两份同时加载、抢同一个端口
if [ -d "${DIR}/node_modules/dsh-meeting" ]; then dsh plugin --profile "${PROFILE}" remove dsh-meeting < /dev/null >/dev/null || true; fi
dsh plugin --profile "${PROFILE}" add --prefer-offline "file:${DSH_HOME}/data/dsh-meeting/${TGZ}" < /dev/null

# 确保 bundle 列表里有 @maximehu97/dsh-meeting（旧版叫 dsh-meeting，顺手去掉；它的 patch 会插入本机节点、meeting 助理 preset 和入站 A2A）
node -e '
const fs=require("fs"),f=process.argv[1],j=JSON.parse(fs.readFileSync(f,"utf8"));
const b=((j.dsh??={}).profile??={}).bundles??=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"];
b.splice(0,b.length,...b.filter((x)=>x!=="dsh-meeting"));
if(!b.includes("@maximehu97/dsh-meeting")) b.push("@maximehu97/dsh-meeting");
fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");' "${DIR}/package.json"

say "检查配置能否组装"
dsh --profile "${PROFILE}" --dump-config >/dev/null && say "安装完成。启动：${HERE}/start.sh"
