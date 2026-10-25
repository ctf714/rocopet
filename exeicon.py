"""给 exe 换图标 / 版本信息（用 rcedit，路径必须是纯 ASCII，所以走临时目录）"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RCEDIT = ROOT / ".tools" / "rcedit-x64.exe"


def png_to_ico(png: Path, ico: Path) -> None:
    from PIL import Image
    im = Image.open(png).convert("RGBA")
    im.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def set_exe_icon(exe: Path, png: Path | None, title: str = "洛克王国桌宠") -> bool:
    """把 exe 的图标与产品名换成指定 PNG。返回是否成功。"""
    if not RCEDIT.exists() or not png or not Path(png).exists():
        return False
    tmp = Path(tempfile.mkdtemp(prefix="rcedit-"))
    try:
        ico = tmp / "a.ico"
        png_to_ico(Path(png), ico)
        work = tmp / "a.exe"
        shutil.copy2(exe, work)
        r = subprocess.run([
            str(RCEDIT), str(work),
            "--set-icon", str(ico),
            "--set-file-version", "1.0.0.0",
            "--set-product-version", "1.0.0.0",
            "--set-version-string", "ProductName", "洛克王国桌宠",
            "--set-version-string", "FileDescription", title,
            "--set-version-string", "OriginalFilename", exe.name,
        ], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(f"  [warn] rcedit: {(r.stdout or '') + (r.stderr or '')}".strip())
            return False
        shutil.copy2(work, exe)
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
