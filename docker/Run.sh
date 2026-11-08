#! /bin/bash
echo "配置文件"
[ ! -f config/app.js ] && cp config.demo/app.js config/app.js
[ ! -f config/log.js ] && cp config.demo/log.js config/log.js
[ ! -f config/view.js ] && cp config.demo/view.js config/view.js

# 首次启动预置一份可直接登录的配置：admin / admin123，push_key 为空
# 已经存在的 data.json 一律不动（挂载目录里的真实配置优先）
if [ ! -f config/data.json ] && [ -f config.demo/data.demo.json ]; then
  cp config.demo/data.demo.json config/data.json
  echo "已生成默认配置：面板账号 admin / admin123，push_key 为空，请登录后立刻改密码并添加 key"
fi

if [ ! -d "node_modules" ]; then
  echo "安装依赖"
  npm i --registry=https://registry.npmmirror.com
else
  echo "依赖已安装"
fi
echo "启动服务"
node server.js
