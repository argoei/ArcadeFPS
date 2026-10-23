// core/gl.js —— WebGL2 薄封装。只做四件事：编译着色器、上传网格、管纹理、算 FBO。
// 不引入任何三方库，避免离线运行时的资源加载不确定性。

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,          // 自己做后期，MSAA 的开销不值
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    desynchronized: true,      // 降低呈现延迟
  });
  if (!gl) throw new Error('WebGL2 不可用：GPU 加速被禁用或显卡驱动不支持');
  return gl;
}

/** 返回渲染器名字，用于日志确认"是否真的走了 GPU"。 */
export function gpuInfo(gl) {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  // 软件渲染器特征串（Chromium 无 GPU 时的回退实现）：据此判定是否真走硬件加速
  const software = /swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(renderer);
  return {
    vendor,
    renderer,
    version: gl.getParameter(gl.VERSION),
    hardware: !software,   // true = GPU 硬件加速；false = 软件渲染回退
  };
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`[${label}] 着色器编译失败:\n${log}\n---\n${src}`);
  }
  return sh;
}

export function createProgram(gl, vsSrc, fsSrc, label = 'prog') {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + '.vs');
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + '.fs');
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`[${label}] 程序链接失败:\n${log}`);
  }

  // 缓存 uniform 位置：每帧 getUniformLocation 是明确的性能陷阱
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, uniforms, label };
}

/**
 * 上传一个网格到 VAO。attribs 描述顶点布局：
 *   [{loc, size, offsetFloats}]，offsetFloats 相对 stride（以 float 计）。
 * 用法上，所有几何共用同一个"位置+法线+uv"布局，这样实例化绘制时
 * 顶点属性可以复用同一套 VAO，只换 instance buffer。
 */
export function createMesh(gl, data, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const STRIDE = 8;   // pos3 + nrm3 + uv2
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE * 4, 24);

  let ibo = null, count = 0, type = gl.UNSIGNED_SHORT;
  if (indices) {
    ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const arr = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    count = arr.length;
    type = gl.UNSIGNED_INT;
  } else {
    count = data.length / STRIDE;
  }

  gl.bindVertexArray(null);
  return { vao, vbo, ibo, count, indexed: !!indices, type, stride: STRIDE };
}

export function drawMesh(gl, mesh) {
  gl.bindVertexArray(mesh.vao);
  if (mesh.indexed) gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
  else gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
}

/**
 * 实例化缓冲：每个实例一条记录。
 * 数据布局（floats）：mat4(16) + color(3) + params(4) = 23 floats。
 * 同一批几何的所有实例共享一个 VAO，绘制时只切换 instance 数据 —— 这是
 * 场景里"几千个箱子只花一个 draw call"的关键。
 */
export const INSTANCE_FLOATS = 23;

export function createInstancedMesh(gl, mesh, maxInstances) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // 复用原网格的顶点缓冲
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, mesh.stride * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, mesh.stride * 4, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, mesh.stride * 4, 24);

  const instData = new Float32Array(maxInstances * INSTANCE_FLOATS);
  const ibuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
  gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW);

  const S = INSTANCE_FLOATS * 4;
  for (let i = 0; i < 4; i++) {
    const loc = 3 + i;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, S, i * 16);
    gl.vertexAttribDivisor(loc, 1);
  }
  // color(rgb) + params(rgb emissive, a roughness)
  gl.enableVertexAttribArray(7);
  gl.vertexAttribPointer(7, 4, gl.FLOAT, false, S, 64);
  gl.vertexAttribDivisor(7, 1);

  if (mesh.ibo) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
  }

  gl.bindVertexArray(null);
  return { vao, ibuf, instData, max: maxInstances, count: 0, indexed: mesh.indexed,
           meshCount: mesh.count, type: mesh.type };
}

/** 上传本帧实例并绘制。返回实际绘制的实例数。 */
export function flushInstanced(gl, inst, count) {
  if (count <= 0) return 0;
  const n = Math.min(count, inst.max);
  gl.bindBuffer(gl.ARRAY_BUFFER, inst.ibuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst.instData, 0, n * INSTANCE_FLOATS);
  gl.bindVertexArray(inst.vao);
  if (inst.indexed) gl.drawElementsInstanced(gl.TRIANGLES, inst.meshCount, inst.type, 0, n);
  else gl.drawArraysInstanced(gl.TRIANGLES, 0, inst.meshCount, n);
  return n;
}

/* ------------------------------------------------------------ 纹理 */

export function createTexture(gl, opts = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const {
    width = 1, height = 1, internalFormat = gl.RGBA8, format = gl.RGBA,
    type = gl.UNSIGNED_BYTE, data = null,
    min = gl.LINEAR_MIPMAP_LINEAR, mag = gl.LINEAR,
    wrap = gl.REPEAT, mipmap = true,
  } = opts;

  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}

/** 从 ImageData/Canvas 上传贴图。默认 NEAREST（Minecraft 像素风，放大不插值），
 *  天空这类渐变贴图传 filter='linear'。 */
export function textureFromImage(gl, source, { wrap, mipmap = true, filter = 'nearest' } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const mag = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  const min = filter === 'linear'
    ? (mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    : (mipmap ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap ?? gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap ?? gl.REPEAT);
  if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}

/* ------------------------------------------------------------ 帧缓冲 */

/** 颜色 + 深度 的离屏目标。阴影贴图与后处理都用它。 */
export function createRenderTarget(gl, w, h, { depth = true, float = false, filter = null } = {}) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

  const color = createTexture(gl, {
    width: w, height: h,
    internalFormat: float ? gl.RGBA16F : gl.RGBA8,
    format: gl.RGBA,
    type: float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    min: filter ?? gl.LINEAR, mag: filter ?? gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE, mipmap: false,
  });
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);

  let depthTex = null;
  if (depth) {
    depthTex = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthTex);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthTex);
  }

  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('帧缓冲不完整: 0x' + st.toString(16));
  }
  return { fbo, color, depth: depthTex, width: w, height: h };
}

/** 纯深度目标（阴影贴图）。 */
export function createDepthTarget(gl, size) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D,0, gl.DEPTH_COMPONENT24, size, size, 0,
                gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // 硬件 PCF：比较采样器一次取 4 个深度值，比软件 3x3 便宜得多
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('阴影 FBO 不完整: 0x' + st.toString(16));
  return { fbo, tex, size };
}

/** 屏幕三角形（比全屏四边形少一次光栅化接缝）。 */
export function createFullscreenTri(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, vbo };
}
