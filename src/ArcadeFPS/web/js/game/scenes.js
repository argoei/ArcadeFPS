// game/scenes.js —— 场景定义与构建。
//
// 场景是"声明式数据 + 构建函数"的组合：
//   · declare() 给出尺寸、材质、道具清单、生成点、可行走区域；
//   · build()   把声明变成渲染器实例 + 碰撞盒 + 玩家出生点。
// 这样切换场景时只需换一个场景对象，不需要为 8 个场景各写一套渲染分支。
//
// 美术方向：日式街机射击（arcade shooter）的典型布景 ——
// 高对比打光、明确的掩体层次、饱和色块标识可交互区域，
// 而不是纯粹的写实。纯写实会牺牲"可读性"，而街机射击的第一要务是
// 玩家在 0.2 秒内看清"敌人在哪、掩体在哪、出口在哪"。

import * as Geo from '../render/geometry.js';
import { box, plane, cylinder, cone, mergedBoxes, sphere } from '../render/geometry.js';
import { makeRng, clamp, TAU } from '../core/math.js';

/** 全部室外体素世界。放弃写实场景，改用《我的世界》风 —— 方块堆叠的地形
 *  配合面光照 + 像素贴图，是程序化生成最合适的形态。 */
export const SCENES = [
  { key: 'plains', name: '方块草原', en: 'VOXEL PLAINS', indoor: false, theme: 'plains',
    bounds: [56, 16, 44], fogScale: 0.75, spawnPlayer: [0, 1.7, 16] },
  { key: 'hills',   name: '方块山地', en: 'VOXEL HILLS', indoor: false, theme: 'hills',
    bounds: [56, 20, 44], fogScale: 0.65, spawnPlayer: [0, 1.7, 16] },
  { key: 'desert',  name: '方块沙漠', en: 'VOXEL DESERT', indoor: false, theme: 'desert',
    bounds: [56, 16, 44], fogScale: 0.75, spawnPlayer: [0, 1.7, 16] },
  { key: 'ruins',   name: '方块遗迹', en: 'VOXEL RUINS', indoor: false, theme: 'ruins',
    bounds: [56, 16, 44], fogScale: 0.75, spawnPlayer: [0, 1.7, 16] },
  { key: 'room',    name: '室内仓库', en: 'THE ROOM', indoor: true, theme: 'room',
    bounds: [56, 12, 44], fogScale: 1.4, spawnPlayer: [0, 1.7, 16] },
  { key: 'palace',  name: '方块宫殿', en: 'VOXEL PALACE', indoor: false, theme: 'palace',
    bounds: [56, 16, 44], fogScale: 0.9, spawnPlayer: [0, 1.7, 16] },
  { key: 'forest',  name: '方块森林', en: 'VOXEL FOREST', indoor: false, theme: 'forest',
    bounds: [56, 16, 44], fogScale: 0.7, spawnPlayer: [0, 1.7, 16] },
  { key: 'dungeon', name: '地牢', en: 'THE DUNGEON', indoor: true, theme: 'dungeon',
    bounds: [56, 12, 44], fogScale: 1.8, spawnPlayer: [0, 1.7, 16] },
];

/* 体素世界全是室外，天气池统一。 */
const OUTDOOR_WEATHER = ['clear', 'overcast', 'rain', 'storm', 'snow', 'fog', 'dusk', 'night'];

/** 场景 × 场景 的天气搭配是随机的；这里返回该场景允许的天气列表。 */
export function weatherPoolFor(scene) {
  return OUTDOOR_WEATHER;
}

/**
 * 构建器。产出：
 *   renderer  —— 已填充的渲染批
 *   obstacles —— 轴对齐碰撞盒（玩家与敌人共用）
 *   spawnPoints —— 敌人生成点
 *   props     —— 需要逐帧做特殊处理的物体（灯具、旋转的游乐设施等）
 *   floorY    —— 地面高度
 *   ceiling   —— 是否有天花板（影响手雷弹跳与视线遮挡）
 */
