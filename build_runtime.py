#!/usr/bin/env python3
"""把 deskpet/ 打成一个可直接双击运行的运行时目录 dist-runtime/

    electron 二进制（改名 桌宠.exe）+ resources/app/（我们的代码 + three）

产出后可用 petpack.py --with-runtime 把它拷进任意宠物包。
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "deskpet"
ELECTRON_DIST = SRC / "node_modules" / "electron" / "dist"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist-runtime"

THREE_FILES = [
    "build/three.module.js",
    "examples/jsm/loaders/GLTFLoader.js",
    "examples/jsm/utils/BufferGeometryUtils.js",
]


def main() -> int:
    if not ELECTRON_DIST.exists():
        raise SystemExit(f"没有 electron：{ELECTRON_DIST}\n先在 deskpet/ 里 npm install")

    print(f"[1/3] 清理 → {OUT}")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    print("[2/3] 拷贝 electron 运行时…")
    for item in ELECTRON_DIST.iterdir():
        if item.name in ("resources",):
            continue
        d = OUT / item.name
        if item.is_dir():
            shutil.copytree(item, d)
        else:
            shutil.copy2(item, d)
    exe = OUT / "electron.exe"
    if not exe.exists():
        raise SystemExit(f"electron.exe 不在 {OUT}")
    exe.rename(OUT / "桌宠.exe")

    app = OUT / "resources" / "app"
    (app / "renderer").mkdir(parents=True)
    (app / "vendor" / "three" / "build").mkdir(parents=True)
    (app / "vendor" / "three" / "examples" / "jsm" / "loaders").mkdir(parents=True)
    (app / "vendor" / "three" / "examples" / "jsm" / "utils").mkdir(parents=True)

    print("[3/3] 放入应用代码与 three…")
    for f in ("main.js", "preload.js"):
        shutil.copy2(SRC / f, app / f)
    (app / "package.json").write_text(
        json.dumps({"name": "rocopet", "version": "1.0.0", "main": "main.js"}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    for f in (SRC / "renderer").iterdir():
        if f.is_file():
            shutil.copy2(f, app / "renderer" / f.name)

    for rel in THREE_FILES:
        s = SRC / "node_modules" / "three" / rel
        if not s.exists():
            print(f"  [warn] 缺 {rel}")
            continue
        shutil.copy2(s, app / "vendor" / "three" / rel)

    n = sum(1 for _ in OUT.rglob("*") if _.is_file())
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"\n完成 → {OUT}")
    print(f"  {n} 个文件，{size/1048576:.0f} MB，启动程序：{OUT / '桌宠.exe'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
