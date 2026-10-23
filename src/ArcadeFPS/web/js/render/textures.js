// render/textures.js —— 程序化贴图。全部用 Canvas2D 在运行时画出来，
// 再上传为 GPU 纹理。理由：外部图片文件是"可直接运行"的最大敌人
// （路径、丢失、加载时序都不可控），程序化贴图 0 依赖且能按场景需要定制。

import { makeRng, TAU, clamp, lerp } from '../core/math.js';

/** 值噪声（带 fBm 叠加）。写实感主要来自贴图的**高频细节**，
 *  纯色或低频渐变会立刻暴露"这是程序画的"。 */
function valueNoise2D(seed) {
  const rng = makeRng(seed);
  const SIZE = 256;
  const grid = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  const at = (x, y) => grid[((y & 255) * SIZE) + (x & 255)];
  const smooth = (t) => t * t * (3 - 2 * t);

  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = lerp(at(xi, yi), at(xi + 1, yi), xf);
    const b = lerp(at(xi, yi + 1), at(xi + 1, yi + 1), xf);
    return lerp(a, b, yf);
  };
}

function fbm(noise, x, y, octaves = 5, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

function newCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function finish(canvas, size) {
  return { canvas, size };
}

/**
 * 通用材质贴图：底色 + fBm 噪声 + 可选的结构条纹/污渍。
 * 输出同时带 albedo（RGB）与粗糙度扰动（A 通道，省一张贴图与一次采样）。
 */
export function makeMaterial(size, opts) {
  const {
    base = [128, 128, 128],
    contrast = 0.18,
    grain = 0.35,
    scale = 6,
    seed = 1,
    stripes = 0,
    grime = 0,
    tiles = 0,
  } = opts || {};

  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const noise = valueNoise2D(seed);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size, v = y / size;

      let f = fbm(noise, u * scale, v * scale, 5);
      let r = base[0] / 255, g = base[1] / 255, b = base[2] / 255;

      // 大尺度明暗（受光不均），让平面不至于死板
      const macro = fbm(noise, u * scale * 0.25, v * scale * 0.25, 3);
      const shade = 1 + (macro - 0.5) * contrast * 2;

      // 细粒度
      const fine = (f - 0.5) * grain;

      let rr = r * shade + fine;
      let gg = g * shade + fine;
      let bb = b * shade + fine;

      // 条纹（木纹 / 金属拉丝 / 瓷砖缝）
      if (stripes > 0) {
        const s = Math.sin((u * scale * 6.0 + fbm(noise, u * 2, v * 8, 3) * 3.0) * Math.PI) * 0.5 + 0.5;
        const m = 1 + (s - 0.5) * stripes;
        rr *= m; gg *= m; bb *= m;
      }

      // 污渍（墙角/地面/锈迹）
      if (grime > 0) {
        const gr = fbm(noise, u * 3 + 40, v * 3 + 40, 4);
        const k = Math.max(0, gr - 0.55) * 2 * grime;
        rr *= 1 - k * 0.7; gg *= 1 - k * 0.72; bb *= 1 - k * 0.65;
      }

      // 瓷砖缝：网格状暗线
      if (tiles > 0) {
        const tu = (u * tiles) % 1, tv = (v * tiles) % 1;
        const edge = Math.min(tu, 1 - tu, tv, 1 - tv);
        if (edge < 0.035) {
          const k = 1 - edge / 0.035;
          rr *= 1 - k * 0.45; gg *= 1 - k * 0.45; bb *= 1 - k * 0.42;
        }
      }

      d[i]     = clamp(rr, 0, 1) * 255;
      d[i + 1] = clamp(gg, 0, 1) * 255;
      d[i + 2] = clamp(bb, 0, 1) * 255;
      // A 通道存粗糙度：高频处更粗糙（磨损/粗糙感），这是廉价高回报的写实技巧
      d[i + 3] = clamp(0.5 + (1 - f) * grain * 0.8, 0, 1) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, size);
}

