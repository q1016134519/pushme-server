#!/bin/bash
# PushMe Server 宝塔部署（Node 项目 / PM2 路线）
# 用法：在宝塔「终端」里执行
#   bash /www/wwwroot/pushme-server/deploy/baota/install-node.sh
#
# 前提：
#   1. 宝塔「软件商店 → Node.js 版本管理器」已装 v22.13 或更高（本项目用了内置 node:sqlite）
#   2. 代码已放到 /www/wwwroot/pushme-server（去掉 node_modules）
set -euo pipefail

APP_DIR="${1:-/www/wwwroot/pushme-server}"
NODE_MIN="22.13.0"

cd "$APP_DIR"

echo "== 1. 检查 Node 版本 =="
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "✗ 找不到 node。先在宝塔 → Node.js 版本管理器 安装 v22，并把它设为命令行默认版本"
    exit 1
fi
NODE_VER="$(node -v | sed 's/^v//')"
echo "当前 node: v$NODE_VER  ($NODE_BIN)"
if [ "$(printf '%s\n%s\n' "$NODE_MIN" "$NODE_VER" | sort -V | head -1)" != "$NODE_MIN" ]; then
    echo "✗ Node 版本过低，本项目需要 >= v$NODE_MIN（node:sqlite）"
    exit 1
fi
node -e 'require("node:sqlite")' >/dev/null 2>&1 || {
    echo "✗ 当前 node 不带 node:sqlite，请换官方 v22.13+ 构建"
    exit 1
}

echo "== 2. 安装依赖 =="
# 有 lock 文件走 ci，能复现线上一致；没有就退回 install
if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com
else
    npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com
fi

echo "== 3. 准备 config 目录 =="
mkdir -p config
# 首次部署：把仓库自带的默认配置拷进去，之后 data.json 由安装页生成
for f in app.js log.js view.js; do
    if [ -f "config/$f" ]; then continue; fi
    if [ -f "config.demo/$f" ]; then cp "config.demo/$f" "config/$f"; fi
done

echo "== 4. 处理权限（这一步最容易踩）=="
echo "PM2 以 www 用户跑，config 目录必须归 www，否则保存设置会写不进去"
if [ "$(id -u)" = "0" ]; then
    chown -R www:www "$APP_DIR"
else
    echo "⚠ 不是 root，跳过 chown。请手动执行： sudo chown -R www:www $APP_DIR"
fi
chmod 755 "$APP_DIR"
chmod 644 config/*.json 2>/dev/null || true

echo "== 5. 自检启动（前台 8 秒，只为看端口有没有起来）=="
timeout 8 node server.js 2>&1 | head -20 || true

cat <<'TIP'

== 6. 在宝塔里加 Node 项目 ==
  软件商店 → Node 项目 → 添加 Node 项目
    项目目录： /www/wwwroot/pushme-server
    启动选项： node server.js      （不要用 npm start，更不要加 --harmony）
    项目端口： 3010               （只是登记用，真实端口读 config/data.json）
    运行用户： www
    包管理器： 无（依赖已装好）
  添加完点「启动」，再到「设置 → 项目守护」确认已开启开机自启。

  或者纯命令行：
    npm i -g pm2
    pm2 start server.js --name pushme-server --time
    pm2 save && pm2 startup

== 7. 放行端口 ==
  宝塔 → 安全 → 放行 3010/tcp、3100/tcp
  云厂商控制台的安全组同样要放行这两个端口

== 8. 初始化 ==
  浏览器打开 http://服务器IP:3010 → 自动跳到安装页 → 设管理员账号密码
  然后「设置」里加 push_key、按需改端口和消息保留策略
TIP
