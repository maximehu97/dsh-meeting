#!/bin/bash
# 停止本机的 dsh-meeting 助理（DSH_MEETING_PORT=4501 ./stop.sh 停测试用的第二个）
NODE_PORT="${DSH_MEETING_PORT:-4500}"
RUN="${HOME}/.dsh-meeting"; [ "${NODE_PORT}" = 4500 ] || RUN="${HOME}/.dsh-meeting-${NODE_PORT}"
if [ -f "${RUN}/dsh.pid" ] && kill "$(cat "${RUN}/dsh.pid")" 2>/dev/null; then echo "已停止"; else echo "没有在运行"; fi
rm -f "${RUN}/dsh.pid"
