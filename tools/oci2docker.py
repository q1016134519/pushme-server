#!/usr/bin/env python3
"""把 containerd image store 的 docker save 产物（OCI layout）转成经典 docker-archive。

用法：
    oci2docker.py <oci目录> <输出.tar> [额外tag ...]

OCI 目录里应有 index.json + blobs/sha256/*。输出 tar 含：
    <config-sha>.json     每个唯一 config 一份
    blobs/sha256/<layer>  原样 layers（gzip 与否都照搬，docker load 自己解）
    manifest.json         Config / RepoTags / Layers
"""
import io
import json
import os
import sys
import tarfile


def blob_path(root, digest):
    algo, hexd = digest.split(":", 1)
    return os.path.join(root, "blobs", algo, hexd)


def load_json(root, digest):
    with open(blob_path(root, digest), encoding="utf-8") as f:
        return json.load(f)


def pick_manifest(root, digest, want_arch="amd64"):
    """index.json 里的 digest 可能是嵌套 index（多平台），递归挑一个平台。"""
    d = load_json(root, digest)
    if "manifests" in d and "config" not in d:
        cands = d["manifests"]
        chosen = None
        for m in cands:
            plat = m.get("platform", {})
            if plat.get("os") == "linux" and plat.get("architecture") == want_arch:
                chosen = m
                break
        if chosen is None:
            chosen = cands[0]
        return pick_manifest(root, chosen["digest"], want_arch)
    return d


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    extra = sys.argv[3:]

    idx = json.load(open(os.path.join(src, "index.json"), encoding="utf-8"))
    entries = {}   # ref -> {config, layers}
    for m in idx["manifests"]:
        ann = m.get("annotations", {})
        ref = ann.get("io.containerd.image.name") or ("docker.io/library/" + ann.get("org.opencontainers.image.ref.name", "unknown"))
        if ref.startswith("docker.io/library/"):
            ref = ref[len("docker.io/library/"):]
        man = pick_manifest(src, m["digest"])
        entries[ref] = {
            "config": man["config"]["digest"],
            "layers": [l["digest"] for l in man["layers"]],
        }
        if not man["layers"]:
            sys.exit("manifest 没有 layers，可能挑错了平台")

    if not entries:
        sys.exit("index.json 里没有 manifest")

    # 同一 config+layers 的多个 ref 合成一条 manifest 记录
    groups = {}
    for ref, e in entries.items():
        groups.setdefault((e["config"], tuple(e["layers"])), []).append(ref)

    manifests = []
    for (cfg, layers), tags in groups.items():
        cfg_hex = cfg.split(":", 1)[1]
        manifests.append({
            "Config": cfg_hex + ".json",
            # ONLY 指定时只留这一个 tag，方便做「包里只有一个名字」的离线包
            "RepoTags": sorted(set(tags) | set(extra)),
            "Layers": ["blobs/" + d.replace(":", "/") for d in layers],
        })

    all_cfgs = {e["config"] for e in entries.values()}
    all_layers = {d for e in entries.values() for d in e["layers"]}

    def add(tf, path, arcname):
        ti = tf.gettarinfo(path, arcname=arcname)
        ti.mtime = 0
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        with open(path, "rb") as f:
            tf.addfile(ti, f)

    with tarfile.open(out, "w") as tf:
        for d in sorted(all_cfgs):
            add(tf, blob_path(src, d), d.split(":", 1)[1] + ".json")
        for d in sorted(all_layers):
            add(tf, blob_path(src, d), "blobs/" + d.replace(":", "/"))
        data = json.dumps(manifests, indent=1).encode()
        ti = tarfile.TarInfo("manifest.json")
        ti.size = len(data)
        ti.mtime = 0
        tf.addfile(ti, io.BytesIO(data))

    print("wrote", out, os.path.getsize(out), "bytes")
    for m in manifests:
        print("  tags:", m["RepoTags"], "layers:", len(m["Layers"]))


if __name__ == "__main__":
    main()
