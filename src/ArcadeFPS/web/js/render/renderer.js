// render/renderer.js —— 渲染器。对外只暴露几个高层接口，
// 内部的 draw call 批处理、阴影、后处理都在这里收口。
//
// 性能设计（这是本作帧率的主要抓手）：
//   1. 实例化：同一几何的多个实例合并成一次 draw call。场景里上千个箱子的
//      draw call 从 1000+ 降到 1~3；
//   2. 材质分桶：按贴图分组，切贴图时不切状态；
//   3. 阴影贴图只画参与投影的物体，且分辨率随画质档位缩放；
//   4. 视锥剔除 + 距离剔除在 CPU 侧做，避免顶点着色器空跑；
//   5. 后处理在 1/4 分辨率上做 bloom，锐利部分仍走全分辨率。

import * as G from '../core/gl.js';
import * as S from './shaders.js';
import { m4, v3, clamp } from '../core/math.js';

export const QUALITY = {
  low:    { maxParticles: 900,  fxQuality: 0.4, pixelBudget: 1.2e6 },
  medium: { maxParticles: 2000, fxQuality: 0.7, pixelBudget: 2.6e6 },
  high:   { maxParticles: 3600, fxQuality: 1.0, pixelBudget: 4.5e6 },
};

export class Renderer {
  constructor(canvas, qualityName = 'high') {
    this.canvas = canvas;
    this.gl = G.createContext(canvas);
    this.quality = QUALITY[qualityName] || QUALITY.high;
    this.qualityName = qualityName;
    this.gpu = G.gpuInfo(this.gl);

    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.depthFunc(gl.LEQUAL);

    this.progGeom = G.createProgram(gl, S.GEOM_VS, S.GEOM_FS, 'geom');
    this.progSky = G.createProgram(gl, S.SKY_VS, S.SKY_FS, 'sky');
    this.progParticle = G.createProgram(gl, S.PARTICLE_VS, S.PARTICLE_FS, 'particle');
    this.progDecal = G.createProgram(gl, S.DECAL_VS, S.DECAL_FS, 'decal');
    this.progPost = G.createProgram(gl, S.POST_VS, S.POST_FS, 'post');

    this.quad = G.createFullscreenTri(gl);

    // 实例批：几何 key -> {inst, list}
    this.batches = new Map();
    this.decals = [];
    this.drawCalls = 0;

    this.viewProj = m4.create();
    this.view = m4.create();
    this.proj = m4.create();
    this.invViewProj = m4.create();
    this._tmp = m4.create();

    this.resize(canvas.width, canvas.height, 1);
  }

  resize(w, h, pixelScale) {
    const gl = this.gl;
    const W = Math.max(2, Math.floor(w * pixelScale));
    const H = Math.max(2, Math.floor(h * pixelScale));
    if (W === this.width && H === this.height) return;
    this.width = W; this.height = H;
    this.canvas.width = W;
    this.canvas.height = H;

    if (this.sceneRT) {
      gl.deleteFramebuffer(this.sceneRT.fbo);
      gl.deleteTexture(this.sceneRT.color);
      if (this.sceneRT.depth) gl.deleteRenderbuffer(this.sceneRT.depth);
    }
    this.sceneRT = G.createRenderTarget(gl, W, H, { depth: true, float: false });
  }

  /** 取得（或创建）某个几何的实例批。场景构建时调用一次，渲染时只填数据。 */
  batch(key, geometry, maxInstances) {
    let b = this.batches.get(key);
    if (!b) {
      const mesh = G.createMesh(this.gl, geometry.data, geometry.indices);
      b = { key, inst: G.createInstancedMesh(this.gl, mesh, maxInstances), list: [], texture: null };
      this.batches.set(key, b);
    }
    b.list.length = 0;
    return b;
  }

  clearBatches() { for (const b of this.batches.values()) b.list.length = 0; }
  clearDecals() { this.decals.length = 0; }

  /**
   * 提交一个实例。
   * mat: Float32Array(16)；color: [r,g,b] 0..1；rough: 0..1；
   * emissive: 自发光强度；caster: 是否投影。
   */
  push(key, mat, color, rough = 0.75, emissive = 0, caster = true) {
    const b = this.batches.get(key);
    if (!b) return;
    if (b.list.length >= b.inst.max * 7) return;   // 防止无脑灌爆缓冲
    b.list.push({ mat, color, rough, emissive, caster });
  }

  addDecal(kind, pos, right, up, size, color) {
    this.decals.push({ kind, pos, right, up, size, color });
  }

