#!/bin/bash
# 启动本机的 dsh-meeting 助理（后台运行），等节点就绪后打开手机页。
# 默认端口：手机页 4500、A2A 41500、dsh 调试网页 3500。同一台电脑再起一个人（测试用）：
#   DSH_MEETING_PORT=4501 ./start.sh     # A2A 自动用 41501，数据放 ~/.dsh-meeting-4501
set -eu
PROFILE="${DSH_MEETING_PROFILE:-meeting}"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
NODE_PORT="${DSH_MEETING_PORT:-4500}"
A2A_PORT="${DSH_MEETING_A2A_PORT:-$((NODE_PORT + 37000))}"
WEB_PORT="${DSH_WEB_PORT:-$((NODE_PORT - 1000))}"
TEAM="${DSH_MEETING_TEAM:-muse}"
if [ "${NODE_PORT}" = 4500 ] && [ "${A2A_PORT}" = 41500 ] && [ "${TEAM}" = muse ]; then RUN="${HOME}/.dsh-meeting"; PATCH=(); else
  RUN="${HOME}/.dsh-meeting-${NODE_PORT}"; mkdir -p "${RUN}"
  node "${DSH_HOME}/profiles/${PROFILE}/node_modules/@maximehu97/dsh-meeting/lib/patch.mjs" --port "${NODE_PORT}" --a2a-port "${A2A_PORT}" --team "${TEAM}" --data-dir "${RUN}" > "${RUN}/overlay.yml"
  PATCH=(--patch "${RUN}/overlay.yml")
fi
mkdir -p "${RUN}"
if curl -s -o /dev/null "http://127.0.0.1:${NODE_PORT}/api/state"; then echo "已经在运行：http://127.0.0.1:${NODE_PORT}/"; exit 0; fi
cd "${RUN}"
nohup dsh --profile "${PROFILE}" ${PATCH[@]+"${PATCH[@]}"} "$@" --no-open --port "${WEB_PORT}" > "${RUN}/dsh.log" 2>&1 < /dev/null &
echo $! > "${RUN}/dsh.pid"
echo "dsh 启动中（pid $(cat "${RUN}/dsh.pid")，日志 ${RUN}/dsh.log）"
for i in $(seq 1 90); do
  if curl -s -o /dev/null "http://127.0.0.1:${NODE_PORT}/api/state"; then
    grep -m1 "dsh-meeting\] 手机页" "${RUN}/dsh.log" || true
    echo "✓ 就绪：http://127.0.0.1:${NODE_PORT}/"
    [ -z "${NO_OPEN:-}" ] && command -v open >/dev/null && open "http://127.0.0.1:${NODE_PORT}/" || true
    exit 0
  fi
  kill -0 "$(cat "${RUN}/dsh.pid")" 2>/dev/null || { echo "✗ dsh 退出了，看日志：${RUN}/dsh.log" >&2; tail -30 "${RUN}/dsh.log" >&2; exit 1; }
  sleep 1
done
echo "✗ 90 秒还没就绪，看日志：${RUN}/dsh.log" >&2; exit 1
