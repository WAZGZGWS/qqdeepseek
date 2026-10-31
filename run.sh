#!/bin/sh
# 保持邮件服务常驻：崩了 5 秒后重来
cd "$(dirname "$0")" || exit 1
while true; do
  node mailbot.mjs >> out.log 2>> err.log
  sleep 5
done