/** 天空渐变贴图（穹顶用）。上半天光、下半地平雾色，中间按天气插值。 */
export function makeSky(size, topColor, horizonColor, bottomColor, cloudiness, seed) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const noise = valueNoise2D(seed);

  for (let y = 0; y < size; y++) {
    const v = y / size;                  // 0 = 天顶
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size;

      let r, g, b;
      if (v < 0.5) {
        const t = Math.pow(v / 0.5, 0.7);
        r = lerp(topColor[0], horizonColor[0], t);
        g = lerp(topColor[1], horizonColor[1], t);
        b = lerp(topColor[2], horizonColor[2], t);
      } else {
        const t = (v - 0.5) / 0.5;
        r = lerp(horizonColor[0], bottomColor[0], t);
        g = lerp(horizonColor[1], bottomColor[1], t);
        b = lerp(horizonColor[2], bottomColor[2], t);
      }

      if (cloudiness > 0) {
        // 云层只在上半天，且越靠天顶越薄（与透视一致）
        const band = v < 0.55 ? 1 - v / 0.55 : 0;
        const n = fbm(noise, u * 7, v * 4 + 10, 5);
        const c2 = clamp((n - 0.48) * 2.6 * cloudiness * band, 0, 1);
        const cr = lerp(255, 40, 0.35), cg = lerp(255, 44, 0.35), cb = lerp(255, 52, 0.35);
        r = lerp(r, cr, c2); g = lerp(g, cg, c2); b = lerp(b, cb, c2);
      }

      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, size);
}

/** 径向渐变光斑。用于枪口火光、爆炸火球、路灯辉光、粒子。 */
export function makeGlow(size, innerColor, outerColor, power = 2.0) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - cx) / cx, dy = (y - cy) / cy;
      const r = Math.hypot(dx, dy);
      const t = clamp(1 - r, 0, 1);
      const a = Math.pow(t, power);
      d[i]     = lerp(outerColor[0], innerColor[0], a);
      d[i + 1] = lerp(outerColor[1], innerColor[1], a);
      d[i + 2] = lerp(outerColor[2], innerColor[2], a);
      d[i + 3] = t * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, size);
}

/** 烟雾/爆炸用的柔和团块噪声，粒子贴图。 */
export function makeSmoke(size, seed) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const noise = valueNoise2D(seed);
  const cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const r = Math.hypot((x - cx) / cx, (y - cy) / cy);
      const edge = clamp(1 - r, 0, 1);
      const n = fbm(noise, x / size * 5, y / size * 5, 4);
      const a = Math.pow(edge, 1.6) * (0.55 + n * 0.6);
      const v = 190 + n * 60;
      d[i] = v; d[i + 1] = v * 0.98; d[i + 2] = v * 0.95;
      d[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, size);
}

/** 弹孔贴花（贴在墙上的暗色弹痕 + 边缘崩落）。 */
export function makeBulletHole(size, seed) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  const cx = size / 2, cy = size / 2;

  const g = ctx.createRadialGradient(cx, cy, size * 0.05, cx, cy, size * 0.34);
  g.addColorStop(0, 'rgba(8,6,6,0.95)');
  g.addColorStop(0.6, 'rgba(30,24,20,0.7)');
  g.addColorStop(1, 'rgba(60,52,44,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.34, 0, TAU); ctx.fill();

  // 放射状裂纹
  ctx.strokeStyle = 'rgba(15,12,10,0.55)';
  for (let i = 0; i < 9; i++) {
    const a = rng() * TAU;
    const len = size * (0.12 + rng() * 0.2);
    ctx.lineWidth = 1 + rng() * 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * size * 0.1, cy + Math.sin(a) * size * 0.1);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }
  return finish(c, size);
}

/** 血迹/污渍贴花。 */
export function makeBloodSplat(size, seed) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  const cx = size / 2, cy = size / 2;
  ctx.fillStyle = 'rgba(88,10,12,0.85)';
  ctx.beginPath();
  const pts = 14;
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * TAU;
    const r = size * 0.5 * (0.7 + rng() * 0.3);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();
  // 飞溅
  for (let i = 0; i < 18; i++) {
    const a = rng() * TAU;
    const d = size * (0.3 + rng() * 0.2);
    const r = 1 + rng() * 3.5;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, TAU);
    ctx.fill();
  }
  return finish(c, size);
}

/** 粒子系统用的软圆点（雨滴/雪/火花）。 */
export function makeDot(size) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finish(c, size);
}

/** 材质库：按名字集中生成，供场景声明式引用。 */
/* ================================================================= 像素贴图（Minecraft 风） */

/** 逐像素贴图：size×size 像素，回调返回 [r,g,b,a]。NEAREST 放大后是明显的像素块。 */
function px(size, fn, seed = 1) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rng = makeRng(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fn(x, y, rng);
      const i = (y * size + x) * 4;
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = v[3] === undefined ? 255 : v[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, size };
}