export function buildScene(renderer, textures, sceneDef, seed) {
  const rng = makeRng(seed);
  const [W, H, D] = sceneDef.bounds;
  const hw = W / 2, hd = D / 2;

  const out = {
    obstacles: [],
    spawnPoints: [],
    props: [],
    lights: [],
    ladders: [],   // 梯子攀爬区（窄 AABB，不参与碰撞，按住空格攀爬）
    floorY: 0,
    ceiling: sceneDef.indoor,
    bounds: sceneDef.bounds,
  };

  /* ---- 几何批（每种"材质 + 形状"一个实例批） ---- */
  const batches = {};
  function batchFor(geomKey, texName) {
    const key = geomKey + '|' + texName;
    if (!batches[key]) {
      let geo;
      switch (geomKey) {
        case 'box': geo = box(1, 1, 1); break;
        case 'plane': geo = plane(1, 1, 1, 'y'); break;
        case 'wall': geo = plane(1, 1, 1, 'z'); break;
        // 曲面体细分提高（面数约 3 倍）：圆柱 12→32 边、锥 10→32 边、球 12×8→32×24，
        // 树干/枪管/屋顶/火球更圆滑精致
        case 'cyl': geo = cylinder(0.5, 0.5, 1, 32, true); break;
        case 'cone': geo = cone(0.5, 1, 32); break;
        case 'sphere': geo = sphere(0.5, 32, 24); break;
        default: geo = box(1, 1, 1);
      }
      const b = renderer.batch(key, geo, 9000);
      b.texture = textures[texName];
      batches[key] = b;
    }
    return batches[key];
  }

  const M = {};   // 复用的临时矩阵
  const tmpMat = new Float32Array(16);

  /** 放一个盒体到渲染批，并按需登记碰撞盒。 */
  function place(geomKey, texName, x, y, z, sx, sy, sz, yaw, color, opts = {}) {
    const b = batchFor(geomKey, texName);
    composeBox(tmpMat, x, y, z, sx, sy, sz, yaw || 0);
    b.list.push({
      mat: Float32Array.from(tmpMat),
      color: color || [0.8, 0.8, 0.8],
      rough: opts.rough ?? 0.78,
      emissive: opts.emissive || 0,
      caster: opts.caster !== false,
    });
    if (opts.collide) {
      const box = { min: [x - sx / 2, y - sy / 2, z - sz / 2], max: [x + sx / 2, y + sy / 2, z + sz / 2] };
      // 记录渲染批与实例索引，爆炸"炸碎方块"时据此同时隐藏渲染实例
      box.batch = b;
      box.idx = b.list.length - 1;
      out.obstacles.push(box);
    }
    return b.list[b.list.length - 1];
  }

  /* ---- 体素世界：方块堆叠地形（Minecraft 风） ---- */
  buildVoxelWorld(out, rng, place, hw, hd, W, D, H, sceneDef.theme);

  /* ---- 边界：一圈基岩墙，挡住走到地图外 ---- */
  const edgeH = 3;
  const edge = (x, z, sx, sz) =>
    place('box', 'bedrock', x, edgeH / 2, z, sx, edgeH, sz, 0, [0.85, 0.85, 0.85], { collide: true });
  edge(0, hd + 1, W + 4, 2);
  edge(0, -hd - 1, W + 4, 2);
  edge(hw + 1, 0, 2, D + 4);
  edge(-hw - 1, 0, 2, D + 4);

  /* ---- 生成点：绕开障碍物，在可行走区域内取样 ---- */
  out.spawnPoints = sampleSpawnPoints(out, hw, hd, false, rng);

  out.batches = Object.values(batches);
  return out;
}

/** 从对象池复制一份矩阵，避免每个实例都 new 一个 Float32Array（GC 压力）。 */
function composeBox(out, x, y, z, sx, sy, sz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[0] = c * sx;  out[1] = 0;   out[2] = -s * sx; out[3] = 0;
  out[4] = 0;       out[5] = sy;  out[6] = 0;       out[7] = 0;
  out[8] = s * sz;  out[9] = 0;   out[10] = c * sz; out[11] = 0;
  out[12] = x;      out[13] = y;  out[14] = z;      out[15] = 1;
  return out;
}

/* ================================================================= 体素世界 */

/** 主题种子：字符串 -> 整数。地形噪声用，同一主题地形恒定。 */
function themeSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

/**
 * 方块堆叠地形（Minecraft 风）。四个主题共用一套 fBm 噪声地形，
 * 只换顶层方块与点缀物。面光照 + 16×16 像素贴图让每个方块有清晰的
 * 顶/侧/底明暗差异 —— 这是体素风立体的全部秘密。
 */
