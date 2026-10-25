// 桌宠交互逻辑：拖拽 / 悬停按钮 / 好感度 / 等级进化 / 待办 / 计时
import { Pet } from './pet.js';

const $ = (s) => document.querySelector(s);
const api = window.api;

// ── 数值策划 ──────────────────────────────────────────
const RULES = {
  expNeed: (lv) => 40 + lv * 20,          // Lv1→2 需 60，之后每级 +20
  expTodo: 25,                            // 完成一条待办
  expTodoFocus: 50,                       // 专注计时中完成
  expFeed: 5,
  expPat: 2,
  expTimer: 30,
  affFeed: 6, affPat: 2, affTodo: 4, affTimer: 5,
  cdFeed: 5 * 60 * 1000,                  // 喂食冷却
  cdPat: 15 * 1000,                       // 摸头冷却
  affDecayPerDay: 2,
  evoAt: [0, 8, 18, 30, 45],              // 各形态解锁等级
  // 自己在桌面上溜达：间隔与单次时长（秒）——只沿水平线走
  roamGap: [18, 45],
  roamDur: [1.5, 4.0],
  // 好感度解锁的动作池（0 段也留两个，免得好感还是 0 时一动不动像卡住）
  unlock: [
    { at: 0,  acts: ['Alert', 'Shock'] },
    { at: 20, acts: ['Happy', 'Show'] },
    { at: 40, acts: ['Relax', 'CallOut', 'Sad'] },
    { at: 60, acts: ['Run', 'Fear', 'CallOut'] },
    { at: 80, acts: ['Skill1Loop', 'Skill2Loop1', 'Skill3Start', 'Skill3Loop', 'Skill3End'] },
  ],
};

const DEFAULT_PROFILE = {
  packDir: null, pos: null, passthrough: false,
  form: null, shiny: false, px_per_cm: 2.0, volume: 0.6,
  glassy: { on: false, color: 1, particle: 1 },   // 炫彩：配色 id + 粒子 id
  nickname: '', level: 1, exp: 0, affection: 0,
  // formIndex：当前显示第几阶形态，可在设置里手动挑
  // formMax：历史到达过的最高阶。自动进化只在「越过历史最高阶」时才推一把，
  //          所以手动挑的形态不会被下一次获得经验就拉回去，也不是死锁定。
  formIndex: 0, formMax: 0, sleeping: false,
  toon: true, outline: true,
  lastFeed: 0, lastPat: 0, lastSeenDay: null,
  todos: [], history: [],
  timer: { running: false, endAt: 0, totalMs: 0 },
};

let profile = Object.assign({}, DEFAULT_PROFILE);
let pack = null;                 // {manifest, dump}
let pet = null;
let formAsset = null;
let audio = new Audio();
let ambientTimer = 0, ambientGap = 15;
let walkState = null;            // 拖动时的临时走路状态
let dragging = false;            // 正在被拖
let roam = null;                 // {dir, speed, left} 只在水平线上走
let roamNext = 0, roamAcc = 0, lastMoveMs = 0;

