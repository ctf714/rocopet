#!/usr/bin/env python3
"""洛克王国桌宠 · 最小安装包终端

从解包数据里挑一只精灵，按勾选的词条（声音 / 性格 / 体型 / 异色 / 炫彩 / 形态）
裁出**只属于这一条进化链**的素材，产出一个自包含的安装包目录。

数据源：
  - 进化链清单：rocom-parse 生成的 chains.json
  - 素材：内置导出器 rocom-pets-export（从主程序尾部载荷解出，zstd 解压）
  - 名称 / 性格 / 炫彩 / 头像：解包目录 parsed/ 下的 Bin 表与 Icon
  - 音频转码：vgmstream-cli（wem → wav）+ soundfile（wav → ogg）

输出：<out>/<图鉴号>-<链首名>/
    petpack.json   本包的全部元信息与词条（我们自己的开放格式）
    icon.png       该精灵的头像（程序图标 / 托盘图标）
    assets/        裁剪后的素材（dump.json + forms/<形态>/ model.glb tex/ voice/ sfx/）
    （可选 --with-runtime）附带桌宠运行时，双击 exe 即可运行

用法：
    python petpack.py                       # 交互式逐步选择
    python petpack.py --list 菊花            # 只搜宠物
    python petpack.py --pet 3227 --form Men_JuHuaLi1_001 --shiny --with-runtime
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

CHAIN_FILE = ROOT / "rocom-pets" / "data" / "chains.json"
PARSED = Path(os.environ.get("ROCOM_PARSED", r"E:/rocopet/parsed"))
BIN = PARSED / "NRC/Content/ScriptC/Data/Bin/BinDataCompressed"
ICON_DIR = PARSED / "NRC/Content/NewRoco/Modules/System/Common/Icon"
EXPORT_EXE = ROOT / ".tools/exporter/rocom-pets-export.exe"
GAME_DIR = Path(os.environ.get("ROCOM_GAME_DIR", r"E:/Program Files/洛克王国：世界(2002304)"))
VGMSTREAM = ROOT / ".tools/vgmstream/vgmstream-cli.exe"
RUNTIME_DIR = Path(os.environ.get("ROCOM_RUNTIME", str(ROOT / "dist-runtime")))

# 叫声情绪（与导出器 voice/ 目录同名）
EMOTIONS = ["Happy", "Shock", "Fear", "Sad", "Anger", "Show", "Relax", "Alert", "CallOut"]


# ──────────────────────────────────────────────────────────────
# 数据加载
# ──────────────────────────────────────────────────────────────
def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def rows(name: str) -> dict:
    p = BIN / f"{name}.json"
    if not p.exists():
        return {}
    return load_json(p).get("RocoDataRows", {})


def load_chains() -> list[dict]:
    return load_json(CHAIN_FILE)["chains"]


def pet_icon(conf_id: str) -> Path | None:
    """conf_id → 头像 PNG。链路：MONSTER/PET_CONF.base_id → PETBASE.model_conf → MODEL_CONF.big_icon"""
    base = None
    for table in ("MONSTER_CONF", "PET_CONF"):
        r = rows(table).get(conf_id)
        if r and r.get("base_id"):
            base = str(r["base_id"])
            break
    base = base or conf_id
    pb = rows("PETBASE_CONF").get(base)
    if not pb:
        return None
    mc = rows("MODEL_CONF").get(str(pb.get("model_conf")))
    if not mc:
        return None
    for key in ("big_icon", "icon"):
        ref = mc.get(key)
        if not ref:
            continue
        m = re.search(r"/Game/(.+?)\.[^./]+'?$", ref) or re.search(r"/Game/(.+)", ref)
        if not m:
            continue
        rel = m.group(1).split(".")[0]
        for cand in (ICON_DIR / f"{rel}.png", PARSED / "NRC" / "Content" / f"{rel}.png"):
            if cand.exists():
                return cand
    return None


# ──────────────────────────────────────────────────────────────
# 交互选择
# ──────────────────────────────────────────────────────────────
def ask(prompt: str, default: str = "") -> str:
    try:
        v = input(f"{prompt}" + (f" [默认 {default}]" if default else "") + ": ").strip()
    except EOFError:
        return default
    return v or default


def pick(prompt: str, options: list[str]) -> int:
    for i, o in enumerate(options, 1):
        print(f"  {i:>3}. {o}")
    while True:
        v = ask(prompt, "1")
        if v.isdigit() and 1 <= int(v) <= len(options):
            return int(v) - 1
        print(f"  请输入 1~{len(options)}")


def choose_chain(chains: list[dict]) -> dict:
    key = ask("搜宠物（中文名 / 图鉴号 / 编号，留空列全部）").strip()
    hits = [c for c in chains
            if not key
            or key in c["name"]
            or key.zfill(3) == str(c["book"]).zfill(3)
            or key in [str(i) for f in c["forms"] for i in f["ids"]]]
    if not hits:
        raise SystemExit(f"没找到「{key}」")
    hits.sort(key=lambda c: c["book"])
    show = hits[:50]
    labels = [f"{str(c['book']).zfill(3)} {c['name']}（{len(c['forms'])} 形态）" for c in show]
    if len(hits) > len(show):
        print(f"  （共 {len(hits)} 条，只列前 {len(show)} 条，换个关键词缩小范围）")
    return show[pick("选哪条进化链", labels)]


# ──────────────────────────────────────────────────────────────
# 导出 + 裁剪
# ──────────────────────────────────────────────────────────────
def export(species: str, dump_dir: Path, glassy: bool) -> Path:
    """调内置导出器产出原始 dump，返回链目录"""
    if not EXPORT_EXE.exists():
        raise SystemExit(f"缺少导出器：{EXPORT_EXE}")
    cmd = [str(EXPORT_EXE), "--species", species, "--game-dir", str(GAME_DIR), "--out", str(dump_dir)]
    if not glassy:
        cmd.append("--no-glassy")
    print(f"  导出：{os.path.basename(str(EXPORT_EXE))} --species {species} …")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800)
    if r.returncode != 0:
        raise SystemExit(f"导出失败（{r.returncode}）：\n{r.stdout}\n{r.stderr}")
    for line in (r.stdout or "").splitlines():
        if line.strip():
            print("    " + line)
    dirs = [d for d in dump_dir.iterdir() if d.is_dir() and (d / "dump.json").exists()]
    if not dirs:
        raise SystemExit("导出器没产出任何链目录")
    return dirs[0]


def convert_audio(root: Path) -> tuple[int, int]:
    """wem → ogg（vgmstream 解码 + libsndfile 编码）。返回 (文件数, 省下字节)"""
    wems = list(root.rglob("*.wem"))
    if not wems:
        return 0, 0
    if not VGMSTREAM.exists():
        print(f"  [warn] 缺 {VGMSTREAM.name}，跳过音频转码（wem 无法直接播放）")
        return 0, 0
    try:
        import soundfile as sf
    except Exception:
        sf = None
    saved = 0
    n = 0
    for w in wems:
        wav = w.with_suffix(".wav")
        subprocess.run([str(VGMSTREAM), "-o", str(wav), str(w)],
                       capture_output=True, timeout=300)
        if not wav.exists():
            continue
        if sf is not None:
            try:
                data, sr = sf.read(str(wav), dtype="int16")
                sf.write(str(w.with_suffix(".ogg")), data, sr, format="OGG", subtype="VORBIS")
                wav.unlink()
            except Exception as e:
                print(f"  [warn] {w.name} 转 ogg 失败，保留 wav：{e}")
                wav.rename(w.with_suffix(".wav"))
        saved += w.stat().st_size
        w.unlink()
        n += 1
    return n, saved


def prune(chain_dir: Path, form_asset: str, shiny: bool, sound: str,
          emotions: list[str], single_form: bool, convert: bool) -> dict:
    """按词条裁剪。返回统计"""
    dump = load_json(chain_dir / "dump.json")
    names = [f["asset"] for f in dump["forms"]]
    if form_asset not in names:
        raise SystemExit(f"包里没有形态 {form_asset}；有的是：" + ", ".join(names))

    stat = {"form": form_asset, "removed_forms": 0, "removed_tex": 0,
            "removed_audio": 0, "kept_tex": 0, "kept_audio": 0, "converted": 0}

    forms_root = chain_dir / "forms"

    # 1) 形态：默认整条链都留着（等级到了会进化），--single-form 只留一只
    if single_form:
        for d in list(forms_root.iterdir()):
            if d.is_dir() and d.name != form_asset:
                shutil.rmtree(d)
                stat["removed_forms"] += 1

    # 2) 异色：异色贴图按 _101_ / yise 命名判定
    for fdir in [d for d in forms_root.iterdir() if d.is_dir()]:
        tex_dir = fdir / "tex"
        if not tex_dir.exists():
            continue
        for p in list(tex_dir.iterdir()):
            is_shiny = ("_101_" in p.name) or p.name.endswith("_yise.png") or ("yise" in p.stem.lower())
            if is_shiny and not shiny:
                p.unlink()
                stat["removed_tex"] += 1
        stat["kept_tex"] += len(list(tex_dir.iterdir()))

    # 3) 声音：voice/ 叫声、sfx/ 动作音效，可按情绪白名单裁
    for fdir in [d for d in forms_root.iterdir() if d.is_dir()]:
        for sub, keep_all in (("voice", sound in ("voice", "both")), ("sfx", sound in ("sfx", "both"))):
            d = fdir / sub
            if not d.exists():
                continue
            if not keep_all:
                shutil.rmtree(d)
                continue
            if emotions:
                for p in list(d.iterdir()):
                    if p.stem not in emotions:
                        p.unlink()
                        stat["removed_audio"] += 1
            stat["kept_audio"] += len(list(d.iterdir()))

    # 4) wem → ogg
    if convert:
        n, _ = convert_audio(forms_root)
        stat["converted"] = n

    form = next(f for f in dump["forms"] if f["asset"] == form_asset)
    stat["height_cm"] = form.get("height_cm")
    stat["clips"] = len(form.get("clips", []))
    return stat


def build_glassy(dest: Path, glassy_src: Path | None) -> dict | None:
    """
    把炫彩素材写进包。官方的做法（见 rocom-parse/docs/data.md「炫彩色卡」一节）：
      一只宠的炫彩 = 配色 + 粒子，glass_value = (粒子id << 20) | 配色id
      配色 39 种在 COLOR_RANDOM_CONF，是纯数值（mat_color_1 / mat_color_2 / shine_strength）；
      粒子 4 种在 PARTICLE_RANDOM_CONF，各是一张黑底白图案的贴图。
    配色是数值所以零成本全带；粒子贴图从导出器产出的 glassy/ 目录里挑。
    """
    colors = rows("COLOR_RANDOM_CONF")
    parts = rows("PARTICLE_RANDOM_CONF")
    if not colors:
        return None

    gdir = dest / "assets" / "glassy"
    gdir.mkdir(parents=True, exist_ok=True)
    out = {"colors": [], "particles": []}

    for c in sorted(colors.values(), key=lambda x: int(x.get("id", 0) or 0)):
        out["colors"].append({
            "id": int(c.get("id", 0) or 0),
            "name": c.get("name") or f"配色{c.get('id')}",
            "c1": c.get("mat_color_1") or [1, 1, 1],
            "c2": c.get("mat_color_2") or [1, 1, 1],
            "shine": c.get("shine_strength", 10),
        })

    for p in sorted(parts.values(), key=lambda x: int(x.get("id", 0) or 0)):
        res = p.get("particle_res") or ""
        m = re.search(r"/([A-Za-z0-9_]+)\.[A-Za-z0-9_]+'?\s*$", res)
        if not m:
            continue
        stem = m.group(1)
        src = (glassy_src / f"{stem}.png") if glassy_src else None
        if not src or not src.exists():
            print(f"    [warn] 缺粒子贴图 {stem}.png，跳过该粒子")
            continue
        shutil.copy2(src, gdir / f"{stem}.png")
        out["particles"].append({
            "id": int(p.get("id", 0) or 0),
            "name": p.get("name") or stem,
            "tex": f"{stem}.png",
        })

    (gdir / "glassy.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def has_shiny_tex(dest: Path) -> bool:
    """包里是否真有异色贴图。官方只有部分宠物做了异色美术（见 data.md 异色一节，
    291/261/244 项），多数宠异色复用普通图 —— 没有就别在设置里给出这个开关。"""
    for p in (dest / "assets" / "forms").rglob("*"):
        if p.is_file() and ("_101_" in p.name or "yise" in p.stem.lower()):
            return True
    return False


# ──────────────────────────────────────────────────────────────
# 组装
# ──────────────────────────────────────────────────────────────
def build(out_root: Path, chain: dict, form_asset: str, dump_chain_dir: Path,
          opts: dict, stat: dict) -> Path:
    name = f"{str(chain['book']).zfill(3)}-{chain['name']}"
    dest = out_root / name
    if dest.exists():
        # 不直接删：先把旧包挪到 _backup/，避免误删用户数据
        backup = out_root / "_backup" / f"{name}-{os.getpid()}"
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dest), str(backup))
        print(f"  旧包已挪到 {backup}")
    (dest / "assets").mkdir(parents=True)

    shutil.move(str(dump_chain_dir / "forms"), str(dest / "assets" / "forms"))
    shutil.copy2(dump_chain_dir / "dump.json", dest / "assets" / "dump.json")
    dump = load_json(dest / "assets" / "dump.json")

    # 炫彩：配色 39 种（纯数值）+ 粒子贴图，导出器把它们放在 out/glassy/ 下
    glassy = build_glassy(dest, dump_chain_dir.parent / "glassy")
    if glassy:
        print(f"    炫彩：配色 {len(glassy['colors'])} 种、粒子 {len(glassy['particles'])} 种")

    # 头像 → icon.png
    icon_src = pet_icon(str(chain["forms"][0]["ids"][0]))
    if icon_src:
        shutil.copy2(icon_src, dest / "icon.png")

    raw_forms = sorted(
        ({"asset": f["asset"], "name": f.get("name") or f["asset"], "stage": f.get("stage") or 1}
         for f in dump.get("chain", {}).get("forms", [])),
        key=lambda f: f["stage"])
    # 同一阶段可能有分支形态（例如喵喵 stage4 有两个）；进化主线只取每阶段第一个
    chain_forms, seen = [], set()
    for f in raw_forms:
        if f["stage"] in seen:
            continue
        seen.add(f["stage"])
        chain_forms.append(f)
    if not chain_forms:
        chain_forms = [{"asset": form_asset, "name": chain["name"], "stage": 1}]

    manifest = {
        "format": "petpack/1",
        "book": chain["book"],
        "chain": chain["name"],
        "form": form_asset,
        "form_name": next((f["name"] for f in chain["forms"] if f["asset"] == form_asset), form_asset),
        "chain_forms": chain_forms,
        "traits": {
            "shiny": opts["shiny"],
            "has_shiny": has_shiny_tex(dest),   # 有没有异色美术，决定设置页要不要给开关
            "glassy": opts["glassy"],
            "glassy_colors": len(glassy["colors"]) if glassy else 0,
            "glassy_particles": len(glassy["particles"]) if glassy else 0,
            "sound": opts["sound"],
            "emotions": opts["emotions"],
            "nature": opts["nature"],
            "voice": opts["voice"],
            "height_cm": stat.get("height_cm"),
            "px_per_cm": opts["px_per_cm"],
        },
        "stats": stat,
    }
    (dest / "petpack.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    if opts["with_runtime"]:
        attach_runtime(dest, chain, icon_src)
    return dest


def attach_runtime(dest: Path, chain: dict, icon_src: Path | None) -> None:
    """把桌宠运行时拷进包里，exe 换成该精灵的图标与名字"""
    if not RUNTIME_DIR.exists():
        print(f"  [warn] 没有运行时目录 {RUNTIME_DIR}，跳过（先跑 build_runtime.py）")
        return
    for item in RUNTIME_DIR.iterdir():
        s, d = item, dest / item.name
        if d.exists():
            continue
        if item.is_dir():
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
    exe = dest / f"{chain['name']}.exe"
    src_exe = dest / "桌宠.exe"
    if not src_exe.exists():
        src_exe = dest / "electron.exe"
    if src_exe.exists():
        shutil.move(str(src_exe), str(exe))
        sys.path.insert(0, str(ROOT))
        try:
            from exeicon import set_exe_icon
            ok = set_exe_icon(exe, icon_src, chain["name"])
            print(f"  程序图标：{'已换成 ' + icon_src.name if ok else '未替换'}")
        except Exception as e:
            print(f"  [warn] 换图标失败：{e}")
    print(f"  运行时已附带 → {exe.name}")


def dirsize(p: Path) -> tuple[int, int]:
    n = s = 0
    for f in p.rglob("*"):
        if f.is_file():
            n += 1
            s += f.stat().st_size
    return n, s


# ──────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="生成某精灵某形态的最小安装包")
    ap.add_argument("--list", metavar="关键字", nargs="?", const="", help="只搜索并列出宠物链")
    ap.add_argument("--pet", help="宠物：图鉴号 / 中文名 / conf_id")
    ap.add_argument("--form", help="形态资产名，默认链首（整条链都会打进包里）")
    ap.add_argument("--single-form", action="store_true", help="只保留选定的一个形态（不能进化）")
    ap.add_argument("--shiny", action="store_true", help="保留异色（默认删掉异色贴图）")
    ap.add_argument("--no-glassy", action="store_true", help="不导出炫彩共享素材")
    ap.add_argument("--sound", choices=["voice", "sfx", "both", "none"], default="both")
    ap.add_argument("--emotions", help="只保留这些情绪的声音，逗号分隔（默认全留）")
    ap.add_argument("--nature", help="性格名或 id，默认 1（大胆）")
    ap.add_argument("--voice", type=int, default=0, help="嗓音 -100~100，默认 0")
    ap.add_argument("--px-per-cm", type=float, default=2.0, help="体型：每厘米像素，默认 2.0")
    ap.add_argument("--no-convert", action="store_true", help="不把 wem 转成 ogg")
    ap.add_argument("--with-runtime", action="store_true", help="附带桌宠运行时（exe 图标为该精灵）")
    ap.add_argument("--out", default=str(ROOT / "dist"), help="输出根目录")
    args = ap.parse_args()

    chains = load_chains()

    if args.list is not None:
        key = args.list
        hits = [c for c in chains if not key or key in c["name"] or key in str(c["book"])]
        for c in sorted(hits, key=lambda c: c["book"])[:60]:
            forms = " → ".join(f["name"] for f in c["forms"])
            print(f"{str(c['book']).zfill(3)}  {c['name']:<8s} {forms}")
        print(f"共 {len(hits)} 条")
        return 0

    # ── 选宠物 ──
    if args.pet:
        key = args.pet
        hits = [c for c in chains
                if key == str(c["book"]) or key in c["name"]
                or key in [str(i) for f in c["forms"] for i in f["ids"]]]
        if not hits:
            raise SystemExit(f"没找到宠物「{key}」")
        chain = hits[0]
        if len(hits) > 1:
            print(f"  （{key} 命中 {len(hits)} 条，取第一条：{chain['name']}）")
    else:
        chain = choose_chain(chains)
    book = str(chain["book"]).zfill(3)
    print(f"\n== 选中 {book} {chain['name']} ==")

    # ── 选形态 ──
    if args.form:
        form_asset = args.form
    elif len(chain["forms"]) == 1:
        form_asset = chain["forms"][0]["asset"]
    else:
        labels = [f"{f['name']}（stage {f.get('stage','?')} · {f['asset']}）" for f in chain["forms"]]
        form_asset = chain["forms"][pick("选形态", labels)]["asset"]
    print(f"  形态：{form_asset}")

    # ── 词条 ──
    natures = rows("AUDIO_NATURE_CONF")
    nature = args.nature
    if not nature:
        opts_n = [f"{k} {v.get('name')}" for k, v in sorted(natures.items(), key=lambda kv: int(kv[0]))]
        idx = pick("性格", opts_n) if opts_n else 0
        nature = opts_n[idx].split()[0] if opts_n else "1"
    nature_name = natures.get(str(nature), {}).get("name", str(nature))

    emotions = [e.strip() for e in args.emotions.split(",")] if args.emotions else []
    opts = {
        "shiny": args.shiny,
        "glassy": not args.no_glassy,
        "sound": args.sound,
        "emotions": emotions or list(EMOTIONS),
        "nature": f"{nature} {nature_name}".strip(),
        "voice": max(-100, min(100, args.voice)),
        "px_per_cm": args.px_per_cm,
        "with_runtime": args.with_runtime,
    }
    print(f"  词条：异色={'开' if opts['shiny'] else '关'}  炫彩={'开' if opts['glassy'] else '关'}  "
          f"声音={opts['sound']}  性格={opts['nature']}  嗓音={opts['voice']}  每厘米 {opts['px_per_cm']}px")

    # ── 导出 + 裁剪 + 组装 ──
    species = str(chain["forms"][0]["ids"][0])
    tmp = Path(tempfile.mkdtemp(prefix="petpack-"))
    try:
        print("\n[1/4] 导出素材…")
        chain_dir = export(species, tmp / "dump", opts["glassy"])
        print("[2/4] 按词条裁剪…")
        stat = prune(chain_dir, form_asset, opts["shiny"], opts["sound"], emotions,
                     args.single_form, not args.no_convert)
        print(f"    删掉其它形态 {stat['removed_forms']} 个、贴图 {stat['removed_tex']} 张、"
              f"音频 {stat['removed_audio']} 段；保留贴图 {stat['kept_tex']}、音频 {stat['kept_audio']}，"
              f"转 ogg {stat['converted']} 段")
        print("[3/4] 组装安装包…")
        dest = build(Path(args.out), chain, form_asset, chain_dir, opts, stat)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    n, s = dirsize(dest)
    print(f"\n完成 → {dest}")
    print(f"  {n} 个文件，{s/1048576:.1f} MB；动作 {stat['clips']} 段，身高 {stat.get('height_cm'):.1f} cm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