function buildVoxelWorld(out, rng, place, hw, hd, W, D, H, theme) {
  const THEMES = {
    plains: { top: 'grassTop', sub: 'dirt', deep: 'stone', maxH: 2, trees: 14, flower: true },
    hills:  { top: 'stone',    sub: 'stone', deep: 'stone', maxH: 6, trees: 6,  snow: true },
    desert: { top: 'sand',     sub: 'sand',  deep: 'sand',  maxH: 3, trees: 0,  cactus: true },
    ruins:  { top: 'grassTop', sub: 'dirt',  deep: 'stone', maxH: 2, trees: 8,  ruin: true },
    room:    { top: 'plank',   sub: 'plank', deep: 'stone', maxH: 0, trees: 0,  furniture: true, ceiling: true },
    palace:  { top: 'stone',   sub: 'stone', deep: 'stone', maxH: 1, trees: 0,  palace: true },
    forest:  { top: 'grassTop', sub: 'dirt', deep: 'stone', maxH: 2, trees: 44, flower: true },
    dungeon: { top: 'stone',   sub: 'stone', deep: 'stone', maxH: 1, trees: 0,  dungeon: true, ceiling: true },
  };
  const T = THEMES[theme] || THEMES.plains;

  // 2D 值噪声 + fBm
  const seed = themeSeed(theme);
  const h2 = (x, z) => {
    let h = (x * 374761393 + z * 668265263 + seed) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };
  const smooth = (x, z) => {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = x - xi, zf = z - zi;
    const sx = xf * xf * (3 - 2 * xf), sz = zf * zf * (3 - 2 * zf);
    return h2(xi, zi) + (h2(xi + 1, zi) - h2(xi, zi)) * sx +
           (h2(xi, zi + 1) - h2(xi, zi)) * sz +
           (h2(xi, zi) - h2(xi + 1, zi) - h2(xi, zi + 1) + h2(xi + 1, zi + 1)) * sx * sz;
  };
  const fbm = (x, z) => {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < 4; i++) {
      sum += smooth(x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
  const heightAt = (x, z) => Math.floor(fbm(x * 0.12, z * 0.12) * (T.maxH + 1));

  /**
   * 用半砖（s 见方）堆叠一个半球：大量小立方体的球形堆叠，棱角更圆润、
   * 立体感更强，比单一大方块更接近真实物件（蘑菇菌盖/树冠）。
   * cy 为半球底部高度，向上堆叠半径 R 的半球。
   */
  const placeDome = (cx, cy, cz, R, s, tex, color, collide = false) => {
    const steps = Math.ceil(R / s);
    for (let iy = 0; iy <= steps; iy++) {
      const yOff = iy * s;
      const rr = Math.sqrt(Math.max(0, R * R - yOff * yOff));  // 该层截面半径
      const rSteps = Math.ceil(rr / s);
      for (let ix = -rSteps; ix <= rSteps; ix++) {
        for (let iz = -rSteps; iz <= rSteps; iz++) {
          if (Math.hypot(ix * s, iz * s) > rr) continue;
          place('box', tex, cx + ix * s, cy + yOff, cz + iz * s, s, s, s, 0, color, { collide });
        }
      }
    }
  };

  const x0 = Math.floor(-hw), x1 = Math.ceil(hw);
  const z0 = Math.floor(-hd), z1 = Math.ceil(hd);

  /* ---- 地形方块 ----
     方块从 y=-1 堆到 y=h，顶面 y=h。玩家脚底 y=0 站在平地（h=0）顶面。
     旧版草方块占 y=0~1、顶面 y=1，玩家脚底仍是 y=0，等于"陷进"草方块 1 米，
     视角过低 —— 这是空间感差、易眩晕的根因之一。 */
  const isGrassTheme = T.top === 'grassTop';
  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1; z++) {
      const h = heightAt(x, z);
      const cx = x + 0.5, cz = z + 0.5;
      let topTex = T.top;
      if (T.snow && h >= T.maxH) topTex = 'snow';

      if (isGrassTheme && topTex === 'grassTop') {
        // 草方块：薄草顶(0.25) + 土底(0.75)，顶面在 y=h
        place('box', 'grassTop', cx, h - 0.125, cz, 1, 0.25, 1, 0, [1, 1, 1], { collide: h > 0 });
        place('box', 'dirt',     cx, h - 0.625, cz, 1, 0.75, 1, 0, [1, 1, 1], { collide: h > 0 });
      } else {
        place('box', topTex, cx, h - 0.5, cz, 1, 1, 1, 0, [1, 1, 1], { collide: h > 0 });
      }
      // 下层：i=0 是 y=-1 那层，i=h-1 是 y=h-2~h-1。山丘（h>0）的凸起部分全部是障碍
      for (let i = 0; i < h; i++) {
        const tex = i === h - 1 ? T.sub : T.deep;
        place('box', tex, cx, i - 0.5, cz, 1, 1, 1, 0, [1, 1, 1], { collide: h > 0 });
      }
    }
  }

  /* ---- 树 ---- */
  for (let i = 0; i < (T.trees || 0); i++) {
    const tx = Math.floor(rng() * (x1 - x0 - 6)) + x0 + 3;
    const tz = Math.floor(rng() * (z1 - z0 - 6)) + z0 + 3;
    const th = heightAt(tx, tz);
    if (th !== 0) continue;
    const bx = tx + 0.5, bz = tz + 0.5;
    const trunkH = 4 + Math.floor(rng() * 2);
    for (let y = 0; y < trunkH; y++) {
      place('box', 'log', bx, th + y + 0.5, bz, 1, 1, 1, 0, [1, 1, 1], { collide: true });
    }
    const topY = th + trunkH;
    // 树冠：大量半砖（0.5）堆叠成半球，棱角圆润、立体感强，接近真实树冠形状
    placeDome(bx, topY, bz, 1.8, 0.35, 'leaves', [0.3, 0.7, 0.25], true);
  }

  /* ---- 花（草原彩色点缀） ---- */
  if (T.flower) {
    for (let i = 0; i < 44; i++) {
      const fx = rng() * (x1 - x0 - 2) + x0 + 1;
      const fz = rng() * (z1 - z0 - 2) + z0 + 1;
      const fh = heightAt(Math.floor(fx), Math.floor(fz));
      if (fh !== 0) continue;
      const hue = rng();
      const col = hue < 0.33 ? [1, 0.3, 0.3] : hue < 0.66 ? [1, 0.9, 0.3] : [1, 1, 1];
      place('box', 'snow', fx + 0.5, fh + 0.3, fz + 0.5, 0.3, 0.3, 0.3, 0, col, { emissive: 0.2 });
    }
  }

  /* ---- 仙人掌（沙漠） ---- */
  if (T.cactus) {
    for (let i = 0; i < 16; i++) {
      const cx = rng() * (x1 - x0 - 2) + x0 + 1;
      const cz = rng() * (z1 - z0 - 2) + z0 + 1;
      const ch = heightAt(Math.floor(cx), Math.floor(cz));
      if (ch !== 0) continue;
      const chh = 2 + Math.floor(rng() * 3);
      for (let y = 0; y < chh; y++) {
        place('box', 'leaves', cx + 0.5, ch + y + 0.5, cz + 0.5, 0.8, 1, 0.8, 0, [0.35, 0.75, 0.3], { collide: true });
      }
    }
  }

  /* ---- 遗迹残墙（圆石，随机缺块） ---- */
  if (T.ruin) {
    for (let i = 0; i < 7; i++) {
      const rx = Math.floor(rng() * (x1 - x0 - 12)) + x0 + 6;
      const rz = Math.floor(rng() * (z1 - z0 - 12)) + z0 + 6;
      const rh = heightAt(rx, rz);
      if (rh !== 0) continue;
      const w = 3 + Math.floor(rng() * 4), hgt = 2 + Math.floor(rng() * 4);
      for (let y = 0; y < hgt; y++) {
        for (let dx = 0; dx < w; dx++) {
          if (rng() < 0.28) continue;
          place('box', 'cobble', rx + dx + 0.5, rh + y + 0.5, rz + 0.5, 1, 1, 1, 0, [0.92, 0.92, 0.9], { collide: true });
        }
      }
    }
  }

  /* ---- 岩石（灰石块，空间定位点） ---- */
  for (let i = 0; i < 14; i++) {
    const rx = rng() * (x1 - x0 - 4) + x0 + 2;
    const rz = rng() * (z1 - z0 - 4) + z0 + 2;
    const rh = heightAt(Math.floor(rx), Math.floor(rz));
    if (rh !== 0) continue;
    const big = rng() < 0.4;
    place('box', 'cobble', rx + 0.5, rh + 0.5, rz + 0.5, big ? 2 : 1, 1, big ? 2 : 1, 0, [0.9, 0.9, 0.9], { collide: true });
    if (rng() < 0.5) place('box', 'stone', rx + 0.5, rh + 1.5, rz + 0.5, 1, 1, 1, 0, [0.85, 0.85, 0.86]);
  }

  /* ---- 室内仓库：家具式掩体（木箱堆 + 承重立柱 + 顶棚） ---- */
  if (T.furniture) {
    for (let i = 0; i < 14; i++) {
      const fx = Math.floor(rng() * (x1 - x0 - 8)) + x0 + 4;
      const fz = Math.floor(rng() * (z1 - z0 - 8)) + z0 + 4;
      if (Math.abs(fx) < 3 && fz > 10) continue;   // 避开出生点走廊
      const stack = 1 + Math.floor(rng() * 2);
      for (let y = 0; y < stack; y++) {
        place('box', 'plank', fx + 0.5, y + 0.5, fz + 0.5, 1.6, 1, 1.6, 0, [0.66, 0.5, 0.3], { collide: true });
      }
    }
    for (const px of [-12, -4, 4, 12]) {
      for (const pz of [-12, 0, 12]) {
        place('box', 'cobble', px + 0.5, 3, pz + 0.5, 0.8, 6, 0.8, 0, [0.75, 0.73, 0.7], { collide: true });
      }
    }
    // 顶棚：大平面封顶，营造"室内"纵深感
    place('plane', 'plank', 0, 8, 0, W, 1, D, 0, [0.5, 0.4, 0.3], { collide: false });
  }

  /* ---- 宫殿：中央高台 + 对称金柱阵列 + 红毯步道 ---- */
  if (T.palace) {
    // 中央高台（2 层，可跳上）
    place('box', 'stone', 0.5, 0.5, -2.5, 7, 1, 7, 0, [0.93, 0.9, 0.82], { collide: true });
    place('box', 'stone', 0.5, 1.25, -2.5, 4, 0.5, 4, 0, [0.96, 0.93, 0.86], { collide: true });
    // 对称金柱：两列各 4 根
    for (const px of [-8, 8]) {
      for (const pz of [-12, -4, 4, 12]) {
        for (let y = 0; y < 5; y++) {
          place('cyl', 'snow', px + 0.5, y + 0.5, pz + 0.5, 1, 1, 1, 0, [0.9, 0.78, 0.35], { collide: true });
        }
        place('box', 'snow', px + 0.5, 5.4, pz + 0.5, 1.4, 0.7, 1.4, 0, [0.95, 0.85, 0.45], { collide: true });
      }
    }
    // 红毯步道（出生点 → 高台）
    for (let z = 14; z >= -6; z -= 1) {
      place('box', 'snow', 0.5, 0.06, z + 0.5, 3, 0.12, 1, 0, [0.72, 0.14, 0.16], { collide: false });
    }
  }

  /* ---- 地牢：石柱网格 + 火盆光点（浓雾中推进） ---- */
  if (T.dungeon) {
    for (let gx = -2; gx <= 2; gx++) {
      for (let gz = -2; gz <= 2; gz++) {
        const dx = gx * 10, dz = gz * 8 + 2;
        if (Math.abs(dx) < 4 && dz > 8) continue;   // 避开出生点
        for (let y = 0; y < 4; y++) {
          place('box', 'cobble', dx + 0.5, y + 0.5, dz + 0.5, 1.2, 1, 1.2, 0, [0.52, 0.5, 0.52], { collide: true });
        }
      }
    }
    // 火盆：暖色发光小方块（地牢唯一光源感）
    for (let i = 0; i < 10; i++) {
      const fx = Math.floor(rng() * (x1 - x0 - 8)) + x0 + 4;
      const fz = Math.floor(rng() * (z1 - z0 - 8)) + z0 + 4;
      place('box', 'cobble', fx + 0.5, 0.35, fz + 0.5, 0.8, 0.7, 0.8, 0, [0.4, 0.38, 0.38], { collide: true });
      place('box', 'snow', fx + 0.5, 0.85, fz + 0.5, 0.4, 0.35, 0.4, 0, [1, 0.62, 0.2], { emissive: 2.4, collide: false });
    }
    // 顶棚
    place('plane', 'stone', 0, 7, 0, W, 1, D, 0, [0.3, 0.3, 0.32], { collide: false });
  }

  /* ---- 蘑菇（红蘑菇，鲜艳定位点） ---- */
  for (let i = 0; i < 12; i++) {
    const mx = rng() * (x1 - x0 - 2) + x0 + 1;
    const mz = rng() * (z1 - z0 - 2) + z0 + 1;
    const mh = heightAt(Math.floor(mx), Math.floor(mz));
    if (mh !== 0) continue;
    // 白柄：细长，两段小方块
    place('box', 'snow', mx + 0.5, mh + 0.2, mz + 0.5, 0.26, 0.4, 0.26, 0, [1, 1, 1]);
    // 红菌盖：半球堆叠（半砖 0.28，半径 0.55），圆润的蘑菇头
    placeDome(mx + 0.5, mh + 0.4, mz + 0.5, 0.55, 0.2, 'snow', [1, 0.22, 0.16], false);
  }

  /* ---- 木箱（掩体 + 可破坏，被炸会碎） ---- */
  for (let i = 0; i < 10; i++) {
    const cx = Math.floor(rng() * (x1 - x0 - 2)) + x0 + 1;
    const cz = Math.floor(rng() * (z1 - z0 - 2)) + z0 + 1;
    const ch = heightAt(cx, cz);
    if (ch !== 0) continue;
    place('box', 'plank', cx + 0.5, ch + 0.5, cz + 0.5, 1, 1, 1, 0, [0.72, 0.52, 0.28], { collide: true });
  }

  /* ---- 岩石（装饰 + 掩体，半球堆叠） ---- */
  for (let i = 0; i < 9; i++) {
    const rx = rng() * (x1 - x0 - 2) + x0 + 1;
    const rz = rng() * (z1 - z0 - 2) + z0 + 1;
    const rh = heightAt(Math.floor(rx), Math.floor(rz));
    if (rh !== 0) continue;
    placeDome(rx + 0.5, rh, rz + 0.5, 0.65, 0.32, 'stone', [0.55, 0.55, 0.58], true);
  }

  /* ---- 栅栏（低掩体，可躲在后面射击） ---- */
  for (let i = 0; i < 8; i++) {
    const fx = Math.floor(rng() * (x1 - x0 - 2)) + x0 + 1;
    const fz = Math.floor(rng() * (z1 - z0 - 2)) + z0 + 1;
    const fh = heightAt(fx, fz);
    if (fh !== 0) continue;
    const wood = [0.6, 0.45, 0.25];
    place('box', 'plank', fx + 0.5, fh + 0.55, fz + 0.5, 0.15, 1.1, 0.15, 0, wood, { collide: true });
    place('box', 'plank', fx + 1.2, fh + 0.55, fz + 0.5, 0.15, 1.1, 0.15, 0, wood, { collide: true });
    place('box', 'plank', fx + 0.85, fh + 0.85, fz + 0.5, 1.0, 0.12, 0.1, 0, wood, { collide: true });
  }

  /* ---- 灯笼（光源装饰，昏暗场景里提供可见光） ---- */
  for (let i = 0; i < 6; i++) {
    const lx = Math.floor(rng() * (x1 - x0 - 2)) + x0 + 1;
    const lz = Math.floor(rng() * (z1 - z0 - 2)) + z0 + 1;
    const lh = heightAt(lx, lz);
    if (lh !== 0) continue;
    place('box', 'snow', lx + 0.5, lh + 0.15, lz + 0.5, 0.25, 0.3, 0.25, 0, [1, 0.8, 0.3], { emissive: 2.2 });
  }

  /* ---- 荷兰风车（圆锥塔身 + 帽形顶带小窗 + 正面四片大叶片风轮，约敌人 5 倍高） ---- */
  {
    const wx = 0;
    // 找平地点：从 z=19 向内扫描（叶片朝 +z 伸出 1.65m，必须离边界墙 z=22 留足距离）
    let wz = 0;
    for (let z = 19; z >= 14; z--) {
      if (heightAt(wx, z) === 0) { wz = z; break; }
    }
    if (wz > 0) {
      const towerH = 9;                  // 敌人 ~1.85m ×5 ≈ 9 方块
      const cx = wx + 0.5, cz = wz + 0.5;
      // 圆锥形塔身：9 层逐层收窄（底部 4×4 → 顶部 2.24×2.24），体素近似圆锥
      for (let i = 0; i < towerH; i++) {
        const s = 4.0 - i * 0.22;        // 上窄下宽
        place('box', 'plank', cx, i + 0.5, cz, s, 1, s, 0, [0.72, 0.55, 0.34], { collide: true });
      }
      // 帽形塔顶：深色盖帽 + 帽顶尖
      place('box', 'cobble', cx, towerH + 0.4, cz, 2.7, 0.8, 2.7, 0, [0.3, 0.27, 0.24], { collide: true });
      place('box', 'cobble', cx, towerH + 1.0, cz, 1.2, 0.4, 1.2, 0, [0.24, 0.21, 0.19], { collide: true });
      // 帽正面小窗（暖黄发光，朝向出生点方向，夜里像亮灯）
      place('box', 'snow', cx, towerH + 0.45, cz + 1.36, 0.45, 0.6, 0.08, 0, [1, 0.85, 0.5], { emissive: 1.3, collide: false });
      // 四片大叶片风轮：绕帽正面（朝 +z）的水平轴旋转，动画由 props.windmill 驱动
      out.props.push({ kind: 'windmill', x: cx, y: towerH + 0.45, z: cz + 1.65, angle: 0 });
    }
  }

  /* ---- 火把（柄高约蘑菇高度，火焰悬空组团飘动） ---- */
  for (let i = 0; i < 10; i++) {
    const tx = Math.floor(rng() * (x1 - x0 - 2)) + x0 + 1;
    const tz = Math.floor(rng() * (z1 - z0 - 2)) + z0 + 1;
    const th = heightAt(tx, tz);
    if (th !== 0) continue;
    // 柄（棕色，0.6 高）
    place('box', 'plank', tx + 0.5, th + 0.3, tz + 0.5, 0.16, 0.6, 0.16, 0, [0.5, 0.35, 0.2], { collide: true });
    // 火焰：4 个悬空小方块（独立飘动，模拟燃烧）
    const flames = [];
    for (let f = 0; f < 4; f++) {
      flames.push({
        phase: rng() * TAU, amp: 0.06 + rng() * 0.09,
        h: 0.25 + f * 0.14, speed: 0.5 + rng() * 1.5,
        size: 0.1 + rng() * 0.08,
        color: f === 0 ? [1, 0.85, 0.3] : [1, 0.45 + rng() * 0.3, 0.1],
        ox: 0, oy: 0, oz: 0,
      });
    }
    out.props.push({ kind: 'torch', x: tx + 0.5, y: th + 0.55, z: tz + 0.5, flames });
  }

  /* ---- 喷泉（水池 + 向上喷蓝色水柱 + 重力回落，仿火把粒子风格） ---- */
  {
    // 随机找一个平地位置（固定位置可能撞上山丘导致喷泉整块不生成）
    let fx = null, fz = null;
    for (let i = 0; i < 60 && fx === null; i++) {
      const tx = Math.floor(rng() * (x1 - x0 - 6)) + x0 + 3;
      const tz = Math.floor(rng() * (z1 - z0 - 6)) + z0 + 3;
      if (heightAt(tx, tz) === 0 && heightAt(tx + 2, tz + 2) === 0) {
        fx = tx; fz = tz;
      }
    }
    if (fx !== null) {
      const cx = fx + 2.5, cz = fz + 2.5;   // 喷泉中心（5×5 水池中心）
      // 池底（水面，水蓝色）
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          place('box', 'snow', cx + dx, 0.15, cz + dz, 1, 0.3, 1, 0, [0.35, 0.62, 0.92], { collide: false });
        }
      }
      // 池壁（一圈，高 1 方块）
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
            place('box', 'stone', cx + dx, 0.5, cz + dz, 1, 1, 1, 0, [0.62, 0.62, 0.68], { collide: true });
          }
        }
      }
      // 喷泉 props（水柱粒子 + 涟漪）
      out.props.push({ kind: 'fountain', x: cx, y: 0.3, z: cz, timer: 0, ripple: 0 });
    }
  }

  /* ---- 小径（沙土带，从出生点向前延伸，方向参照） ---- */
  for (let i = 0; i < 16; i++) {
    const pz = 14 - i * 0.9;
    if (heightAt(0, Math.floor(pz)) !== 0) continue;
    place('box', 'sand', 0.5, 0.06, pz + 0.5, 2, 0.12, 1.2, 0, [0.9, 0.85, 0.7], { collide: false });
  }

  /* ---- 狙击塔（高处平台，供玩家攀上狙击） ---- */
  {
    const tx = 0, tz = -18;            // 地图中央偏后（出生点 z=16 对面）
    if (heightAt(tx, tz) === 0) {      // 只在平地建塔
      const towerH = 5;
      const bx = tx + 0.5, bz = tz + 0.5;
      // 塔身：3×3 实心木板
      for (let y = 0; y < towerH; y++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            place('box', 'plank', bx + dx, y + 0.5, bz + dz, 1, 1, 1, 0, [1, 1, 1], { collide: true });
          }
        }
      }
      // 顶部平台：5×5 木板（顶面 y = towerH+1 = 6）
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          place('box', 'plank', bx + dx, towerH + 0.5, bz + dz, 1, 1, 1, 0, [1, 1, 1], { collide: true });
        }
      }
      // 梯子：塔南侧（bz+2）从地面直达平台顶面（y=6）。两根竖杆 + 横档，
      // 本体不碰撞；攀爬区（窄 AABB）注册到 out.ladders，按住空格即可上爬。
      const lz = bz + 2;
      place('box', 'log', bx - 0.4, 3, lz, 0.12, 6, 0.12, 0, [0.55, 0.4, 0.24], { collide: false });
      place('box', 'log', bx + 0.4, 3, lz, 0.12, 6, 0.12, 0, [0.55, 0.4, 0.24], { collide: false });
      for (let y = 0.4; y < 6; y += 0.5) {
        place('box', 'log', bx, y, lz, 0.9, 0.1, 0.1, 0, [0.62, 0.46, 0.28], { collide: false });
      }
      out.ladders.push({
        min: [bx - 0.5, 0, lz - 0.35], max: [bx + 0.5, towerH + 1, lz + 0.35],
      });
    }
  }
}

