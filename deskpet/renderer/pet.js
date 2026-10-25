// three.js 场景：加载 GLB + 外挂 PNG 贴图 + 播放骨骼动画，透明背景
// 画面风格：卡通分级光照（gradientMap）+ 反面外扩描边，尽量贴近游戏内的表现
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loaderGLB = new GLTFLoader();
const loaderTex = new THREE.TextureLoader();

function texLoad(url, srgb) {
  return new Promise((res) => {
    loaderTex.load(url, (t) => {
      t.flipY = false;                       // glTF 约定：UV 原点在左上
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, () => res(null));
  });
}

/** 分级色阶贴图：把连续光照切成 N 档，出卡通片的硬边明暗 */
function toonRamp(steps = 4) {
    const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    // 整体提亮：最暗的一档也从 0.68 起，暗部不再发灰
    const v = Math.round(255 * (0.68 + 0.32 * t));
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class Pet {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true, premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    this.root = new THREE.Group();
    this.inner = new THREE.Group();          // 缩放 + 站立位移
    this.inner.add(this.root);
    this.scene.add(this.inner);

    // 打光：一盏主光定明暗，环境光托底，再从后方补一点冷光勾边
    this.ambient = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xf4f9ff, 0x8a6b45, 0.8);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff6e6, 2.2);
    this.key.position.set(2.5, 5.5, 7);
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0x9fc2ff, 0.5);
    this.rim.position.set(-4, 1.5, -5);
    this.scene.add(this.rim);

    this.ramp = toonRamp(4);
    this.overhang = { top: 0, bot: 0, side: 0 };
    this.outlineMats = [];
    this.outlinePx = 1.4;
    this.toon = true;
    this.outline = true;

    this.mixer = null;
    this.clips = new Map();
    this.current = null;
    this.actions = new Map();
    this.motion = {};
    this.meshBox = new THREE.Box3();
    this.w = 0; this.h = 0;             // 画布尺寸，用来判断 resize 是不是真的变了
    this.ready = false;
    this.yaw = 0;
    this.yawTarget = 0;
    this.topPad = 56;
    this.botPad = 64;
    this.targetPx = 200;
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    // 稍微超采样一点：透明窗口拿不到好的 MSAA，靠多渲染几个像素换干净的边缘
    this.renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * 1.25, 2.5));
    this.renderer.setSize(w, h, false);
    this.camera.left = -w / 2; this.camera.right = w / 2;
    this.camera.top = h / 2; this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  setPads(top, bot) { this.topPad = top; this.botPad = bot; this.layout(); }

  /** 把模型按身高缩放到目标像素，脚底贴住下方留白 */
  layout() {
    if (!this.ready) return;
    const b = this.meshBox;
    const unitH = Math.max(1e-4, b.max.y - b.min.y);
    const s = (this.targetPx || 200) / unitH;
    this.inner.scale.setScalar(s);
    // 描边宽度是本地单位的，模型被放大 s 倍，得除回去才是固定的屏幕像素
    const w = (this.outlinePx || 1.4) / s;
    for (const m of this.outlineMats) if (m.userData.uOutline) m.userData.uOutline.value = w;
    const bottomY = -this.h / 2 + (this.botPad || 64);
    this.inner.position.y = bottomY - b.min.y * s;
    this.inner.position.x = -(b.min.x + b.max.x) / 2 * s;
    this.inner.position.z = -(b.min.z + b.max.z) / 2 * s;
  }

  /** 从 dump 里挑出某个 GLB 材质该用的贴图文件（异色则换 _101_ 系列） */
  pickTexture(form, glbMatName, shiny) {
    const mats = form.materials || {};
    let name = glbMatName;
    if (shiny) {
      const alt = glbMatName.replace(/_001_/g, '_101_');
      for (const m of Object.values(mats)) if (m.name === alt) { name = alt; break; }
    }
    const mat = Object.values(mats).find((m) => m.name === name);
    if (!mat) return null;
    const params = mat.textures || [];
    const order = ['BaseTex', 'MainTex', 'EyeTex', 'MatID', 'MaskTex'];
    let pick = null;
    for (const key of order) {
      const t = params.find((p) => p.name === key && p.path && form.textures[p.path]);
      if (t) { pick = t; break; }
    }
    if (!pick) pick = params.find((p) => p.path && form.textures[p.path]);
    if (!pick) return null;
    const info = form.textures[pick.path];
    return { file: info.file, srgb: info.srgb !== false };
  }

  /**
   * 描边：复制一份 mesh 用 BackSide 渲染，顶点沿法线外扩 —— 游戏里的
   * MI_xxx_By_Ol 就是这么做的，只是它给的是独立的 outline 材质和 MatID 贴图。
   */
  buildOutline(mesh, groupIndex = -1) {
    try {
      let geo = mesh.geometry;
      // 一个 mesh 按 group 分成身体/眼睛/嘴巴，描边只要身体那一段。
      // 注意这里必须用 drawRange —— 材质不是数组时 three 会忽略 groups 整块画出来。
      if (groupIndex >= 0 && geo.groups && geo.groups.length > groupIndex) {
        const g = geo.groups[groupIndex];
        geo = geo.clone();
        geo.clearGroups();
        geo.setDrawRange(g.start, g.count);
      }
      const u = { value: 0.01 };
      // 细一点、淡一点：原来 0x2a1a0b 的近黑描边太抢戏
      const mat = new THREE.MeshBasicMaterial({ color: 0x7d6047, side: THREE.BackSide });
      mat.userData.uOutline = u;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uOutline = u;
        shader.vertexShader = 'uniform float uOutline;\n' + shader.vertexShader.replace(
          '#include <project_vertex>',
          'transformed += normalize(objectNormal) * uOutline;\n#include <project_vertex>');
      };
      const hull = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(geo, mat) : new THREE.Mesh(geo, mat);
      if (mesh.isSkinnedMesh) hull.bind(mesh.skeleton, mesh.bindMatrix);
      hull.renderOrder = -1;
      hull.frustumCulled = false;
      mesh.parent.add(hull);
      this.outlineMats.push(mat);
      return hull;
    } catch {
      return null;
    }
  }

  async load(manifest, dump, formAsset, opts = {}) {
    const form = (dump.forms || []).find((f) => f.asset === formAsset)
      || (dump.forms || [])[0];
    if (!form) throw new Error('包里没有任何形态');

    const shiny = !!opts.shiny;
    const pxPerCm = opts.px_per_cm || 2.0;
    this.toon = opts.toon !== false;
    this.outline = opts.outline !== false;
    this.outlinePx = opts.outline_px || 1.4;
    this.targetPx = (form.height_cm || 100) * pxPerCm;

    // 清掉上一只
    while (this.root.children.length) this.root.remove(this.root.children[0]);
    this.clips.clear(); this.actions.clear(); this.outlineMats = [];
    this.mixer = null; this.current = null;

    const url = `/pack/assets/${form.model || `forms/${form.asset}/model.glb`}`;
    const gltf = await new Promise((res, rej) => loaderGLB.load(url, res, undefined, rej));

    // 贴图：GLB 材质名 → dump 材质 → 外挂 PNG
    const jobs = [];
    const outlines = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const isArr = Array.isArray(o.material);
      const old = isArr ? o.material.slice() : [o.material];

      // 卡通分级光照：换成 MeshToonMaterial，明暗走 gradientMap 而不是连续漫反射
      const next = old.map((m) => {
        if (!m) return m;
        if (!this.toon || m.isMeshToonMaterial) return m;
        return new THREE.MeshToonMaterial({
          color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
          gradientMap: this.ramp,
        });
      });

      // 贴图按「原材质名」查（新材质没有名字）
      old.forEach((m, i) => {
        if (!m) return;
        const info = this.pickTexture(form, m.name, shiny);
        const target = next[i];
        if (!info || !target) return;
        jobs.push((async () => {
          const t = await texLoad(`/pack/assets/${info.file}`, info.srgb);
          if (!t) return;
          target.map = t;
          target.transparent = true;
          target.alphaTest = 0.06;
          target.depthWrite = true;
          if (target.isMeshStandardMaterial) { target.roughness = 0.92; target.metalness = 0.0; }
          target.needsUpdate = true;
        })());
      });
      o.material = isArr ? next : next[0];

      // 只有身体（_By）在游戏里有对应的描边材质 _Ol，眼睛和嘴巴不描边
      const byIdx = old.findIndex((m) => m && /_By$/.test(m.name || ''));
      if (this.outline && byIdx >= 0) outlines.push([o, isArr ? byIdx : -1]);
    });
    await Promise.all(jobs);

    // 描边要在模型已经挂进场景后建（需要 parent）
    this.root.add(gltf.scene);
    for (const [m, gi] of outlines) this.buildOutline(m, gi);

    // 包围盒（绑定姿态，够用）。先把自身变换清零，否则会把上一次的缩放/位移算进去
    const keepScale = this.inner.scale.clone();
    const keepPos = this.inner.position.clone();
    const keepYaw = this.root.rotation.y;
    this.inner.scale.setScalar(1);
    this.inner.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.updateWorldMatrix(true, true);

    const box = new THREE.Box3();
    gltf.scene.traverse((o) => {
      if (o.isMesh && o.geometry && o.visible !== false) {
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        box.union(bb);
      }
    });

    this.inner.scale.copy(keepScale);
    this.inner.position.copy(keepPos);
    this.root.rotation.y = keepYaw;
    if (box.isEmpty()) box.set(new THREE.Vector3(-.3, 0, -.3), new THREE.Vector3(.3, 1, .3));
    this.meshBox = box;
    this.ready = true;

    // 动画
    // 游戏里的 Walk / Run / JumpFall 都带 Root 位移（根位移），在窗口里播就是"边走边平移"，
    // 跳跃时直接平移出窗框。桌宠不自己搬家，所以把 Root 的位移轨道剥掉，动作原地播。
    const rootNames = new Set();
    gltf.scene.traverse((o) => { if (/^root$/i.test(o.name || '')) rootNames.add(o.name); });
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const src of gltf.animations || []) {
      const tracks = src.tracks.filter((t) => {
        const [node, prop] = t.name.split('.');
        return !(rootNames.has(node) && prop === 'position');
      });
      const c = tracks.length === src.tracks.length
        ? src
        : new THREE.AnimationClip(src.name, src.duration, tracks);
      this.clips.set(c.name, c);
      const a = this.mixer.clipAction(c);
      a.setLoop(THREE.LoopRepeat, Infinity);
      this.actions.set(c.name, a);
    }

    // 走动速度：按动作自带的根位移折算成像素/秒（游戏里跑得欢，桌面要慢很多）
    this.motion = {};
    for (const c of form.clips || []) {
      if (!c.root_motion_cm || !c.seconds) continue;
      this.motion[c.logical] = (c.root_motion_cm / c.seconds) * pxPerCm * 0.34;
    }

    this.layout();
    // 所有动作实际能占到的范围（跳跃会把身子抬出绑定姿态不少）
    this.overhang = this.measureMotion(5);
    this.play(this.has('Idle') ? 'Idle' : (gltf.animations[0] && gltf.animations[0].name), { loop: true });
    return { clips: [...this.clips.keys()], heightCm: form.height_cm, overhang: this.overhang };
  }

  has(name) { return !!name && this.clips.has(name); }

  /**
   * 量一遍所有动作真实占多大地方。
   * 绑定姿态的包围盒只算静止姿势，跳跃 / 技能 / 挥手会把身体抬出去一大截，
   * 按它算窗口就会把头或手切掉。这里把每个动作采样几帧渲染到一张离屏小图上，
   * 扫描非透明像素拿真实边界，算出比绑定姿态多出来的上 / 下 / 左 / 右余量。
   * 返回 {top, bot, side}，单位是模型自己的坐标（fitWindow 里再乘缩放）。
   */
  measureMotion(samples = 5, argMeasure = false) {
    const zero = { top: 0, bot: 0, side: 0 };
    if (!this.ready || !this.mixer || !this.renderer) return zero;
    const W = 160, H = 200;
    const b = this.meshBox;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -8000, 8000);

    try {
      const rt = new THREE.WebGLRenderTarget(W, H);
      const buf = new Uint8Array(W * H * 4);
      const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
      const e = Math.max(b.max.x - b.min.x, b.max.y - b.min.y) * 2.8 + 1;
      cam.left = cx - e / 2; cam.right = cx + e / 2;
      cam.top = cy + e / 2; cam.bottom = cy - e / 2;
      cam.updateProjectionMatrix();

      // 量的是模型自身坐标：先把缩放 / 位移 / 转身清零
      const ks = this.inner.scale.clone(), kp = this.inner.position.clone(), ky = this.root.rotation.y;
      this.inner.scale.setScalar(1); this.inner.position.set(0, 0, 0); this.root.rotation.set(0, 0, 0);

      const box = new THREE.Box3().copy(b);
      for (const a of this.actions.values()) {
        const clip = a.getClip();
        if (!clip || !clip.duration) continue;
        for (let i = 0; i < samples; i++) {
          this.mixer.stopAllAction();
          a.reset(); a.enabled = true; a.play();
          this.mixer.setTime((i + 0.5) / samples * clip.duration);
          this.renderer.setRenderTarget(rt);
          this.renderer.clear();
          this.renderer.render(this.scene, cam);
          this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
          this.renderer.setRenderTarget(null);

          let minX = W, maxX = -1, minY = H, maxY = -1;
          for (let y = 0; y < H; y++) {
            const row = y * W * 4;
            for (let x = 0; x < W; x++) {
              if (buf[row + x * 4 + 3] > 12) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0) continue;
        if (argMeasure) {
          const ty = cam.bottom + ((maxY + 1) / H) * e, by = cam.bottom + (minY / H) * e;
          console.log('[meas]', clip.name, 't=' + ((i + 0.5) / samples * clip.duration).toFixed(2),
            'top=' + (ty - b.max.y).toFixed(2), 'bot=' + (b.min.y - by).toFixed(2));
        }
          // readPixels 原点在左下角，所以 y 越小 = 世界坐标越低
          box.expandByPoint(new THREE.Vector3(cam.left + (minX / W) * e, cam.bottom + (minY / H) * e, 0));
          box.expandByPoint(new THREE.Vector3(cam.left + ((maxX + 1) / W) * e, cam.bottom + ((maxY + 1) / H) * e, 0));
        }
      }
      rt.dispose();
      this.inner.scale.copy(ks); this.inner.position.copy(kp); this.root.rotation.y = ky;

      zero.top = Math.max(0, box.max.y - b.max.y);
      zero.bot = Math.max(0, b.min.y - box.min.y);
      zero.side = Math.max(0, b.max.x - box.max.x, box.min.x - b.min.x);
      return zero;
    } catch (err) {
      if (typeof console !== 'undefined') console.log('[measure] fail', err && err.message);
      return zero;
    }
  }

  /**
   * 宠物在窗口里实际占的那块矩形（CSS 像素）。窗口比宠物大一圈留了跳跃的余量，
   * 靠这个矩形判断鼠标是不是真的点在它身上 —— 空白区域就让点击穿透到桌面。
   */
  screenRect() {
    if (!this.ready) return null;
    const b = this.meshBox, s = this.inner.scale.x;
    const px = this.inner.position.x, py = this.inner.position.y;
    return {
      x0: b.min.x * s + px + this.w / 2,
      x1: b.max.x * s + px + this.w / 2,
      y0: this.h / 2 - (b.max.y * s + py),
      y1: this.h / 2 - (b.min.y * s + py),
    };
  }

  /**
   * 亮度探针：把当前画面渲染到一张小图，统计不透明像素的平均亮度（0~1）。
   * 只是给"卡通光够不够亮"一个可量化的数，正常跑不会调。
   */
  lumaProbe() {
    if (!this.ready) return null;
    const W = 120, H = Math.max(1, Math.round(120 * this.h / this.w));
    const rt = new THREE.WebGLRenderTarget(W, H);
    try {
      this.renderer.setRenderTarget(rt);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      const buf = new Uint8Array(W * H * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      let sum = 0, n = 0, hot = 0;
      for (let i = 0; i < W * H; i++) {
        const a = buf[i * 4 + 3];
        if (a < 140) continue;
        const l = (0.299 * buf[i * 4] + 0.587 * buf[i * 4 + 1] + 0.114 * buf[i * 4 + 2]) / 255;
        sum += l; n++; if (l > 0.97) hot++;
      }
      return { mean: n ? +(sum / n).toFixed(3) : 0, px: n, clipped: n ? +(hot / n).toFixed(3) : 0 };
    } catch { return null; } finally {
      this.renderer.setRenderTarget(null);
      rt.dispose();
    }
  }

  hitTest(x, y, pad = 12) {
    const r = this.screenRect();
    if (!r) return false;
    return x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;
  }

  /**
   * 切动作。注意：淡出的是「上一个动作」，必须用局部变量抓住 ——
   * 之前写成了 setTimeout(() => this.current.stop())，结果把刚播的新动作给停了，表现就是卡死在一个动作上。
   */
  play(name, { loop = true, fade = 0.25, speed = 1 } = {}) {
    if (!this.mixer || !this.has(name)) return 0;
    const next = this.actions.get(name);
    const prev = this.current;
    clearTimeout(this._stopT);

    if (prev && prev !== next) {
      prev.fadeOut(fade);
      this._stopT = setTimeout(() => prev.stop(), fade * 1000 + 60);
    }
    clearTimeout(this._backT);
    next.reset();
    next.enabled = true;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    next.timeScale = speed;
    next.fadeIn(fade).play();
    this.current = next;
    return this.clips.get(name).duration / speed;
  }

  /** 播完一次性动作后回到 back */
  once(name, back = 'Idle', onEnd = null) {
    if (!this.has(name)) { this.play(back, { loop: true }); if (onEnd) onEnd(); return 0; }
    const d = this.play(name, { loop: false, fade: 0.18 });
    clearTimeout(this._backT);
    this._backT = setTimeout(() => {
      this.play(back, { loop: true, fade: 0.35 });
      if (onEnd) onEnd();
    }, Math.max(200, d * 1000 - 80));
    return d;
  }

  /** 走路速度（像素/秒），没有根位移的动作给个兜底值 */
  speedOf(name) {
    return this.motion[name] || (name === 'Run' ? 110 : 58) * ((this.targetPx || 200) / 200);
  }

  face(dir) {
    this.yawTarget = dir < 0 ? -Math.PI * 0.18 : (dir > 0 ? Math.PI * 0.18 : 0);
  }

  update(dt) {
    if (this.mixer) this.mixer.update(dt);
    this.yaw += (this.yawTarget - this.yaw) * Math.min(1, dt * 6);
    this.root.rotation.y = this.yaw;
    if (this.ready) this.renderer.render(this.scene, this.camera);
  }
}