  /** 设置相机与环境。所有 uniform 的权威来源，渲染中途不再改动。 */
  setCamera(eye, target, up, fovY, aspect, near = 0.05, far = 400) {
    m4.perspective(this.proj, fovY, aspect, near, far);
    m4.lookAt(this.view, eye, target, up);
    m4.multiply(this.viewProj, this.proj, this.view);
    m4.invert(this.invViewProj, this.viewProj);
    this.cameraPos = eye;
  }

  /**
   * 环境参数。Minecraft 风格无太阳方向光、无阴影，只剩雾。
   * @param fogColor 雾色（0..1）
   * @param fogFalloff 雾衰减系数 = 1/可视距离(m)。越大雾越浓。
   */
  setSun(dir, color, ambientSky, ambientGround, fogColor, fogFalloff) {
    this.sun = { fogColor, fogFalloff };
  }

  setSkyTexture(tex) { this.skyTex = tex; }

  render(time, post) {
    const gl = this.gl;
    this.drawCalls = 0;

    /* ---- 主场景（无阴影 pass，体素风的面光照直接在几何里算） ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneRT.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(this.sun.fogColor[0], this.sun.fogColor[1], this.sun.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 天空（先画，靠深度=1 永远在最远处）
    if (this.skyTex) {
      gl.useProgram(this.progSky.program);
      gl.depthMask(false);
      gl.uniformMatrix4fv(this.progSky.uniforms.uInvViewProj, false, this.invViewProj);
      gl.uniform3fv(this.progSky.uniforms.uCameraPos, this.cameraPos);
      gl.uniform3fv(this.progSky.uniforms.uFogColor, this.sun.fogColor);
      gl.uniform1f(this.progSky.uniforms.uTime, time);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
      gl.uniform1i(this.progSky.uniforms.uSky, 0);
      gl.bindVertexArray(this.quad.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
      this.drawCalls++;
    }

    // 几何（实例化，按批次一次 draw）
    const pg = this.progGeom;
    gl.useProgram(pg.program);
    gl.uniformMatrix4fv(pg.uniforms.uViewProj, false, this.viewProj);
    gl.uniform3fv(pg.uniforms.uCameraPos, this.cameraPos);
    gl.uniform3fv(pg.uniforms.uFogColor, this.sun.fogColor);
    gl.uniform1f(pg.uniforms.uFogFalloff, this.sun.fogFalloff);

    for (const b of this.batches.values()) {
      if (!b.list.length) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.texture);
      let n = 0;
      const data = b.inst.instData;
      for (const item of b.list) {
        if (n >= b.inst.max) break;   // 防止 list 超容量时 data.set 越界抛 RangeError
        data.set(item.mat, n * G.INSTANCE_FLOATS);
        data[n * G.INSTANCE_FLOATS + 16] = item.color[0];
        data[n * G.INSTANCE_FLOATS + 17] = item.color[1];
        data[n * G.INSTANCE_FLOATS + 18] = item.color[2];
        data[n * G.INSTANCE_FLOATS + 19] = item.emissive ?? 0;   // 复用原 rough 通道为自发光
        data[n * G.INSTANCE_FLOATS + 20] = 0; data[n * G.INSTANCE_FLOATS + 21] = 0; data[n * G.INSTANCE_FLOATS + 22] = 0;
        n++;
      }
      G.flushInstanced(gl, b.inst, n);
      this.drawCalls++;
    }

    this.renderParticles(time);
    this.renderDecals();

    /* ---- 后处理 ---- */
    this.renderPost(time, post);
  }

  /* 粒子与贴花的 GPU 缓冲在 initOverlays 中一次性建立，每帧只更新数据。 */

