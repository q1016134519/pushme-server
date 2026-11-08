#!/bin/bash
# 一键发布到 GitHub：建仓库（没有就建）→ 推送 master → 打 tag 触发镜像构建
#
# 用法：
#   TOKEN=ghp_xxx bash scripts/publish-github.sh
#   TOKEN=ghp_xxx bash scripts/publish-github.sh pushme-server   # 自定义仓库名
#
# 令牌权限：repo（私有仓库再加 workflow）；只推代码不建仓库的话 repo 就够。
# 注意：脚本不会把令牌写进 .git/config，推送时临时用，结束就还原成干净地址。
set -uo pipefail

TOKEN="${TOKEN:-}"
REPO_NAME="${1:-pushme-server}"
OWNER="${OWNER:-q1016134519}"
TAG="v$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"

if [ -z "$TOKEN" ]; then
    echo "✗ 没有令牌。用法：TOKEN=ghp_xxx bash scripts/publish-github.sh"
    exit 1
fi

api() { # api METHOD PATH [BODY]
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -sS -X "$method" "https://api.github.com$path" \
            -H "Authorization: token $TOKEN" \
            -H "Accept: application/vnd.github+json" \
            -d "$body"
    else
        curl -sS -X "$method" "https://api.github.com$path" \
            -H "Authorization: token $TOKEN" \
            -H "Accept: application/vnd.github+json"
    fi
}

echo "== 1. 校验令牌 =="
LOGIN="$(api GET /user | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.login||"")})')"
if [ -z "$LOGIN" ]; then
    echo "✗ 令牌无效（/user 返回空）"
    exit 1
fi
echo "登录身份：$LOGIN"
[ "$LOGIN" != "$OWNER" ] && echo "⚠ 令牌属于 $LOGIN，仓库会建在 $LOGIN 名下（脚本按此调整）" && OWNER="$LOGIN"

echo "== 2. 仓库是否存在 =="
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" \
    "https://api.github.com/repos/$OWNER/$REPO_NAME")"
if [ "$CODE" = "404" ]; then
    echo "仓库不存在，创建 $OWNER/$REPO_NAME"
    api POST /user/repos "{\"name\":\"$REPO_NAME\",\"private\":false,\"description\":\"Self-hosted PushMe server: MQTT push + SQLite ledger + strict PUBACK delivery + web panel\"}" >/dev/null
    sleep 2
else
    echo "仓库已存在（$CODE）"
fi

echo "== 3. 推送代码 =="
REMOTE_URL="https://$OWNER:$TOKEN@github.com/$OWNER/$REPO_NAME.git"
git remote remove mine 2>/dev/null || true
git remote add mine "$REMOTE_URL"
git push -u mine HEAD:master || { echo "✗ 推送失败"; exit 1; }

echo "== 4. 打 tag $TAG =="
git tag -f -a "$TAG" -m "release $TAG" 2>/dev/null || true
git push -f mine "$TAG" || echo "⚠ tag 推送失败（可能已存在同名 tag）"

echo "== 5. 还原干净的远端地址（不留令牌）=="
git remote set-url mine "https://github.com/$OWNER/$REPO_NAME.git"

cat <<TIP

完成。
  仓库：   https://github.com/$OWNER/$REPO_NAME
  构建：   https://github.com/$OWNER/$REPO_NAME/actions
  镜像：   ghcr.io/$OWNER/$REPO_NAME:$TAG   （构建完可 docker pull）

拉取（公开仓库，匿名）：
  docker pull ghcr.io/$OWNER/$REPO_NAME:$TAG
TIP