/** 确定性 2D 哈希噪声：同一 (x,y,seed) 恒返回同一值，产生**连续的结构**
 * （斑块/条纹/石块），而不是 block() 那种顺序随机抖动（纯噪点）。 */
function n2(x, y, seed) {
  let h = ((x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0)) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

/** 调色板纹理：按噪声值在调色板里分带取色，freq 越高斑块越细碎。 */
function pal(palette, seed, freq = 3) {
  return px(16, (x, y) => {
    const n = n2(Math.floor(x * freq), Math.floor(y * freq), seed);
    return palette[Math.min(palette.length - 1, (n * palette.length) | 0)];
  }, seed);
}

/* ---- 各方块结构化纹理 ---- */

function grassTopTex(seed) {
  return px(16, (x, y) => {
    const n = n2(x * 2.5, y * 2.5, seed);
    if (n < 0.18) return [88, 150, 48];
    if (n < 0.30) return [142, 208, 82];
    if (n < 0.36) return [168, 220, 96];
    return [112, 178, 62];
  }, seed);
}

function grassSideTex(seed) {
  // 草方块侧面：顶部 4px 草皮 + 下面泥土（Minecraft 标志性的草皮边）
  return px(16, (x, y) => {
    if (y < 4) {
      const n = n2(x * 3, y * 3, seed);
      return n < 0.5 ? [92, 158, 56] : [112, 178, 62];
    }
    const n = n2(x * 2, y * 2, seed + 7);
    if (n < 0.3) return [124, 88, 54];
    if (n < 0.7) return [134, 96, 62];
    return [146, 108, 70];
  }, seed);
}

function dirtTex(seed) {
  return px(16, (x, y) => {
    const n = n2(x * 2, y * 2, seed);
    if (n < 0.12) return [116, 120, 112];   // 小石子
    if (n < 0.45) return [120, 84, 50];
    if (n < 0.85) return [134, 96, 62];
    return [148, 110, 72];
  }, seed);
}

function stoneTex(seed) {
  return px(16, (x, y) => {
    const n = n2(x * 3, y * 3, seed);
    if (n < 0.2) return [104, 104, 106];
    if (n < 0.6) return [126, 126, 128];
    return [142, 142, 144];
  }, seed);
}

function cobbleTex(seed) {
  // 圆石：每 4×4 一个石块 + 深缝，块内按石块种子调亮暗
  return px(16, (x, y) => {
    const cx = (x / 4) | 0, cy = (y / 4) | 0;
    if ((x % 4 === 0) || (y % 4 === 0)) return [74, 74, 76];
    const n = n2(cx, cy, seed);
    if (n < 0.33) return [104, 104, 106];
    if (n < 0.66) return [120, 120, 122];
    return [136, 136, 138];
  }, seed);
}

function logSideTex(seed) {
  // 原木侧：竖树皮条纹，带深色树皮沟
  return px(16, (x, y) => {
    const stripe = (x / 4) | 0;
    const n = n2(x, y * 3, seed + stripe);
    if (n < 0.2) return [70, 52, 30];
    if (n < 0.8) return [104, 78, 44];
    return [118, 90, 52];
  }, seed);
}

function logTopTex(seed) {
  // 原木顶：同心方环年轮
  return px(16, (x, y) => {
    const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const ring = (r / 1.5) | 0;
    return (ring % 2 === 0) ? [150, 120, 72] : [128, 100, 58];
  }, seed);
}

function leavesTex(seed) {
  // 树叶：绿调色板 + 深色孔洞（模拟叶隙）
  return px(16, (x, y) => {
    const n = n2(x * 2.5, y * 2.5, seed);
    if (n < 0.15) return [30, 66, 22];
    if (n < 0.5) return [52, 112, 38];
    if (n < 0.85) return [66, 132, 46];
    return [84, 152, 56];
  }, seed);
}

function sandTex(seed) {
  return px(16, (x, y) => {
    const n = n2(x * 2, y * 2, seed);
    if (n < 0.35) return [206, 188, 132];
    if (n < 0.85) return [218, 202, 148];
    return [232, 218, 164];
  }, seed);
}

function plankTex(seed) {
  // 木板：横向板缝 + 木纹
  return px(16, (x, y) => {
    if (y % 8 === 0) return [120, 96, 58];
    const n = n2(x * 4, y, seed);
    if (n < 0.2) return [140, 112, 68];
    if (n < 0.8) return [160, 132, 82];
    return [176, 148, 94];
  }, seed);
}

function brickTex(seed) {
  // 砖：砖块 + 砖缝 + 逐块色差
  return px(16, (x, y) => {
    const row = (y / 4) | 0;
    if ((y % 4 === 0) || (x === (row % 2 === 0 ? 0 : 8))) return [172, 164, 154];
    const n = n2(x, y, seed);
    return n < 0.4 ? [142, 82, 60] : [158, 94, 70];
  }, seed);
}

function snowTex(seed) {
  return px(16, (x, y) => {
    const n = n2(x * 2, y * 2, seed);
    if (n < 0.15) return [216, 226, 236];
    if (n < 0.9) return [238, 242, 248];
    return [250, 252, 254];
  }, seed);
}

function waterTex(seed) {
  // 水：蓝 + 波浪
  return px(16, (x, y) => {
    const n = n2(x * 3, y * 3, seed);
    if (n < 0.3) return [40, 90, 170];
    if (n < 0.7) return [52, 110, 200];
    return [70, 130, 220];
  }, seed);
}

function bedrockTex(seed) {
  return px(16, (x, y) => {
    const n = n2(x * 2, y * 2, seed);
    if (n < 0.3) return [40, 40, 42];
    if (n < 0.75) return [60, 60, 62];
    return [80, 80, 84];
  }, seed);
}

function glowstoneTex(seed) {
  return px(16, (x, y) => {
    const n = n2(x * 3, y * 3, seed);
    if (n < 0.2) return [200, 150, 60];
    if (n < 0.7) return [244, 196, 82];
    return [255, 230, 120];
  }, seed);
}

export function buildTextureLibrary(gl, textureFromImage) {
  const T = (canvas) => textureFromImage(gl, canvas, { wrap: gl.REPEAT });

  const lib = {
    grassTop: T(grassTopTex(12).canvas),
    grassSide:T(grassSideTex(13).canvas),
    dirt:     T(dirtTex(21).canvas),
    stone:    T(stoneTex(31).canvas),
    cobble:   T(cobbleTex(32).canvas),
    log:      T(logSideTex(41).canvas),
    logTop:   T(logTopTex(42).canvas),
    leaves:   T(leavesTex(51).canvas),
    sand:     T(sandTex(61).canvas),
    plank:    T(plankTex(71).canvas),
    brick:    T(brickTex(81).canvas),
    snow:     T(snowTex(91).canvas),
    water:    T(waterTex(101).canvas),
    bedrock:  T(bedrockTex(111).canvas),
    glowstone:T(glowstoneTex(121).canvas),
    obsidian: T(pal([[30,24,44],[40,32,56],[52,44,68],[24,18,36]], 131, 3).canvas),
    // 粒子 / 贴花（平滑渐变，与像素方块区分开）
    glow:    textureFromImage(gl, makeGlow(128, [255, 240, 200], [255, 120, 30], 2.2).canvas, { wrap: gl.CLAMP_TO_EDGE }),
    fire:    textureFromImage(gl, makeGlow(128, [255, 248, 214], [220, 60, 10], 1.6).canvas, { wrap: gl.CLAMP_TO_EDGE }),
    smoke:   textureFromImage(gl, makeSmoke(128, 7).canvas, { wrap: gl.CLAMP_TO_EDGE }),
    dot:     textureFromImage(gl, makeDot(64).canvas, { wrap: gl.CLAMP_TO_EDGE, mipmap: false }),
    hole:    textureFromImage(gl, makeBulletHole(64, 3).canvas, { wrap: gl.CLAMP_TO_EDGE }),
    blood:   textureFromImage(gl, makeBloodSplat(128, 11).canvas, { wrap: gl.CLAMP_TO_EDGE }),
  };
  return lib;
}

/** 天空贴图按天气缓存：同一种天气只生成一次，避免每次进场景都重画 512² 噪声。 */
export function buildSky(gl, textureFromImage, cache, weather) {
  // 缓存键用天气定义的 key 字段。写成 weather.skyKey 会得到 undefined ——
  // 所有天气共用一个 undefined 键，等于"只有第一张天空图"，之后全是错的。
  const key = weather.key;
  if (!key) throw new Error('buildSky: 天气定义缺少 key 字段');
  if (cache[key]) return cache[key];
  const { canvas } = makeSky(512, weather.skyTop, weather.skyHorizon, weather.skyBottom,
                             weather.cloudiness, hashSeed(key));
  cache[key] = textureFromImage(gl, canvas, { wrap: gl.REPEAT, filter: 'linear' });
  return cache[key];
}

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
