# rocopet

把《洛克王国：世界》的精灵做成 Windows 桌面宠物。桌面只有一个透明置顶窗口，
没有按钮和进度条 —— 点击、喂食、摸头、睡觉全靠鼠标手势，等级和好感度收在托盘菜单里。

仓库里只有**源码和脚本**（约 385 KB）。运行时、解包素材、第三方工具都不入库，按下面的流程本地生成。

## 目录

```
deskpet/        桌宠应用本体（Electron + three.js）
  main.js         主进程：窗口几何、托盘菜单、本地静态服务、IPC
  preload.js      渲染进程桥
  renderer/       渲染页面：pet.js 是 three.js 场景，app.js 是交互与养成
petpack/        petpack.py 从解包素材裁出单条进化链，产出宠物包
rocom-pets/     data/chains.json 进化链清单（rocom-parse 的产物，195 KB）
build_runtime.py  把 deskpet/ 打成可直接运行的 dist-runtime/
make_delivery.py  运行时 + 宠物包 → 可双击的交付目录
exeicon.py        给 exe 换图标（调 rcedit）
```

## 从零跑起来

```bash
# 1) 装依赖：electron 33 + three 0.170
cd deskpet && npm install && cd ..

# 2) 生成运行时 dist-runtime/（约 270MB）
python build_runtime.py

# 3) 做一个宠物包 dist/<图鉴号>-<链首名>/（约 5MB）
python petpack/petpack.py --list 菊花          # 先搜一下
python petpack/petpack.py --pet 079 --with-runtime

# 4) 组装交付目录：双击 exe 即可运行
python make_delivery.py --pack dist/079-菊花梨 --dest "E:/rocopet/桌宠"
```

开发时直接起应用：

```bash
cd deskpet && npx electron . --petpack=../dist/079-菊花梨
```

## 外部依赖

| 东西 | 说明 |
| --- | --- |
| Node.js 18+ | `npm install` 拉 electron 与 three |
| Python 3.10+ | 需要 `numpy` `soundfile` `pillow`（音频转码、图标生成） |
| rocom-parse | 解包工具，<https://github.com/whoisnian/rocom-parse>，单独 clone 到同级目录 |
| `.tools/` | `rcedit-x64.exe`、`vgmstream/vgmstream-cli.exe`、`exporter/rocom-pets-export.exe`，自备 |
| `parsed/` | 解包素材，约 6.9GB，用 `ROCOM_PARSED` 指向 |

可用环境变量覆盖路径：`ROCOM_PARSED`（解包目录）、`ROCOM_GAME_DIR`（游戏安装目录）、`ROCOM_RUNTIME`（运行时目录）。

## 几个踩过的坑

**不要用 `petWin.setPosition()` 移动窗口。** 它内部是「GetBounds() → 改 x/y → SetBounds()」
一次读-写往返，而本窗口开了 `useContentSize`，读出来的是外框尺寸、写回去却被当内容尺寸，
一来一回每次都把边框厚度多加一遍 —— 每移动一次窗口长大 1~2px，实测能从 234×499 涨到 328×619。
每长大一次就触发一次 `resize`，渲染进程就重建一次 WebGL 画布，表现就是移动时频闪；
涨到一定程度又被看门狗猛地拉回，就是移动后闪现。位置变更一律走 `applyBounds(x, y, w, h)`，
显式带上尺寸。

**`resize` 事件要加 ±2px 守卫。** 就算尺寸钉死了，系统报回来的 bounds 仍会在 1px 上抖动，
不拦住就是每几步重建一次画布。

**`setIgnoreMouseEvents()` 别频繁切。** 每次调用都重设窗口扩展样式并强制重绘透明窗口。
宠物走动时窗口扫过静止的鼠标也会收到 mousemove，命中判定在轮廓边缘反复 true/false 就会闪。
现在做了滞回（可交互时 pad=16、穿透时 pad=0）加 180ms 冷却。

**调试时如果报 `ipcMain undefined`**，是环境变量 `ELECTRON_RUN_AS_NODE=1` 在作怪，
它会让 electron 以纯 node 模式启动：

```bash
(unset ELECTRON_RUN_AS_NODE; ./node_modules/electron/dist/electron.exe . --dbg=1 --dbgmove=1)
```

调试参数：`--dbg=1` 窗口事件、`--dbgmove=1` 移动日志、`--trace=1` 定时打 bounds、
`--log=<file>` 抓渲染进程 console、`--screenshot=<file>` 截图后退出。

## 玩法

左键单击冒爱心 · 双击喂食 · 三击睡觉/叫醒 · 右键摸头 · 按住拖动换位置 · 托盘右键看等级好感、待办与专注计时。
鼠标不在宠物身上时点击会穿透到桌面，不影响正常操作。