window.addEventListener('error', (e) =>
  console.log('[err]', e.message, `${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) =>
  console.log('[rej]', (e.reason && (e.reason.stack || e.reason.message)) || e.reason));

// ── 工具 ──────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const today = () => new Date().toISOString().slice(0, 10);

function toast(msg, ms = 1800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function save(patch) {
  Object.assign(profile, patch);
  api.saveProfile(profile);
}

function chainForms() {
  const m = pack && pack.manifest;
  const list = (m && m.chain_forms) || [];
  if (list.length) return list.slice().sort((a, b) => (a.stage || 0) - (b.stage || 0));
  if (!m) return [{ asset: null, name: '', stage: 1 }];
  return [{ asset: m.form, name: m.form_name || '', stage: 1 }];
}

function evoTargetIndex(level) {
  const n = chainForms().length;
  let idx = 0;
  for (let i = 0; i < n; i++) if (level >= RULES.evoAt[i]) idx = i;
  return idx;
}

/**
 * 自动进化判定：只有「等级对应的阶段」超过了历史最高阶才算一次新进化。
 * 这样手动挑的形态（无论挑高还是挑低）都不会被经验/升级顶掉，
 * 但也不是加锁——等到真的升到没到过的新阶段，还是会进化。
 */
function autoEvolve() {
  const want = evoTargetIndex(profile.level || 1);
  const max = profile.formMax || 0;
  if (want <= max) return -1;               // 没跨过新阶段：不动手动选择
  profile.formMax = want;
  profile.formIndex = want;
  save({});
  return want;
}

/** 按当前等级对齐形态：只做「新阶段推进」，不做来回拉扯 */
function syncForm() {
  const forms = chainForms();
  autoEvolve();
  const cur = forms[clamp(profile.formIndex, 0, forms.length - 1)];
  if (cur && cur.asset && cur.asset !== formAsset) loadForm(cur.asset);
}

function unlockedActs() {
  const out = [];
  for (const u of RULES.unlock) if (profile.affection >= u.at) out.push(...u.acts);
  return out.filter((a) => pet.has(a));
}

// ── 经验 / 等级 / 进化 ────────────────────────────────
function addExp(n) {
  profile.exp += n;
  let leveled = false;
  while (profile.exp >= RULES.expNeed(profile.level)) {
    profile.exp -= RULES.expNeed(profile.level);
    profile.level += 1;
    leveled = true;
  }
  save({});
  const want = autoEvolve();          // 只有跨过历史最高阶才算进化
  const evolved = want >= 0;
  if (evolved) {
    const f = chainForms()[want];
    toast(`进化！→ ${f ? f.name : ''}`, 2600);
    loadForm(f.asset);
    setTimeout(() => { say('CallOut'); pet && pet.once('Show', 'Idle'); }, 300);
  } else if (leveled) {
    toast(`升级！Lv.${profile.level}`, 2200);
    pet && pet.once('Happy', 'Idle');
    say('Happy');
  }
  return { leveled, evolved };
}

function addAffection(n) {
  profile.affection = clamp(profile.affection + n, 0, 100);
  save({});
}

// ── 声音 ──────────────────────────────────────────────
function say(emotion, sfx = false) {
  if (!formAsset || !profile.volume) return;
  const sub = sfx ? 'sfx' : 'voice';
  audio.volume = clamp(profile.volume, 0, 1);
  audio.src = `/pack/assets/forms/${formAsset}/${sub}/${emotion}.ogg`;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

// ── 动作 ──────────────────────────────────────────────
function feed() {
  if (profile.sleeping) return toast('它睡着了…');
  const now = Date.now();
  if (now - (profile.lastFeed || 0) < RULES.cdFeed) {
    const m = Math.ceil((RULES.cdFeed - (now - profile.lastFeed)) / 60000);
    return toast(`还吃不下了，${m} 分钟后再来`);
  }
  profile.lastFeed = now;
  save({});
  pet.once('Happy', 'Idle');
  say('Happy');
  addAffection(RULES.affFeed);
  addExp(RULES.expFeed);
  toast('好吃！好感 +' + RULES.affFeed);
}

function pat() {
  if (profile.sleeping) { wake(); return; }
  const now = Date.now();
  if (now - (profile.lastPat || 0) < RULES.cdPat) return;
  profile.lastPat = now;
  save({});
  pet.once(pet.has('Relax') ? 'Relax' : 'Happy', 'Idle');
  say('Relax');
  addAffection(RULES.affPat);
  addExp(RULES.expPat);
}

function sleep() {
  if (profile.sleeping) return;
  profile.sleeping = true;
  save({});
  endRoam(30);
  pet.once(pet.has('SleepStart') ? 'SleepStart' : 'Idle', 'SleepLoop');
  toast('晚安…');
}

function wake() {
  if (!profile.sleeping) return;
  profile.sleeping = false;
  save({});
  pet.once(pet.has('SleepEnd') ? 'SleepEnd' : 'Idle', 'Idle');
  say('Alert');
  toast('早上好！');
}

function toggleSleep() { profile.sleeping ? wake() : sleep(); }

// ── 随机在水平线上挪一挪 ──────────────────────────────
// 只走横向（不上下飘），慢速、低频；撞到屏幕边就掉头。窗口位置全程由主进程记账，
// 不会再出现"越走越远 / 贴边卡死"那套。
function scheduleRoam(minSec) {
  roamNext = Date.now() + (minSec || (RULES.roamGap[0] + Math.random() * (RULES.roamGap[1] - RULES.roamGap[0]))) * 1000;
}

function startRoam() {
  if (!pet || !pet.ready || profile.sleeping) return;
  const dir = Math.random() < 0.5 ? -1 : 1;
  const clip = pet.has('Walk') ? 'Walk' : 'Idle';
  const speed = Math.min(pet.speedOf(clip) || 58, 62);   // 慢一点，别在桌上狂奔
  pet.face(dir);
  pet.play(clip, { loop: true, fade: 0.3 });
  const [a, b] = RULES.roamDur;
  roam = { dir, speed, left: (a + Math.random() * (b - a)) * speed };
  roamAcc = 0;
}

function endRoam(gap) {
  const was = !!roam;
  roam = null;
  if (pet) { pet.face(0); if (!profile.sleeping) pet.play('Idle', { loop: true, fade: 0.35 }); }
  if (was) syncThrough();            // 走完再核一次穿透（走动中鼠标相对宠物是动的）
  scheduleRoam(gap);
}

// 走一步的粒度：窗口每被 setBounds 一次，透明分层窗口就要重新合成一次。
// 1px 一步地挪性价比极差（亚像素重采样会让边缘发抖），所以攒够一小段再推，
// 宁可慢半拍也别闪。
const ROAM_STEP = 3;        // 攒够这么多像素才走
const ROAM_GAP_MS = 45;     // 或攒这么久（速度慢时的兜底，约 22Hz 上限）

function tickRoam(dt) {
  if (profile.sleeping || dragging || walkState || panelMode) { if (roam) endRoam(); return; }
  if (!pet || !pet.ready) return;
  if (!roam) { if (Date.now() >= roamNext) startRoam(); return; }
  roamAcc += roam.speed * dt;
  const nowMs = performance.now();
  const step = Math.trunc(roamAcc);
  if (step !== 0 && (Math.abs(step) >= ROAM_STEP || nowMs - lastMoveMs >= ROAM_GAP_MS)) {
    roamAcc -= step;
    lastMoveMs = nowMs;
    const dir = roam.dir;
    api.move(dir * step, 0).then((r) => {
      // 已经掉过头 / 这趟走完了就别再翻：贴边时每一小步都会报 hitX，
      // 不加冷却会贴着边框来回弹
      if (!r || !roam || roam.dir !== dir || !r.hitX) return;
      if (nowMs - (roam.turnedAt || 0) < 500) return;
      roam.dir = -dir;
      roam.turnedAt = nowMs;
      pet.face(roam.dir);
    });
  }
  roam.left -= roam.speed * dt;
  if (roam.left <= 0) endRoam();
}

// ── 点击：冒爱心 / 双击喂食 / 三击睡觉 ────────────────
const HEART_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M12 21s-7-4.6-9.3-8.4C.9 9.6 2.5 6 6.1 6c2 0 3.4 1.1 4.2 2.3h3.4'
  + 'C14.5 7.1 15.9 6 17.9 6c3.6 0 5.2 3.6 3.4 6.6C19 16.4 12 21 12 21z" fill="#ffb3c8"/></svg>';

function hearts(x, y, n = 1) {
  const box = $('#hearts');
  if (!box) return;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'heart';
    el.innerHTML = HEART_SVG;
    const size = 20 + Math.random() * 18;
    el.style.width = el.style.height = size + 'px';
    el.style.left = (x + (Math.random() - 0.5) * 34) + 'px';
    el.style.top = (y + (Math.random() - 0.5) * 18) + 'px';
    el.style.animationDelay = (i * 60 + Math.random() * 60) + 'ms';
    box.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }
}

let clickN = 0, clickT = null;
function onTap(button, x, y) {
  hearts(x, y, button === 2 ? 2 : 1);
  if (button === 2) { pat(); return; }        // 右键 = 摸摸头，立刻响应
  if (button !== 0) return;
  // 左键连击：等 320ms 静默再决定，双击不会先喂一次再睡
  clearTimeout(clickT);
  clickN++;
  clickT = setTimeout(() => {
    const n = clickN; clickN = 0;
    if (n === 2) feed();
    else if (n >= 3) toggleSleep();
  }, 320);
}

// ── 面板：待办 / 计时 ─────────────────────────────────
let panelMode = null;
async function openPanel(mode) {
  panelMode = mode;
  $('#panel').classList.remove('hidden');
  $('#panel-title').textContent = mode === 'todo' ? '待办事项' : '专注计时';
  // 窗口平时 focusable:false（不抢焦点、不进 alt-tab），但那样输入框收不到键盘，
  // 开面板时临时打开，关掉时再收回
  await api.setFocusable(true);
  renderPanel();
  // 窗口刚变可聚焦时焦点会被系统收回，立刻抢一次 + 等窗口真的拿到焦点再抢一次
  focusPanelInput();
  requestAnimationFrame(focusPanelInput);
  setTimeout(focusPanelInput, 80);
  setTimeout(focusPanelInput, 260);
  syncThrough(true);                // 开面板要立刻能点，不走冷却
}
function focusPanelInput() {
  if (panelMode !== 'todo') return;
  const el = $('#todo-in');
  if (el && document.activeElement !== el) el.focus();
}
async function closePanel() {
  panelMode = null;
  $('#panel').classList.add('hidden');
  await api.setFocusable(false);
  syncThrough(true);
}

function renderPanel() {
  const body = $('#panel-body');
  if (panelMode === 'todo') {
    body.innerHTML = `
      <div class="field">
        <input id="todo-in" placeholder="要做点什么？" maxlength="60">
        <button id="todo-add">加</button>
      </div>
      <div id="todo-list"></div>
      <div class="hint">完成后 +${RULES.expTodo} 经验 · 专注中 +${RULES.expTodoFocus}</div>`;
    $('#todo-add').onclick = addTodo;
    $('#todo-in').onkeydown = (e) => { if (e.key === 'Enter') addTodo(); };
    $('#todo-in').focus();
    renderTodos();
  } else {
    const t = profile.timer || {};
    body.innerHTML = `
      <div class="chips">${[5, 15, 25, 45].map((m) => `<div class="chip${t.totalMs === m * 60000 ? ' on' : ''}" data-m="${m}">${m}分</div>`).join('')}</div>
      <div class="bigtime" id="tm">--:--</div>
      <div class="field">
        <button id="tm-start" style="flex:1">${t.running ? '停止' : '开始'}</button>
      </div>
      <div class="hint">专注完成后 +${RULES.expTimer} 经验 · 好感 +${RULES.affTimer}</div>`;
    body.querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => {
        if (t.running) return;
        profile.timer = { running: false, endAt: 0, totalMs: +c.dataset.m * 60000 };
        save({});
        renderPanel();
      };
    });
    $('#tm-start').onclick = () => (profile.timer.running ? stopTimer(false) : startTimer());
    paintTimer();
  }
}

function renderTodos() {
  const list = $('#todo-list');
  if (!list) return;
  const items = (profile.todos || []).filter((t) => !t.done);
  list.innerHTML = items.length
    ? items.map((t) => `<div class="todo-item" data-id="${t.id}">
         <button data-act="done" title="完成">✔</button>
         <span class="txt">${escapeHtml(t.text)}</span>
         <button data-act="del" title="删除">✕</button></div>`).join('')
    : '<div class="hint">全部完成了，休息一下吧</div>';
  list.querySelectorAll('.todo-item').forEach((el) => {
    const id = +el.dataset.id;
    el.querySelector('[data-act="done"]').onclick = () => doneTodo(id);
    el.querySelector('[data-act="del"]').onclick = () => {
      profile.todos = profile.todos.filter((t) => t.id !== id);
      save({}); renderTodos();
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let todoSeq = 0;
function addTodo() {
  const el = $('#todo-in');
  const text = (el.value || '').trim();
  if (!text) return;
  profile.todos = profile.todos || [];
  // 同一毫秒内连加多条会撞 id，用自增序号错开
  const id = Date.now() * 100 + (todoSeq++ % 100);
  profile.todos.push({ id, text, done: false, createdAt: Date.now() });
  el.value = '';
  save({}); renderTodos();
}

function doneTodo(id) {
  const t = (profile.todos || []).find((x) => x.id === id);
  if (!t || t.done) return;
  const focus = !!(profile.timer && profile.timer.running);
  t.done = true;
  t.doneAt = Date.now();
  t.exp = focus ? RULES.expTodoFocus : RULES.expTodo;
  profile.history = profile.history || [];
  profile.history.unshift({ text: t.text, doneAt: t.doneAt, createdAt: t.createdAt, exp: t.exp, focus });
  profile.history = profile.history.slice(0, 300);
  save({});
  renderTodos();
  addAffection(RULES.affTodo);
  addExp(t.exp);
  toast(`完成「${t.text}」 +${t.exp} 经验`);
  pet && pet.once('Show', 'Idle');
  say('Show');
}

// ── 计时 ──────────────────────────────────────────────
function startTimer() {
  const t = profile.timer || {};
  const total = t.totalMs || 25 * 60000;
  profile.timer = { running: true, endAt: Date.now() + (t.remainingMs || total), totalMs: total };
  save({});
  renderPanel();
  toast('专注开始，加油！');
}
function stopTimer(finished) {
  const t = profile.timer || {};
  profile.timer = { running: false, endAt: 0, totalMs: t.totalMs || 25 * 60000, remainingMs: 0 };
  save({});
  if (finished) {
    addAffection(RULES.affTimer);
    addExp(RULES.expTimer);
    toast(`专注完成！+${RULES.expTimer} 经验`, 2600);
    pet && pet.once('CallOut', 'Idle');
    say('CallOut');
  }
  renderPanel();
}
function paintTimer() {
  const el = $('#tm');
  if (!el) return;
  const t = profile.timer || {};
  el.textContent = fmt(t.running ? (t.endAt - Date.now()) : (t.remainingMs || t.totalMs || 25 * 60000));
}

function tickTimer() {
  const t = profile.timer || {};
  if (t.running && t.endAt - Date.now() <= 0) { stopTimer(true); return; }
  if (panelMode === 'timer') paintTimer();
}
function fmt(ms) {
  const s = Math.round(Math.max(0, ms) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── 加载形态 ──────────────────────────────────────────
async function loadForm(asset) {
  if (!asset || !pack) return;
  formAsset = asset;
  const m = pack.manifest;
  try {
    await pet.load(m, pack.dump, asset, {
      shiny: !!profile.shiny,
      px_per_cm: profile.px_per_cm || (m.traits && m.traits.px_per_cm) || 2.0,
      toon: profile.toon !== false,
      outline: profile.outline !== false,
      outline_px: clamp(0.9 + 0.35 * (profile.px_per_cm || 2.0), 1.2, 2.6),
      glassy: profile.glassy || { on: false, color: 1, particle: 1 },
    });
  } catch (e) {
    $('#tip').textContent = '模型加载失败：' + e.message;
    $('#tip').classList.remove('hidden');
    return;
  }
  $('#tip').classList.add('hidden');
  fitWindow();
  if (profile.sleeping) pet.play('SleepLoop', { loop: true });
  else pet.play('Idle', { loop: true });
}

/**
 * 窗口尺寸：不再夹上限。按「实测所有动作的最大占位」来开，
 * 跳跃 / 技能抬多高、挥手伸多远都量过了，窗框不会再切到它。
 */
function fitWindow() {
  if (!pet || !pet.ready) return;
  const px = pet.targetPx;
  const b = pet.meshBox;
  const oh = pet.overhang || { top: 0, bot: 0, side: 0 };
  const unitH = Math.max(1e-4, b.max.y - b.min.y);
  const s = px / unitH;                       // 模型 → 屏幕像素的缩放
  const ratio = (b.max.x - b.min.x) / unitH;
  const petW = px * Math.max(1, ratio);

  const top = Math.round(oh.top * s) + 26;    // 跳跃腾空的高度
  const bot = Math.round(oh.bot * s) + 22;    // 下蹲 / 踩地的下沉量
  const side = Math.round(oh.side * s) + 30;  // 挥手 / 伸展的宽度
  const w = Math.round(petW + side * 2);
  const h = Math.round(px + top + bot);
  console.log('[fit]', `宠物高=${px.toFixed(0)}px 上余=${top} 下余=${bot} 侧余=${side}`
    + `（实测多出 上${oh.top.toFixed(2)}/下${oh.bot.toFixed(2)}/侧${oh.side.toFixed(2)} 模型单位）-> 窗口 ${w}x${h}`);
  pet.setPads(top, bot);
  api.resize(w, h);
  setTimeout(() => { pet.setSize(window.innerWidth, window.innerHeight); }, 40);
}

// ── 拖拽 ──────────────────────────────────────────────
const DRAG_FLUSH_MS = 40;   // 拖动时最多这么久推一次位置给主进程
function bindDrag() {
  let lx = 0, ly = 0, moved = 0, dragBtn = 0;
  let accX = 0, accY = 0, lastFlush = 0, faceDir = 0;
  const stage = $('#stage');
  // 一次 mousemove 就推一次的话，透明窗口会被系统反复重绘 —— 就是拖动时的频闪。
  // 攒够 DRAG_FLUSH_MS 再推一次（约 25Hz），肉眼跟得上，窗口也跟得上。
  const flush = () => {
    const dx = Math.trunc(accX), dy = Math.trunc(accY);
    if (!dx && !dy) return;
    accX -= dx; accY -= dy;          // 留着小数余数，不然拖久了会慢慢漂
    lastFlush = performance.now();
    api.move(dx, dy);
  };
  stage.addEventListener('mousedown', (e) => {
    dragging = true; lx = e.screenX; ly = e.screenY; moved = 0;
    dragBtn = e.button; accX = 0; accY = 0; lastFlush = performance.now();
    document.body.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lx, dy = e.screenY - ly;
    lx = e.screenX; ly = e.screenY;
    if (!dx && !dy) return;
    accX += dx; accY += dy;
    moved += Math.abs(dx) + Math.abs(dy);
    if (performance.now() - lastFlush >= DRAG_FLUSH_MS) flush();
    // 方向变一次才转头，免得鼠标抖一下它就来回摆
    const dir = dx < -2 ? -1 : (dx > 2 ? 1 : 0);
    if (dir && dir !== faceDir) { faceDir = dir; pet.face(dir); }
    if (moved > 6 && !profile.sleeping && !walkState) {
      pet.play(pet.has('Walk') ? 'Walk' : 'Idle', { loop: true, fade: 0.15 });
      walkState = { until: Date.now() + 400 };
    }
  });
  window.addEventListener('mouseup', async (e) => {
    if (!dragging) return;
    dragging = false;
    faceDir = 0;
    document.body.style.cursor = 'default';
    walkState = null;
    pet.face(0);
    if (moved > 2) {                      // 拖动过就不算点击
      flush();
      const p = await api.getPos();
      if (p) save({ pos: p });
      scheduleRoam(12);
    } else {
      onTap(dragBtn, e.clientX, e.clientY);
    }
    if (!profile.sleeping) pet.play('Idle', { loop: true, fade: 0.25 });
  });
  // 右键是摸头，别弹系统菜单
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  // 鼠标不在宠物身上时窗口整体"透明掉"，空白处不挡住桌面操作
  window.addEventListener('mousemove', (e) => {
    lastMouse.x = e.clientX; lastMouse.y = e.clientY;
    syncThrough();
  });
  window.addEventListener('mouseleave', () => {
    lastMouse.x = -1; lastMouse.y = -1;
    syncThrough(true);            // 鼠标离开窗口立刻放行，别等冷却
  });
}

let lastMouse = { x: -1, y: -1 };
let through = null;               // null=还没设过，true=穿透，false=可交互
let throughAt = 0;

/** 鼠标在不在宠物身上。带滞回：现在可交互就判得松，现在穿透就判得严 */
function onPet() {
  if (!pet || lastMouse.x < 0) return false;
  return pet.hitTest(lastMouse.x, lastMouse.y, through === false ? 16 : 0);
}

/**
 * 切换鼠标穿透。
 * setIgnoreMouseEvents() 每次都会重设窗口扩展样式，透明窗口会被强制重绘一次 ——
 * 宠物走动时窗口扫过静止的鼠标也会收到 mousemove，hitTest 在轮廓边缘
 * 反复 true/false，就会反复重设样式，闪得厉害。所以这里：
 *   1) 判定带滞回，鼠标停在边缘不会来回切；
 *   2) 刚切过就冷却 180ms，最坏也只是慢一点点才恢复可点。
 */
function syncThrough(force) {
  if (profile && profile.passthrough) return;      // 设置里开了完全穿透就不抢鼠标
  const want = !(panelMode || dragging || onPet());
  if (want === through) return;
  if (!force && performance.now() - throughAt < 180) return;
  through = want;
  throughAt = performance.now();
  api.mouseThrough(want);
}

// ── 自主行为 ──────────────────────────────────────────
function ambient(dt) {
  if (walkState && Date.now() > walkState.until) walkState = null;
  if (profile.sleeping || walkState || !pet || !pet.ready) return;
  ambientTimer += dt;
  if (ambientTimer < ambientGap) return;
  ambientTimer = 0;
  ambientGap = 8 + Math.random() * 14;
  const acts = unlockedActs();
  if (!acts.length) return;
  const a = acts[Math.floor(Math.random() * acts.length)];
  pet.once(a, 'Idle');
  if (['Happy', 'Show', 'Relax', 'CallOut', 'Shock', 'Sad', 'Fear'].includes(a)) say(a);
}

// ── 主循环 ────────────────────────────────────────────
// 透明无边框窗口不走 vsync，rAF 能冲到 180fps，白烧显卡还更容易卡。
// 这里按 60fps 出图，省下来的算力留给画质。
const FRAME_MS = 1000 / 60;
let last = performance.now();
let loopN = 0, drawN = 0;
function loop(now) {
  requestAnimationFrame(loop);
  loopN++;
  if (now - last < FRAME_MS - 1) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  drawN++;
  pet && pet.update(dt);
  ambient(dt);
  tickRoam(dt);
  tickTimer();   // 面板关掉也要继续计时
}

// ── 启动 ──────────────────────────────────────────────
async function boot() {
  pet = new Pet($('#stage'));
  pet.setSize(window.innerWidth, window.innerHeight);
  // 调试钩子
  window.__dbg = {
    get pet() { return pet; },
    panel: (m) => openPanel(m), close: () => closePanel(),
    feed, pat, sleep, wake, toggleSleep, hearts,
    roam: () => startRoam(), stopRoam: () => endRoam(30),
    state: () => ({ dragging, panelMode, walkState: !!walkState, roam, loop: loopN, draw: drawN }),
  };
  // 差 1~2px 就当没变：每次 setBounds 之后系统报回来的 bounds 会在 ±1px 上抖，
  // 每抖一次就重建一次 WebGL 画布，画面就闪一下。两三像素对宠物排版没有可见影响。
  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    if (Math.abs(w - pet.w) <= 2 && Math.abs(h - pet.h) <= 2) return;
    console.log('[setSize]', `${pet.w}x${pet.h} -> ${w}x${h}`);
    pet.setSize(w, h);
  });
  // 窗口被系统/点击重新激活时，把焦点还给输入框
  window.addEventListener('focus', () => setTimeout(focusPanelInput, 0));
  requestAnimationFrame(loop);

  profile = Object.assign({}, DEFAULT_PROFILE, await api.getProfile() || {});
  pack = await api.getPack();
  if (!pack || !pack.manifest) {
    $('#tip').textContent = '没有找到宠物包，右键托盘 → 设置 → 选择宠物包';
    $('#tip').classList.remove('hidden');
    return;
  }

  // 跨天好感衰减
  const day = today();
  if (profile.lastSeenDay && profile.lastSeenDay !== day) {
    profile.affection = clamp(profile.affection - RULES.affDecayPerDay, 0, 100);
  }
  profile.lastSeenDay = day;

  // 形态：手动选的优先，只有等级跨过历史最高阶才推进
  const forms = chainForms();
  profile.formIndex = clamp(profile.formIndex || 0, 0, forms.length - 1);
  profile.formMax = clamp(profile.formMax || 0, 0, forms.length - 1);
  if (profile.formIndex > profile.formMax) profile.formMax = profile.formIndex;
  autoEvolve();
  if (profile.shiny === undefined) profile.shiny = !!(pack.manifest.traits && pack.manifest.traits.shiny);
  if (!profile.px_per_cm) profile.px_per_cm = (pack.manifest.traits && pack.manifest.traits.px_per_cm) || 2.0;
  save({});

  await loadForm(forms[profile.formIndex].asset);
  scheduleRoam(14);

  $('#panel-close').onclick = closePanel;
  bindDrag();
  syncThrough(true);

  // 托盘菜单里点的动作
  api.onAction((a) => {
    if (a === 'feed') feed();
    else if (a === 'pat') pat();
    else if (a === 'sleep') toggleSleep();
    else if (a === 'todo') openPanel('todo');
    else if (a === 'timer') openPanel('timer');
  });

  api.onProfile((p) => {
    const prev = profile;
    profile = Object.assign({}, DEFAULT_PROFILE, p || {});
    if (prev.px_per_cm !== profile.px_per_cm || prev.shiny !== profile.shiny
      || prev.toon !== profile.toon || prev.outline !== profile.outline) {
      loadForm(formAsset);
      return;
    }
    // 炫彩只是改材质参数，不用重载模型
    if (JSON.stringify(prev.glassy) !== JSON.stringify(profile.glassy)) {
      pet && pet.applyGlassy(profile.glassy);
    }
    syncForm();
  });
}

boot();
