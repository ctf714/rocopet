// 洛克王国桌宠 · 主进程
//   透明置顶窗口 + 托盘（设置 / 待办事项历史 / 退出）+ 本地静态服务（宠物包与渲染页）
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const RENDERER = path.join(__dirname, 'renderer');
const VENDOR = path.join(__dirname, 'vendor', 'three');
const THREE_DIR = fs.existsSync(VENDOR) ? VENDOR : path.join(__dirname, 'node_modules', 'three');

let packDir = null;
let baseUrl = null;
let tray = null;
let petWin = null;
// 窗口真实坐标由主进程自己记账：Electron 的 getPosition() 是缓存值，
// 高频 setPosition 时它会滞后（刚设成 1 还报 0），贴边时甚至完全不动。
let petPos = null;
let settingsWin = null;
let historyWin = null;

// ── 参数 ────────────────────────────────────────────────
function argVal(name) {
  const hit = process.argv.find((s) => s.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function exeDir() {
  try { return path.dirname(app.getPath('exe')); } catch { return __dirname; }
}

function findPack() {
  const given = argVal('petpack');
  if (given && fs.existsSync(path.join(given, 'petpack.json'))) return given;
  const saved = readProfile();
  if (saved && saved.packDir && fs.existsSync(path.join(saved.packDir, 'petpack.json'))) return saved.packDir;
  const candidates = [
    path.join(exeDir(), 'pack'),
    path.join(exeDir(), 'assets'),
    exeDir(),                                   // petpack.json 与 exe 同级
    path.join(__dirname, 'pack'),
    path.join(app.getPath('userData'), 'pack'),
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'petpack.json'))) return c;
  return null;
}

function profilePath() {
  return path.join(app.getPath('userData'), 'profile.json');
}

function readProfile() {
  try { return JSON.parse(fs.readFileSync(profilePath(), 'utf-8')); } catch { return null; }
}

function writeProfile(p) {
  fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
  fs.writeFileSync(profilePath(), JSON.stringify(p, null, 2), 'utf-8');
}

function mergeProfile(patch) {
  const p = Object.assign(readProfile() || {}, patch);
  writeProfile(p);
  return p;
}

// ── 静态服务 ────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function startServer() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';

    if (p === '/api/pack') {
      const manifest = readJson(path.join(packDir, 'petpack.json'));
      if (!manifest) return send(res, 404, 'no petpack.json');
      const dump = readJson(path.join(packDir, 'assets', 'dump.json')) || { forms: [] };
      return send(res, 200, JSON.stringify({ manifest, dump }), MIME['.json']);
    }

    let file;
    if (p.startsWith('/pack/')) file = path.join(packDir, p.slice('/pack/'.length));
    else if (p.startsWith('/vendor/three/')) file = path.join(THREE_DIR, p.slice('/vendor/three/'.length));
    else file = path.join(RENDERER, p);

    const abs = path.resolve(file);
    const ok = abs.startsWith(RENDERER) || abs.startsWith(packDir) || abs.startsWith(THREE_DIR);
    if (!ok) return send(res, 403, 'forbidden');

    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found: ' + p);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// ── 窗口 ────────────────────────────────────────────────
