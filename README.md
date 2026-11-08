# PushMe Server

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

PushMe Server 是一个基于 Node.js 开发的自建消息推送服务器，为 [PushMe](https://push.i-i.me/) APP 和 PushMeClient 提供私有化部署方案。

## ✨ 特性

- 🔐 **数据隐私**: 完全自主可控的消息服务，保障数据安全
- 🎯 **接口兼容**: 消息接口参数与官方完全一致，支持 push_key 和 temp_key
- 🖥️ **可视化管理**: 零依赖 Web 管理界面，首页仪表盘集中展示在线客户端、今日推送与送达率
- 📱 **移动端 App 观感**: 手机打开即底部 Tab Bar + App 式顶栏 + 卡片列表 + 底部抽屉弹层，
  支持"添加到主屏幕"独立运行（`site.webmanifest`、安全区留白、16px 输入防缩放）
- 🧪 **独立测试页**: 在线测试从首页拆为独立页面，消息类型/示例/标题语法一屏可用
- 📬 **消息台账**: 所有消息落本地 SQLite，未送达/已下发/已送达状态可查、可重发、可导出 CSV
- 🔁 **离线补投**: 客户端掉线期间的消息进队列，重新上线后按顺序补投，不丢消息
- ✅ **严格送达回执**: 只有收到客户端 MQTT PUBACK 才记为"已送达"，其余一律显示"未送达/已下发"
- 🗄️ **保留策略可配**: 设置页可调消息保留天数与每 key 条数，保存即生效，填 0 表示不清理
- 📡 **多协议支持**: 同时支持 HTTP/HTTPS API 和 MQTT/WebSocket 消息服务
- 🔧 **灵活配置**: 支持通过 Web 界面修改端口、证书等配置，无需编辑文件
- 📊 **实时监控**: 独立的系统信息面板，实时显示面板和服务运行状态
- 📝 **系统日志**: 实时日志查看功能，支持级别筛选和历史日志查看
- 🐳 **容器化部署**: 支持 Docker 快速部署

## 📦 系统要求

- **Node.js**: >= 22.13.0（使用内置 `node:sqlite`，无需编译原生模块）
- **端口占用**（默认值，可通过 Web 界面修改）:
  - `3010` - Web 管理及 API 接口
  - `3100` - MQTT/WebSocket 消息服务

## 🚀 快速开始

### 方式一：npx 一键部署（最简单）

```bash
# 创建项目
npx pushme-server init mypush

# 进入项目目录
cd mypush

# 启动服务
npm start
```

或者在当前目录初始化：

```bash
npx pushme-server init
npm start
```

启动后访问 `http://localhost:3010` 即可使用。

### 方式二：Docker 部署

```bash
docker run -dit \
  -p 3010:3010 \
  -p 3100:3100 \
  -e TZ=Asia/Shanghai \
  -v $PWD/pushme-server/config:/pushme-server/config \
  --name pushme-server \
  --restart unless-stopped \
  yafoo/pushme-server:latest
```

**说明:**
- `-v` 参数将配置文件挂载到宿主机，方便持久化和修改
- `--restart unless-stopped` 确保容器异常退出后自动重启

> **本仓库镜像**：`ghcr.io/q1016134519/pushme-server:latest`（由 GitHub Actions 自动构建）。
> 容器**首次启动**会预置一份可直接登录的配置，不需要走安装页：
>
> | 项目 | 默认值 |
> |---|---|
> | 面板地址 | `http://<服务器IP>:3010` |
> | 账号 / 密码 | `admin` / `admin123` |
> | push_key | 空（登录后到「设置」里添加） |
>
> 挂载目录里已存在 `config/data.json` 时**不会覆盖**，所以升级容器不会冲掉你自己的配置。
> 登录后请立刻在「设置 → 账户密码」改掉默认密码。
>
> 没有 key 时的推送表现（实测）：空 `push_key` → `Push failed, empty push_key!`；
> 填一个没配置过的 key → `非法push_key!`。

### 方式三：Docker Compose 部署

```bash
# 创建部署目录
mkdir pushme-server && cd pushme-server

# 创建 docker-compose.yml
cat > docker-compose.yml << 'EOF'
version: '3.8'
services:
  pushme-server:
    image: yafoo/pushme-server:latest
    container_name: pushme-server
    restart: unless-stopped
    ports:
      - "3010:3010"
      - "3100:3100"
    volumes:
      - ./config:/pushme-server/config
    environment:
      - TZ=Asia/Shanghai
EOF

# 启动服务
docker-compose up -d
```

### 方式四：飞牛 fnOS 应用

PushMe Server 已提供飞牛 fnOS 的 `.fpk` 应用包配置，详见 [`fpk/`](fpk/) 目录。

打包步骤：
1. 在 `fpk/` 目录补充应用图标（`ICON.PNG`、`ICON_256.PNG`、`app/ui/images/`）
2. 安装 [fnpack](https://developer.fnnas.com/docs/cli/fnpack/) 工具
3. 在 `fpk/` 目录执行 `fnpack build`，生成 `pushme-server.fpk`
4. 将 `.fpk` 文件安装到飞牛 fnOS 设备

### 方式五：源码部署

```bash
# 1. 克隆仓库
git clone https://github.com/yafoo/pushme-server.git
cd pushme-server

# 2. 安装依赖
npm i

# 3. 启动服务
npm start
```

## ⚙️ 配置指南

### 首次使用

1. 启动服务后，访问 `http://您的服务器IP:3010`
2. 完成初始化配置（设置管理员账号密码）
3. 在"PushKey"页面管理推送密钥（支持添加备注）

### 客户端配置

在 PushMe 安卓或 Windows 客户端中：
- **Host**: 填写服务器 IP（如 `192.168.1.100`）
- **Port**: 填写 `3100`
- 保存配置即可使用

### 消息接口

- **接口地址**: `http://您的服务器IP:3010`（支持 IPv6）
- **请求参数**: 与[官方接口](https://push.i-i.me/)完全一致
- **支持的密钥类型**:
  - `push_key`: 永久推送密钥
  - `temp_key`: 临时推送密钥（可在 PushKey 管理中配置）

**示例：**
```bash
# 使用 push_key
curl -d "push_key=YOUR_KEY&title=测试&content=消息内容" http://您的IP:3010

# 使用 temp_key
curl -d "temp_key=YOUR_TEMP_KEY&title=测试&content=消息内容" http://您的IP:3010
```

### 支持的消息类型

- `text`: 纯文本消息
- `markdown`: Markdown 格式消息
- `html`: HTML 格式消息
- `url`: URL 消息（点击打开链接）
- `data`: 数据消息（仅传递数据）
- `markdata`: Markdown 数据消息
- `note`: 笔记/任务列表消息
- `svg`: SVG 图片消息
- `chart`: 图表消息
- `echarts`: ECharts 图表消息

## 🔧 高级配置

### 端口配置

通过 Web 管理界面修改端口：
1. 进入"面板设置"或"服务设置"页面
2. 修改对应端口号
3. 保存后系统将自动重启

### 证书配置

系统支持自签名证书和公共证书：
1. 进入"面板设置"或"服务设置"页面
2. 选择证书类型
3. 如需自签名证书，点击"生成自签名证书"按钮
4. 输入域名（支持 IP 地址，多个域名换行分隔）
5. 系统自动生成证书并重启服务

### 域名绑定

生产环境建议通过 Nginx 反向代理绑定域名：

1. 配置 Nginx 反向代理到 `localhost:3010`
2. 配置 SSL 证书启用 HTTPS
3. 消息端口可能变为 80/443

📖 [查看详细域名绑定教程](https://me.i-i.me/article/76.html)

### 调试模式

二次开发时，请在 [`config/app.js`](config/app.js) 中设置：

```javascript
app_debug: true
```

⚠️ **重要**: 上线前务必关闭调试模式！

### 消息存储与保留

消息统一落在 `config/messages.db`（SQLite，WAL 模式），保留策略在 `config/data.json`：

```json
"messages": {
  "retain_days": 7,
  "max_per_key": 500
}
```

- `retain_days`：超过天数的记录定时清理（默认 7 天，`0` = 不按时间清理）
- `max_per_key`：每个 push_key 最多保留条数，超出后淘汰最旧的（默认 500，`0` = 不限条数）
- 这两个值也能在面板「设置 → 消息与存储 → 保留策略」里改，保存后立即清理一次，无需重启
- 面板同一处可直接查看占用、清理已送达或清空全部
- 想彻底重置台账：停服后删掉 `config/messages.db*` 三个文件，重启即自动重建
- 从旧版本升级时，`config/offline.json` 里的离线队列会在首次启动时自动导入并改名为 `offline.json.bak`

消息状态含义：

| 状态 | 含义 |
|------|------|
| 未送达 | 无人在线，已入队等待补投 |
| 已下发 | broker 已写出，但还没收到客户端 PUBACK；超过 30 秒没确认会自动退回「未送达」等下次上线补投 |
| 已送达 | 收到客户端 PUBACK（唯一算送达的依据） |
| 已过期 | 超出保留天数被清理 |
| 已丢弃 | 补投超过 20 次仍失败，或主动放弃 |

送达判定细则（v3.4）：

- **任一客户端确认即送达**：同一个 push_key 有多个客户端订阅时，任一份 PUBACK 就把消息置为「已送达」，
  不要求全部订阅者都确认。`delivered_to` 只作审计，记录所有确认过的客户端。
- **重复确认是幂等的**：QoS1 允许重传，第二次 PUBACK 不会刷新送达时间，台账上的延迟不会被伪造。
- **PUBACK 超时回收**：消息写出后 30 秒仍无确认（客户端在 ACK 前一刻掉线）→ 退回「未送达」，
  下次上线补投。宁可重复一次，也不让消息静默停在「已下发」。
- **报文标识对齐**：clean session 下 PUBACK 只带报文标识、拿不到原始报文，服务端按投递顺序逐条对齐；
  持久会话则用 topic + payload 精确反查。两者都失败时状态停在「已下发」，绝不谎报送达。
- **对账日志**：每一条真实跃迁都打一行，真机验收时以它为准

  ```
  [puback] clientId=PUSHME_xxx mid=42 topic=pk_xxx msg=#17 status 1->2 at 2026-11-08 14:22:07
  ```
- **确认方可见（v3.4.1）**：台账每行多一列「确认方」，直接显示是哪个 clientId 回的 PUBACK；
  `probe-` / `cdp-` / `test-` 前缀是部署验收脚本，标琥珀色「脚本」，别把它当成手机送达。
- **补投只做一次（v3.4.2）**：PushMe App 连上后会对同一个 key 发两次 SUBSCRIBE，补投按
  「连接 + key」记账，同一条离线消息不会补投两遍，手机上不会出现两条重复通知；断线后才重新记账。

## 📁 项目结构

```
pushme-server/
├── app/                    # 应用核心代码
│   ├── controller/        # 控制器层
│   │   ├── admin.js      # 后台管理基类
│   │   ├── index.js      # 消息推送接口
│   │   ├── login.js      # 用户认证
│   │   ├── message.js    # 消息台账（查询/重发/删除/导出）
│   │   ├── server.js     # 服务管理
│   │   ├── setting.js    # 系统设置
│   │   ├── test.js       # 在线测试页
│   │   └── log.js        # 日志管理
│   ├── libs/             # 业务逻辑库
│   │   ├── setting.js    # 设置管理
│   │   ├── third.js      # 第三方平台适配
│   │   └── tls.js        # 证书管理
│   └── view/             # 视图模板
├── lib/                  # 核心库
│   ├── config.js         # 配置管理器（统一配置）
│   ├── log_buffer.js     # 日志缓冲区（内存环形缓冲）
│   ├── pushme_panel.js   # 面板服务（Web管理）
│   ├── message_store.js  # 消息台账（node:sqlite，离线队列 + 送达记录）
│   ├── pushme_proxy.js   # PushMe代理
│   └── pushme_server.js  # 推送服务（MQTT/WS/TCP）
├── config/               # 配置文件
│   ├── app.js           # 应用配置
│   ├── log.js           # 日志配置
│   ├── view.js          # 视图配置
│   ├── data.json        # 系统数据（配置和状态）
│   └── messages.db      # 消息台账（SQLite，可随时删除重建）
├── public/              # 静态资源
│   ├── css/app.css      # 面板样式（手写设计系统，无框架）
│   └── js/app.js        # 面板脚本（原生 DOM，无构建）
├── docker/              # Docker 相关文件
├── fpk/                 # 飞牛 fnOS 应用包配置
├── server.js            # 服务入口
└── package.json         # 项目依赖
```

## 🔄 配置迁移

从 v2.1.0 升级到新版本时，系统会自动执行配置迁移：
- 自动合并 `config/setting.js` 和 `config/data.json` 为统一的 `config/data.json`
- 保留所有原有配置
- 添加版本标识，支持后续迁移

## 🛠️ 技术栈

- **后端框架**: [jj.js](https://github.com/yafoo/jj.js) ^1.1.0
- **MQTT Broker**: [aedes](https://github.com/moscajs/aedes) ^1.1.1
- **WebSocket**: [ws](https://github.com/websockets/ws) ^8.21.3
- **证书生成**: selfsigned ^5.5.0
- **消息存储**: Node 内置 `node:sqlite`（WAL 模式，零外部依赖）
- **前端 UI**: 原生 CSS + 原生 JS（无框架、无图标字体、无构建步骤）

## 📝 开发指南

本项目基于 [jj.js](https://github.com/yafoo/jj.js) 轻量级框架开发，如需二次开发请参考其文档。

### 主要模块说明

- **PushmeServer**: 推送服务核心，负责 MQTT/WebSocket/TCP 协议处理
- **PushmePanel**: Web 面板服务，基于 jj.js 框架
- **PushmeProxy**: 代理层，提供统一的服务接口
- **ConfigManager**: 配置管理器，统一配置管理
- **LogBuffer**: 日志缓冲区，支持实时日志查看

## 🔗 相关链接

- **GitHub**: https://github.com/yafoo/pushme-server
- **Gitee**: https://gitee.com/yafu/pushme-server
- **Docker Hub**: https://hub.docker.com/r/yafoo/pushme-server
- **PushMe 官网**: https://push.i-i.me/
- **飞牛NAS**: https://fnnas.com/
- **pushme-server-golang**: https://github.com/0x01feng/pushme-server-golang （第三方实现的golang版本PushMeServer）

## 📦 飞牛 fnOS 应用

PushMe Server 提供飞牛 fnOS 的 `.fpk` 应用包配置，位于 [`fpk/`](fpk/) 目录。

### 应用信息

- **应用名称**: PushMe Server
- **应用描述**: 自建消息推送服务器，支持MQTT/WebSocket，接口兼容官方PushMe APP
- **Docker镜像**: `yafoo/pushme-server:latest`
- **端口**: 3010 (Web管理) / 3100 (消息服务)
- **应用商店**: https://app.fnnas.com/

### 打包与安装

1. 准备应用图标（需要 `ICON.PNG`、`ICON_256.PNG` 和 `app/ui/images/` 下的图标）
2. 安装 [fnpack](https://developer.fnnas.com/docs/cli/fnpack/) 工具
3. 在 `fpk/` 目录执行 `fnpack build` 生成 `pushme-server.fpk`
4. 将 `.fpk` 文件安装到飞牛 fnOS 设备

详细文档参见 [`fpk/README.md`](fpk/README.md)。

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request!

---

💡 **提示**: 如有问题或建议，欢迎在 GitHub Issues 中反馈。