  /**
   * 一次性建立贴花与粒子的 VAO/VBO。之后每帧只做 bufferSubData，
   * 不重建任何 GL 对象 —— 这是"跑得动"和"重建导致周期性卡顿"的分界线。
   */
  initOverlays(decalTextures) {
    const gl = this.gl;
    this.decalTextures = decalTextures || {};

    this.decalMax = 512;
    this.decalData = new Float32Array(this.decalMax * 13);
    this.decalVAO = gl.createVertexArray();
    gl.bindVertexArray(this.decalVAO);
    this.decalBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.decalBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.decalData.byteLength, gl.DYNAMIC_DRAW);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-0.5,-0.5, 0.5,-0.5, 0.5,0.5, -0.5,0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    const S = 13 * 4;
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 3, gl.FLOAT, false, S, i * 12);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, S, 36);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);

    this.particleMax = this.quality.maxParticles;
    this.particleData = new Float32Array(this.particleMax * 12);
    this.particleVAO = gl.createVertexArray();
    gl.bindVertexArray(this.particleVAO);

    const pquad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pquad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-0.5,-0.5, 0.5,-0.5, 0.5,0.5, -0.5,0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    this.particleBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.particleData.byteLength, gl.DYNAMIC_DRAW);
    const PS = 12 * 4;
    for (const [loc, size, off] of [[1,3,8], [2,4,20], [3,3,36]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, PS, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    this.particleCount = 0;
  }

  /** 上传本帧粒子。list 中每项 {pos, color, alpha, size, rot}。 */
  uploadParticles(list) {
    const gl = this.gl;
    const n = Math.min(list.length, this.particleMax);
    const d = this.particleData;
    for (let i = 0; i < n; i++) {
      const p = list[i], o = i * 12;
      d[o] = p.pos[0]; d[o + 1] = p.pos[1]; d[o + 2] = p.pos[2];
      d[o + 3] = p.color[0]; d[o + 4] = p.color[1]; d[o + 5] = p.color[2];
      d[o + 6] = p.alpha;
      d[o + 7] = p.size; d[o + 8] = p.rot || 0; d[o + 9] = 0;
    }
    this.particleCount = n;
    if (n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 12);
    }
  }

  bindParticleProgram(additive) {
    const gl = this.gl;
    gl.useProgram(this.progParticle.program);
    gl.uniformMatrix4fv(this.progParticle.uniforms.uViewProj, false, this.viewProj);
    // 相机右向量与上向量：从 view 矩阵的行直接取，避免每帧重算 lookAt
    gl.uniform3f(this.progParticle.uniforms.uRight, this.view[0], this.view[4], this.view[8]);
    gl.uniform3f(this.progParticle.uniforms.uUp, this.view[1], this.view[5], this.view[9]);
    gl.uniform1f(this.progParticle.uniforms.uAdditive, additive ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.progParticle.uniforms.uTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
  }

  bindDecalProgram() {
    const gl = this.gl;
    gl.useProgram(this.progDecal.program);
    gl.uniformMatrix4fv(this.progDecal.uniforms.uViewProj, false, this.viewProj);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.progDecal.uniforms.uTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
  }

  endOverlayPass() {
    const gl = this.gl;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /**
   * 粒子绘制。调用方需先调 bindParticleProgram 并绑定纹理。
   * 粒子数据打包在一个交错的 VBO 里，用 divisor 区分"每顶点"与"每粒子"，
   * 整个粒子系统只有一次 drawArraysInstanced。
   */
  renderParticles(time) {
    if (!this.particleVAO || !this.particleCount) return;
    const gl = this.gl;
    gl.bindVertexArray(this.particleVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.particleCount);
    this.drawCalls++;
    this.endOverlayPass();
  }

  /** 贴花缓冲：每贴花 = world(3) + right(3) + up(3) + color(4) = 13 floats。 */
  uploadDecals(list) {
    const gl = this.gl;
    const data = this.decalData;
    const n = Math.min(list.length, this.decalMax);
    for (let i = 0; i < n; i++) {
      const d = list[i];
      const o = i * 13;
      data[o] = d.pos[0]; data[o + 1] = d.pos[1]; data[o + 2] = d.pos[2];
      data[o + 3] = d.right[0] * d.size; data[o + 4] = d.right[1] * d.size; data[o + 5] = d.right[2] * d.size;
      data[o + 6] = d.up[0] * d.size; data[o + 7] = d.up[1] * d.size; data[o + 8] = d.up[2] * d.size;
      data[o + 9] = d.color[0]; data[o + 10] = d.color[1]; data[o + 11] = d.color[2];
      data[o + 12] = d.alpha ?? 1;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.decalBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 13);
    return n;
  }

  renderDecals() {
    if (!this.decals.length || !this.decalVAO) return;
    const gl = this.gl;
    this.bindDecalProgram();
    for (const kind of Object.keys(this.decalTextures || {})) {
      const list = this.decals.filter(d => d.kind === kind);
      if (!list.length) continue;
      const n = this.uploadDecals(list);
      gl.bindTexture(gl.TEXTURE_2D, this.decalTextures[kind]);
      gl.bindVertexArray(this.decalVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      this.drawCalls++;
    }
    this.endOverlayPass();
  }

  renderPost(time, post) {
    const gl = this.gl;
    const p = post || {};

    // 体素风后处理极简：直接合成到默认帧缓冲，只保留白闪/饱和/受伤红闪。
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progPost.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.color);
    gl.uniform1i(this.progPost.uniforms.uScene, 0);
    gl.uniform1f(this.progPost.uniforms.uDamage, p.damage ?? 0);
    gl.uniform1f(this.progPost.uniforms.uFlash, p.flash ?? 0);
    gl.uniform1f(this.progPost.uniforms.uSaturation, p.saturation ?? 1.25);
    gl.bindVertexArray(this.quad.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    this.drawCalls++;
  }
}
