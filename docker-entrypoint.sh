#!/bin/sh
# 启动 Next.js 主进程（前台）
# 依赖 depends_on + healthcheck 保证 Postgres 就绪
exec node server.js