function packIconPath() {
  for (const c of [path.join(packDir, 'icon.png'), path.join(RENDERER, 'default-icon.png')]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function createPetWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = readProfile();
  const pos = saved && saved.pos
    ? saved.pos
    : { x: area.x + area.width - 300, y: area.y + area.height - 340 };

  petWin = new BrowserWindow({
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    width: 360,
    height: 520,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    useContentSize: true,
    resizable: false,        // 尺寸由程序按宠物体型算；锁死避免鼠标蹭到边就变形
    minWidth: 160,
    minHeight: 200,
    maximizable: false,
    minimizable: false,
    movable: true,           // 无边框，系统拖不动；拖拽由渲染进程算好后 setPosition
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  petPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
  wantSize = { w: 360, h: 520 };      // 内容尺寸，之后由 fitWindow() 校准
  petWin.setIgnoreMouseEvents(false);
  petWin.loadURL(`${baseUrl}/index.html`);
  if (saved && saved.passthrough) petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.on('closed', () => { petWin = null; });
  // 右键也给一份同样的菜单：万一托盘图标被折叠，仍然能设置 / 看历史 / 退出
  // 左键双击喂食 / 三击睡觉，右键摸头 —— 都不弹菜单，操作全在托盘里
  petWin.webContents.on('context-menu', (e) => e.preventDefault());
}

function createTray() {
  const p = packIconPath();
  tray = new Tray(p ? nativeImage.createFromPath(p).resize({ width: 32, height: 32 }) : nativeImage.createEmpty());
  const m = readJson(path.join(packDir, 'petpack.json'));
  tray.setToolTip(m ? `${m.chain || ''}${m.form_name ? ' · ' + m.form_name : ''}` : '桌宠');
  refreshTrayMenu();
}

function petAction(name) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet-action', name);
}

function bar(v, n = 10) {
  const f = Math.round(clampNum(v, 0, 100) / 100 * n);
  return '█'.repeat(f) + '░'.repeat(n - f);
}
function clampNum(v, a, b) { return Math.max(a, Math.min(b, +v || 0)); }

/** 托盘右键菜单：等级 / 好感度都挂在这里，桌面上不再摆任何条条框框 */
function refreshTrayMenu() {
  if (!tray) return;
  const m = readJson(path.join(packDir || '', 'petpack.json')) || {};
  const p = readProfile() || {};
  const lv = p.level || 1;
  const need = 40 + lv * 20;
  const aff = Math.round(p.affection || 0);
  const exp = Math.round(p.exp || 0);
  const nick = p.nickname || m.chain || '桌宠';
  const act = (label, name) => ({ label, click: () => petAction(name) });
  const menu = Menu.buildFromTemplate([
    { label: `${nick}${m.form_name ? ' · ' + m.form_name : ''}`, enabled: false },
    { label: `等级  Lv.${lv}   经验 ${exp}/${need}`, enabled: false },
    { label: `好感  ${bar(aff)} ${aff}/100`, enabled: false },
    { type: 'separator' },
    act('喂食（= 左键双击）', 'feed'),
    act('摸摸头（= 右键单击）', 'pat'),
    act(p.sleeping ? '叫醒（= 左键三击）' : '睡觉（= 左键三击）', 'sleep'),
    { type: 'separator' },
    act('待办事项', 'todo'),
    act('专注计时', 'timer'),
    { label: '设置', click: () => openSettings() },
    { label: '待办事项历史', click: () => openHistory() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`${nick} · Lv.${lv} · 好感 ${aff}`);
}

function childWindow(file, w, h, title) {
  const icon = packIconPath();
  const win = new BrowserWindow({
    width: w, height: h, title, resizable: false, minimizable: false,
    icon: icon || undefined,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) console.log(`[${file}] ${msg}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log(`[preload-error] ${p}: ${err.message}`));
  win.loadURL(`${baseUrl}/${file}`);
  return win;
}

function openSettings() {
  if (settingsWin) { settingsWin.focus(); return settingsWin; }
  settingsWin = childWindow('settings.html', 460, 620, '设置');
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

function openHistory() {
  if (historyWin) { historyWin.focus(); return historyWin; }
  historyWin = childWindow('history.html', 560, 620, '待办事项历史');
  historyWin.on('closed', () => { historyWin = null; });
  return historyWin;
}

// ── IPC ─────────────────────────────────────────────────
ipcMain.handle('get-profile', () => readProfile());
ipcMain.handle('save-profile', (_e, p) => {
  const n = mergeProfile(p);
  broadcast('profile-changed', n);
  refreshTrayMenu();          // 等级 / 好感度变了，托盘菜单要跟着变
  return true;
});
ipcMain.handle('get-pack', () => {
  const manifest = readJson(path.join(packDir, 'petpack.json'));
  const dump = readJson(path.join(packDir, 'assets', 'dump.json')) || { forms: [] };
  return { manifest, dump };
});
/**
 * 窗口几何：位置和尺寸都由主进程自己记账，并且只有 applyBounds() 一个出口写窗口。
 *
 * 为什么必须这样（这是"移动频闪 + 移动后闪现"的根因）：
 *   1) getBounds() / getPosition() 在高频移动时是缓存值、会滞后，拿它当基准
 *      就会"刚设成 1 还报 0"，一步 1px 的移动全被吞掉。
 *   2) 致命的是 petWin.setPosition(x, y)：它内部是
 *      「GetBounds() → 改 x/y → SetBounds()」一次读-写往返。本窗口开了
 *      useContentSize，Get 出来的是外框尺寸、Set 进去却被当成内容尺寸，
 *      这一来一回每次都把边框厚度多加一遍 —— 实测每移动一次窗口就长大
 *      1~2px，234x499 能一路涨到 328x619。每长大一次就发一次 resize，
 *      渲染进程就重建一次 WebGL 画布，这就是移动时的频闪；等长到看门狗
 *      的阈值，又被猛地拉回原尺寸，就是那一下"闪现"。
 *   所以：位置变更一律走 applyBounds()，尺寸由调用方显式给出，
 *   绝不让 Electron 自己去读缓存再写回去。
 */
let wantSize = null;          // 渲染进程要的内容尺寸（唯一权威）

/** 把窗口收回工作区内：尺寸变大时可能伸出屏幕，Windows 会自作主张去重排 */
function clampPos(x, y, w, h) {
  const a = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(Math.min(Math.max(a.x, x), Math.max(a.x, a.x + a.width - w))),
    y: Math.round(Math.min(Math.max(a.y, y), Math.max(a.y, a.y + a.height - h))),
  };
}

/** 改窗口几何的唯一出口：位置、尺寸都必须由调用方给全 */
function applyBounds(x, y, w, h) {
  if (!petWin || petWin.isDestroyed()) return;
  const ww = Math.round(w), hh = Math.round(h);
  const p = clampPos(x, y, ww, hh);
  petPos = p;
  petWin.setBounds({ x: p.x, y: p.y, width: ww, height: hh });
}

/**
 * 尺寸看门狗：位置由 applyBounds 精确维护、不会漂，所以这里只兜底尺寸，
 * 而且必须连续两次都偏才动手 —— getBounds() 单次读数不可信，误判一次
 * 就是肉眼可见的一跳。
 */
let sizeSuspect = 0;
setInterval(() => {
  if (!petWin || petWin.isDestroyed() || !wantSize || !petPos) return;
  const b = petWin.getBounds();
  if (Math.abs(b.width - wantSize.w) <= 3 && Math.abs(b.height - wantSize.h) <= 3) {
    sizeSuspect = 0; return;
  }
  if (++sizeSuspect < 2) return;
  sizeSuspect = 0;
  if (argVal('dbg')) {
    console.log('[size-fix]', `${b.width}x${b.height} -> ${wantSize.w}x${wantSize.h}`);
  }
  applyBounds(petPos.x, petPos.y, wantSize.w, wantSize.h);
}, 3000);

ipcMain.handle('resize-pet', (_e, w, h) => {
  if (!petWin || !petPos) return;
  wantSize = { w: Math.round(w), h: Math.round(h) };
  applyBounds(petPos.x, petPos.y, wantSize.w, wantSize.h);
  if (argVal('dbg')) {
    const b = petWin.getBounds(); const c = petWin.getContentSize();
    console.log(`[resize] req=${wantSize.w}x${wantSize.h} bounds=${b.width}x${b.height} content=${c[0]}x${c[1]}`);
  }
});
// 移动 + 夹在工作区内（桌宠自己溜达时靠 hitX 判断撞到边了要掉头）
ipcMain.handle('move-pet', (_e, dx, dy) => {
  if (!petWin || !wantSize || !petPos) return null;
  const { x: x0, y: y0 } = petPos;
  const rawX = Math.round(x0 + dx), rawY = Math.round(y0 + dy);
  const p = clampPos(rawX, rawY, wantSize.w, wantSize.h);
  const hitX = p.x !== rawX, hitY = p.y !== rawY;
  if (p.x !== x0 || p.y !== y0) applyBounds(p.x, p.y, wantSize.w, wantSize.h);
  if (argVal('dbgmove')) {
    console.log(`[move] ${x0},${y0} +(${dx},${dy}) -> ${p.x},${p.y} hit=${hitX ? 'X' : '-'}${hitY ? 'Y' : '-'}`);
  }
  return { x: p.x, y: p.y, hitX, hitY };
});
ipcMain.handle('set-focusable', (_e, on) => {
  if (!petWin) return false;
  petWin.setFocusable(!!on);
  if (on) petWin.focus();
  if (argVal('log')) console.log('[focusable]', on, '→', petWin.isFocusable());
  return petWin.isFocusable();
});
ipcMain.handle('get-pos', () => (petWin ? { ...(petPos || { x: 0, y: 0 }) } : null));
ipcMain.handle('set-pos', (_e, x, y) => {
  if (!petWin || !wantSize) return;
  applyBounds(x, y, wantSize.w, wantSize.h);
  mergeProfile({ pos: { ...petPos } });
});
ipcMain.handle('get-workarea', () => {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x, y: a.y, width: a.width, height: a.height };
});
// 只在鼠标不在宠物身上时让窗口"透明掉"：窗口开得比宠物大一圈，
// 空白处不该挡住电脑操作。forward:true 保留 mousemove，才能判断鼠标什么时候回到宠物身上。
ipcMain.handle('set-mouse-through', (_e, on) => {
  if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(!!on, { forward: true });
  return true;
});
ipcMain.handle('set-passthrough', (_e, on) => {
  const p = mergeProfile({ passthrough: !!on });
  if (petWin) petWin.setIgnoreMouseEvents(!!on, { forward: true });
  broadcast('profile-changed', p);
});
ipcMain.handle('open-settings', () => { openSettings(); return true; });
ipcMain.handle('open-history', () => { openHistory(); return true; });
ipcMain.handle('quit-app', () => { app.isQuitting = true; app.quit(); });
ipcMain.handle('pick-pack', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory'], title: '选择宠物包目录（含 petpack.json）',
  });
  if (r.canceled || !r.filePaths[0]) return null;
  mergeProfile({ packDir: r.filePaths[0] });
  app.relaunch({ args: process.argv.slice(1).concat([`--petpack=${r.filePaths[0]}`]) });
  app.exit(0);
  return r.filePaths[0];
});

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

// ── 启动 ────────────────────────────────────────────────
app.setAppUserModelId('RocoPet.DeskPet');

app.whenReady().then(async () => {
  const dir = findPack();
  packDir = path.resolve(dir || path.join(__dirname, 'pack'));
  if (dir && argVal('petpack')) mergeProfile({ packDir });
  fs.mkdirSync(packDir, { recursive: true });

  const { port } = await startServer();
  baseUrl = `http://127.0.0.1:${port}`;

  if (!dir) {
    // 还没有宠物包：直接开设置页让用户选
    openSettings();
    createTray();
    return;
  }
  createPetWindow();
  createTray();

  // 调试用：--log=<文件> 记录渲染进程日志，--screenshot=<文件> 启动后截图再退出
  const logFile = argVal('log');
  const shot = argVal('screenshot');
  const delayMs = +(argVal('shot-delay') || 7000);
  if (logFile) {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const rec = (lvl, msg, src) => out.write(`[${lvl}] ${msg} @ ${src && src.url}:${src && src.line}\n`);
    for (const w of [petWin, settingsWin, historyWin]) {
      if (!w) continue;
      w.webContents.on('console-message', (_e, lvl, msg, line, src) => rec(lvl, msg, src));
      w.webContents.on('did-fail-load', (_e, code, desc) => out.write(`[load-fail] ${code} ${desc}\n`));
    }
  }
  if (argVal('trace') && petWin) {
    setInterval(() => console.log('[bounds]', JSON.stringify(petWin.getBounds()),
      'zoom', petWin.webContents.getZoomFactor()), 900);
  }
  if (argVal('dbg') && petWin) {
    for (const e of ['resize', 'resized', 'move', 'moved', 'will-move', 'will-resize', 'show', 'hide', 'focus', 'blur']) {
      petWin.on(e, () => console.log(`[evt ${e}]`, JSON.stringify(petWin.getBounds())));
    }
  }
  const evalJs = argVal('eval');
  if (evalJs && petWin) {
    petWin.webContents.once('did-finish-load', () => {
      setTimeout(() => petWin.webContents.executeJavaScript(evalJs).catch((e) => {
        if (logFile) fs.appendFileSync(logFile, `eval error: ${e.message}\n`);
      }), 2500);
    });
  }
  if (shot && petWin) {
    setTimeout(async () => {
      try {
        const target = argVal('shot-target');
        if (target === 'settings') openSettings();
        if (target === 'history') openHistory();
        await new Promise((r) => setTimeout(r, 1200));
        const win = target === 'settings' ? settingsWin : target === 'history' ? historyWin : petWin;
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        if (logFile) fs.appendFileSync(logFile, `screenshot -> ${shot}\n`);
      } catch (e) {
        if (logFile) fs.appendFileSync(logFile, `screenshot failed: ${e.message}\n`);
      }
      app.quit();
    }, delayMs);
  }
});

app.on('window-all-closed', (e) => { if (process.platform !== 'darwin') e.preventDefault(); });
