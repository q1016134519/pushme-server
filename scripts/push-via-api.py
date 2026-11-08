#!/usr/bin/env python3
"""通过 GitHub REST Git Data API 推送当前分支（绕过 git push 被重置）。

用法：
    TOKEN=ghp_xxx python scripts/push-via-api.py [owner/repo] [branch]

做的事：
    1. 仓库不存在就用 /user/repos 建（公开）
    2. 空仓库先用 Contents API 塞一个 README 引导，否则 Git Data API 返回 409
    3. git ls-tree -r HEAD 取真实 blob sha（对象库内是 LF，避开 Windows CRLF 污染）
    4. 并行 POST /git/blobs（8 线程，403 rate limit 时退避重试）
    5. POST /git/trees → POST /git/commits（有远端分支就挂 parent）→ PATCH ref
    6. 设默认分支、删多余分支、打 tag
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://api.github.com"
TOKEN = os.environ.get("TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
REPO = sys.argv[1] if len(sys.argv) > 1 else "q1016134519/pushme-server"
BRANCH = sys.argv[2] if len(sys.argv) > 2 else "master"
TAG = "v" + json.load(open("package.json", encoding="utf-8"))["version"]


def call(method, path, body=None, raw=False, retries=4):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(
            API + path if path.startswith("/") else path,
            data=data,
            method=method,
            headers={
                "Authorization": "token " + TOKEN,
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "push-via-api",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode()
                return resp.status, (text if raw else (json.loads(text) if text else None))
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            if e.code in (403, 429) and attempt < retries - 1:
                wait = 30 * (attempt + 1)
                print(f"   ! {e.code} 限流/拒绝，{wait}s 后重试：{text[:160]}")
                time.sleep(wait)
                continue
            if e.code >= 500 and attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            return e.code, text
    return 0, "retries exhausted"


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def main():
    if not TOKEN:
        sys.exit("缺少 TOKEN 环境变量")
    owner, name = REPO.split("/")

    status, me = call("GET", "/user")
    login = me.get("login") if isinstance(me, dict) else None
    print(f"== 身份：{login} ==")
    if login and login != owner:
        print(f"   令牌属于 {login}，仓库改到 {login}/{name}")
        owner = login

    status, repo = call("GET", f"/repos/{owner}/{name}")
    if status == 404:
        print(f"== 仓库不存在，创建 {owner}/{name} ==")
        status, repo = call("POST", "/user/repos", {
            "name": name,
            "private": False,
            "description": "Self-hosted PushMe server: MQTT push + SQLite ledger + strict PUBACK delivery + web panel",
        })
        if status not in (200, 201):
            sys.exit(f"建仓失败 {status}: {repo}")
    else:
        print(f"== 仓库已存在：{owner}/{name} ==")

    # 空仓库需要引导提交
    status, _ = call("GET", f"/repos/{owner}/{name}/contents/README.md")
    if status == 404:
        print("   空仓库：先用 Contents API 引导")
        call("PUT", f"/repos/{owner}/{name}/contents/README.md", {
            "message": "init",
            "content": base64.b64encode(b"# pushme-server\n").decode(),
        })
        time.sleep(2)

    # 1) 枚举本地树
    entries = []
    for line in git("ls-tree", "-r", "HEAD").decode().splitlines():
        meta, path = line.split("\t", 1)
        mode, typ, sha = meta.split()
        if typ != "blob":
            continue
        entries.append({"path": path, "mode": mode, "sha": sha})
    print(f"== 本地对象：{len(entries)} 个 blob ==")

    # 2) 并行上传 blob
    def upload(e):
        content = git("cat-file", "blob", e["sha"])
        st, res = call("POST", f"/repos/{owner}/{name}/git/blobs", {
            "content": base64.b64encode(content).decode(),
            "encoding": "base64",
        })
        if st not in (200, 201):
            raise RuntimeError(f"blob {e['path']} 上传失败 {st}: {str(res)[:200]}")
        return res["sha"]

    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(upload, e): e for e in entries}
        for fut, e in futs.items():
            pass
        results = {}
        for fut, e in futs.items():
            results[e["path"]] = fut.result()
            done += 1
            if done % 20 == 0:
                print(f"   blob {done}/{len(entries)}")
    print(f"   blob 全部完成（{done}）")

    # 3) tree
    tree_entries = [{
        "path": e["path"],
        "mode": "100755" if e["mode"] == "100755" else "100644",
        "type": "blob",
        "sha": results[e["path"]],
    } for e in entries]
    st, tree = call("POST", f"/repos/{owner}/{name}/git/trees", {"tree": tree_entries})
    if st not in (200, 201):
        sys.exit(f"tree 失败 {st}: {str(tree)[:400]}")
    print(f"== tree: {tree['sha']} ==")

    # 4) parent（远端已有分支就接上）
    parents = []
    st, ref = call("GET", f"/repos/{owner}/{name}/git/ref/heads/{BRANCH}")
    if st == 200 and isinstance(ref, dict):
        parents = [ref["object"]["sha"]]
        print(f"   远端 {BRANCH} 已存在，parent={parents[0][:12]}")
    else:
        print("   远端分支不存在，首个提交")

    head_commit = git("rev-parse", "HEAD").decode().strip()
    msg = git("log", "-1", "--pretty=%s").decode().strip()
    st, commit = call("POST", f"/repos/{owner}/{name}/git/commits", {
        "message": msg,
        "tree": tree["sha"],
        "parents": parents,
    })
    if st not in (200, 201):
        sys.exit(f"commit 失败 {st}: {str(commit)[:400]}")
    print(f"== commit: {commit['sha']} ({msg}) ==")
    print(f"   本地 HEAD={head_commit[:12]}（内容一致，sha 因历史不同而不同）")

    # 5) 建/更新 ref
    if parents:
        st, res = call("PATCH", f"/repos/{owner}/{name}/git/refs/heads/{BRANCH}",
                       {"sha": commit["sha"], "force": True})
    else:
        st, res = call("POST", f"/repos/{owner}/{name}/git/refs",
                       {"ref": f"refs/heads/{BRANCH}", "sha": commit["sha"]})
    if st not in (200, 201):
        sys.exit(f"ref 失败 {st}: {str(res)[:400]}")
    print(f"== {BRANCH} -> {commit['sha'][:12]} ==")

    call("PATCH", f"/repos/{owner}/{name}", {"default_branch": BRANCH})
    if BRANCH != "main":
        st, _ = call("DELETE", f"/repos/{owner}/{name}/git/refs/heads/main")
        if st in (204, 200):
            print("   删掉了多余的 main 分支")

    # 6) tag
    st, res = call("POST", f"/repos/{owner}/{name}/git/refs",
                   {"ref": f"refs/tags/{TAG}", "sha": commit["sha"]})
    if st in (200, 201):
        print(f"== tag {TAG} -> {commit['sha'][:12]} ==")
    elif st == 422:
        st2, _ = call("PATCH", f"/repos/{owner}/{name}/git/refs/tags/{TAG}",
                      {"sha": commit["sha"], "force": True})
        print(f"== tag {TAG} 已存在，强制更新：{st2} ==")
    else:
        print(f"   ⚠ tag 失败 {st}: {str(res)[:200]}")

    print(f"\n仓库 https://github.com/{owner}/{name}\n分支 {BRANCH}  tag {TAG}")
    print(f"镜像 ghcr.io/{owner}/{name}:{TAG}")
    print("::TAG=%s::" % TAG)
    print("::SHA=%s::" % commit["sha"])


if __name__ == "__main__":
    main()