/* ---------------------------------------------------------------- 工具 */

function D2(hd) { return hd; }
function W_(hw) { return hw; }

function c1(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

/**
 * 生成点采样：在可行走区域里取样，拒绝落在障碍里的点。
 * 拒绝采样而不是"把点推到空处"——后者会产出靠墙的点，玩家看着别扭。
 *
 * 关键：山地等起伏大的场景，平地区域很少，旧版"落在任何高障碍即拒绝"导致
 * 采样只剩 9 个点（实测），敌人挤在相同位置生成、甚至 spawn 失败。
 * 改为：落在矮山丘（顶面 <= 2 方块）时，用其顶面高度作为生成点 y（敌人可站上去）。
 */
function sampleSpawnPoints(out, hw, hd, indoor, rng) {
  const pts = [];
  const tries = 900;
  for (let i = 0; i < tries; i++) {
    const x = (rng() - 0.5) * (hw * 2 - 3);
    const z = (rng() - 0.5) * (hd * 2 - 3);
    let groundY = 0;
    let blocked = false;
    for (const o of out.obstacles) {
      if (x > o.min[0] - 0.2 && x < o.max[0] + 0.2 &&
          z > o.min[2] - 0.2 && z < o.max[2] + 0.2) {
        if (o.max[1] <= 2) {
          // 矮障碍：可站上去，取最高顶面作生成高度
          groundY = Math.max(groundY, o.max[1]);
        } else {
          blocked = true; break;
        }
      }
    }
    if (blocked) continue;
    pts.push([x, groundY, z]);
    if (pts.length >= 64) break;
  }
  // 兜底：极端情况下障碍过密，至少给一圈边缘点
  if (pts.length < 8) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      pts.push([Math.cos(a) * (hw - 2), 0, Math.sin(a) * (hd - 2)]);
    }
  }
  return pts;
}

/** 挑选与当前场景搭配的天气（随机但受场景限制）。 */
export function pickWeather(sceneDef, rng) {
  const pool = weatherPoolFor(sceneDef);
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/** 循环推进到下一个场景。 */
export function nextScene(index) {
  return (index + 1) % SCENES.length;
}
