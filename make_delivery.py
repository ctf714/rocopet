#!/usr/bin/env python3
"""把一个宠物包 + 运行时组装成可直接双击运行的目录。

    python make_delivery.py --pack dist/079-菊花梨 --dest "E:/rocopet/桌宠"
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "dist-runtime"
sys.path.insert(0, str(ROOT))

README = """洛克王国桌宠
================

双击「{exe}」直接启动。桌面上只有宠物本身，没有任何按钮和进度条。

怎么跟它玩：
  · 左键单击      冒出几颗淡粉色爱心，很快消散
  · 左键双击      喂食          +5 经验、好感 +6（5 分钟冷却）
  · 左键三击      睡觉 / 叫醒
  · 右键单击      摸摸头        +2 经验、好感 +2（15 秒冷却）
  · 按住拖动      把它拖到屏幕任意位置，位置会被记住
  · 鼠标不在它身上时，点击会直接穿透到桌面，不影响正常操作

等级、经验、好感度在哪看：
  右下角托盘图标 → 右键 → 菜单顶部就是（Lv / 经验 / 好感十格条）。
  同一个菜单里还有：喂食、摸摸头、睡觉/叫醒、待办事项、专注计时、设置、历史、退出。

养成规则：
  · 完成一条待办          +25 经验（专注计时中完成 +50）、好感 +4
  · 喂食                  +5 经验、好感 +6
  · 摸摸头                +2 经验、好感 +2
  · 专注计时完成          +30 经验、好感 +5
  · 等级到达 8 / 18 / 30 时进化到下一形态（本包包含整条进化链）

好感度会解锁更多自主动作：
  20 → 开心、炫耀      40 → 放松、召唤、震惊      60 → 奔跑、难过、惊恐      80 → 技能动作

文件说明：
  petpack.json   本包词条（形态、异色、声音、性格、体型…）
  icon.png       托盘与程序图标
  assets/        该进化链的模型、贴图、动作、语音
  其它           Electron 运行时（不要删）
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", required=True, help="宠物包目录（含 petpack.json）")
    ap.add_argument("--dest", required=True, help="输出目录")
    ap.add_argument("--name", help="exe 名字，默认用 petpack.json 里的 chain")
    args = ap.parse_args()

    pack = Path(args.pack).resolve()
    dest = Path(args.dest).resolve()
    if not (pack / "petpack.json").exists():
        raise SystemExit(f"{pack} 里没有 petpack.json")
    if not (RUNTIME / "桌宠.exe").exists():
        raise SystemExit(f"没有运行时，先跑 build_runtime.py（{RUNTIME}）")

    import json
    manifest = json.loads((pack / "petpack.json").read_text(encoding="utf-8"))
    exe_name = args.name or manifest.get("chain") or "桌宠"

    if dest.exists():
        bak = dest.parent / "_backup" / f"{dest.name}-{time.strftime('%Y%m%d-%H%M%S')}"
        bak.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dest), str(bak))
        print(f"旧目录已挪到 {bak}")

    print(f"[1/3] 拷贝运行时 → {dest}")
    shutil.copytree(RUNTIME, dest)

    print("[2/3] 放入宠物包…")
    for item in pack.iterdir():
        s, d = item, dest / item.name
        if d.exists():
            shutil.rmtree(d) if d.is_dir() else d.unlink()
        shutil.copytree(s, d) if item.is_dir() else shutil.copy2(s, d)

    print("[3/3] 改 exe 名字与图标…")
    src_exe = dest / "桌宠.exe"
    exe = dest / f"{exe_name}.exe"
    if src_exe.exists():
        src_exe.rename(exe)
    icon = dest / "icon.png"
    try:
        from exeicon import set_exe_icon
        ok = set_exe_icon(exe, icon, exe_name)
        print(f"  图标：{'已换成 ' + icon.name if ok else '未替换'}")
    except Exception as e:
        print(f"  [warn] 换图标失败：{e}")

    (dest / "使用说明.txt").write_text(README.format(exe=exe.name), encoding="utf-8")

    n = sum(1 for _ in dest.rglob("*") if _.is_file())
    size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file())
    print(f"\n完成 → {dest}")
    print(f"  {n} 个文件，{size/1048576:.0f} MB，启动：{exe}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
