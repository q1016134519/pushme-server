# 发布到 GitHub 与准备镜像

两件事分开看：**代码进仓库** 和 **镜像能落地**。镜像有两条路 —— 云端自动构建（GHCR）和内网离线导入（tar）。

---

## 一、代码进仓库

### 1. 建仓库

网页建：GitHub → New repository → 名字 `pushme-server` → **不要**勾 README（本地已有提交）。

或者用 API（把 `TOKEN` 换成带 `repo` scope 的 PAT）：

```bash
curl -sS -X POST https://api.github.com/user/repos \
  -H "Authorization: token TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"pushme-server","private":false,"description":"Self-hosted PushMe server: MQTT push + SQLite ledger + strict PUBACK delivery + web panel"}'
```

### 一条命令搞定（推荐）

令牌不落盘：从环境变量读，推送时临时拼进 URL，结束立刻还原成干净地址。

```bash
cd /d/AITEST/pushme/repo
TOKEN=ghp_xxxxxxxx bash scripts/publish-github.sh
```

它依次做：校验令牌 → 仓库不存在就建 → 推 `HEAD:master` → 打 `v3.4.4` tag 触发镜像构建 → 打印仓库/构建/镜像地址。

> **`git push` 被连接重置时**（本机实测就是这个情况：`api.github.com` 通、`github.com:443` 被 reset），
> 改走 Git Data API，效果等价，只是远端提交的 sha 会和本地不同（内容一致）：
>
> ```bash
> cd /d/AITEST/pushme/repo
> TOKEN=ghp_xxxxxxxx python scripts/push-via-api.py q1016134519/pushme-server master
> ```
>
> 只更新仓库、不动已发布 tag 时加 `SKIP_TAG=1`（否则 tag 会被强制挪到新提交，反复触发镜像构建）。
>
> 它做的是：`git ls-tree -r HEAD` 取真实 blob sha（对象库里是 LF，绕开 Windows CRLF 污染）→
> 并行 `POST /git/blobs` → `POST /git/trees` → `POST /git/commits`（远端已有分支就挂 parent）→
> `PATCH /git/refs/heads/master` → 设默认分支 → 打 tag。仓库是空的时候先用 Contents API 塞个 README，
> 否则 Git Data API 返回 409。

### 2. 手动加远端并推（脚本已覆盖，留作参考）

本地仓库现在有两个远端：`origin` 指上游 `yafoo/pushme-server`（保留着便于以后同步），
`mine` 指自己的仓库：

```bash
cd /d/AITEST/pushme/repo
git remote add mine https://github.com/q1016134519/pushme-server.git   # 已加过就跳过
git push -u mine master
```

直连被墙（`Connection reset` / 超时）时，换成走代理的地址，或改用 SSH 443：

```bash
# 方案 1：镜像代理（仅当代理支持 push）
git remote set-url mine https://gh-proxy.com/https://github.com/q1016134519/pushme-server.git

# 方案 2：SSH over 443（需要把 ~/.ssh/id_ed25519_github.pub 加到 GitHub → SSH keys）
git remote set-url mine ssh://git@ssh.github.com:443/q1016134519/pushme-server.git
git push -u mine master
```

### 3. 打 tag 触发构建

```bash
git tag -a v3.4.4 -m "v3.4.4 消息页重排 + 镜像单 tag + LF 入库"
git push mine v3.4.4
```

---

## 二、镜像

### 路线 A：GitHub Actions 自动构建到 GHCR（推荐）

`.github/workflows/docker.yml` 在推 `v*` tag 或手动 `workflow_dispatch` 时构建并推送：

```
ghcr.io/q1016134519/pushme-server:3.4.4
```

**只出一个 tag，不打 `latest`。** 理由很实在：生产容器如果挂 `latest`，下次 CI 一构建就悄悄换了版本，
容器里跑的是哪一版说不清；离线包和 GHCR 也对不上号。要升级就改 tag 名，看得见。

用的是仓库自带的 `GITHUB_TOKEN`，不需要额外配 secret。产物是 `linux/amd64`。

第一次跑完，到 GitHub → 个人头像 → Packages 里能看到这个包。**公开仓库默认包也是公开的**，可直接匿名拉：

```bash
docker pull ghcr.io/q1016134519/pushme-server:3.4.4
```

实测（2026-11-08，`v3.4.3` 那次构建，匿名拉取成功；`3.4.4` 是同一套 workflow，digest 会变）：

```
Digest: sha256:71f2040a69a3a480f8ed255ca0863d9ad6d362fdfe71b40f4abfaf5c58746e01
Status: Downloaded newer image for ghcr.io/q1016134519/pushme-server:3.4.3
```

本地习惯用的短名自己补（可选，只为少打一截前缀）：

```bash
docker tag ghcr.io/q1016134519/pushme-server:3.4.4 pushme-server:3.4.4
```

如果是私有仓库，拉之前要登录（PAT 勾 `read:packages`）：

```bash
echo <PAT> | docker login ghcr.io -u q1016134519 --password-stdin
```

> 想让 Actions 同时出 arm64（树莓派 / 甲骨文 ARM 机器），在 `docker.yml` 的 build 步骤加
> `platforms: linux/amd64,linux/arm64`，并确认 `permissions.packages: write` 已开。

### 路线 B：离线镜像包（宝塔在内网、拉不动 GHCR 时用）

已经打好一个 **docker-archive 格式** 的包（就是这个格式，不是 OCI，老版本 docker 也能 load）：

| 项目 | 值 |
|---|---|
| 文件（本机） | `D:\AITEST\pushme\deploy\pushme-server-3.4.4-image.tar.gz` |
| 大小 | 67.9 MB（71,188,272 字节，解开约 305 MB） |
| sha256 | `47d8a5441d96e216f86f14b87e62837d919172c9ce8f08c854fe7e8f4b0d27d2` |
| 内含 tag | **只有 `pushme-server:3.4.4` 一个** |
| 平台 | linux/amd64 |
| 基础镜像 | node:22-alpine3.22 |
| 与 GHCR 的关系 | 同一份源码构建的产物；本地构建时去掉了 `# syntax=` 行（阿里云镜像站对 dockerfile frontend 返回 403） |

> **为什么只打一个 tag**：`docker load` 出来三行 `Loaded image` 会让人以为有三个不同的镜像，
> 其实 image ID 全等。生产容器挂哪个 tag 就该是哪个版本，多一个 `latest` 只会让「现在跑的是哪版」变模糊。
> 现在离线包和 GHCR 都只出 `<version>` 这一个。

> containerd image store 的 `docker save` 只出 OCI layout（`index.json` + `blobs/sha256/*`），
> 老 `docker load` 不认，而且多 tag 保存时 `manifest.json` 的 RepoTags 会错位。
> 用 `tools/oci2docker.py` 自己拼经典 docker-archive（会递归挑 `linux/amd64` 那一层）：
>
> ```bash
> docker save pushme-server:3.4.4 -o /tmp/s344.tar
> mkdir -p /tmp/oci344 && tar -xf /tmp/s344.tar -C /tmp/oci344
> python3 tools/oci2docker.py /tmp/oci344 /tmp/pushme-3.4.4.tar pushme-server:3.4.4
> gzip -9 -c /tmp/pushme-3.4.4.tar > pushme-server-3.4.4-image.tar.gz
> ```

导入（宝塔终端，或宝塔 Docker 插件的「镜像 → 导入」）：

```bash
sha256sum pushme-server-3.4.4-image.tar.gz   # 应为 47d8a544…27d2
gzip -t pushme-server-3.4.4-image.tar.gz     # 验完整性
docker load -i pushme-server-3.4.4-image.tar.gz
# 期望只有一行：Loaded image: pushme-server:3.4.4

docker run --rm pushme-server:3.4.4 \
  node -p 'require("/pushme-server/package.json").version'   # 应打印 3.4.4
```

起服务：

```bash
mkdir -p /www/wwwroot/pushme-server/config
docker run -d --name pushme-server --restart unless-stopped \
  -p 3010:3010 -p 3100:3100 -e TZ=Asia/Shanghai \
  -v /www/wwwroot/pushme-server/config:/pushme-server/config \
  pushme-server:3.4.4
```

也可以把包放到宝塔能访问的目录，用 compose 里的 `image: pushme-server:3.4.4` 直接引用，不再 build。

### 路线 C：目标机器上现构（最稳，但要求能拉到基础镜像）

```bash
cd /www/wwwroot/pushme-server
rm -f config/data.json            # 别把线上配置烤进镜像
docker build -f docker/Dockerfile -t pushme-server:3.4.4 .
```

---

## 三、镜像里有什么、没有什么

有：`app/ lib/ public/ docker/ server.js package.json`、生产依赖（`npm ci --omit=dev`）、`config.demo`
（只有 `app.js / log.js / view.js` 三个默认配置）。

没有：`config/data.json`、`messages.db*`、证书、`.git`、`node_modules` 里的 dev 依赖。
`docker/Dockerfile.dockerignore` 里显式排掉了 `/config/data.json`，构建时不会夹带。

验证镜像干净（构建后跑一次）：

```bash
docker run --rm pushme-server:3.4.4 sh -c 'ls /pushme-server/config.demo; test ! -f /pushme-server/config.demo/data.json && echo "no secrets"'
```

期望输出：三行 `.js` + `no secrets`。

---

## 四、发布前自检清单

```bash
git status --porcelain                 # 应为空
git log --oneline -1                   # f0f6a8a feat(ui): 消息台账改「消息」…
git ls-files | grep -E "data\.json|messages\.db" # 必须无输出
git ls-files --eol | grep -v "i/lf"    # 除 png/bat 外应全为 LF
npm test                               # 29/29
```

`config/data.json`、`messages.db*`、`config/certs/` 都在 `.gitignore` 里，别用 `git add -f` 强行加。
