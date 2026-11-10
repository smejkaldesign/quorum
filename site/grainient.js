// Animated gradient behind the hero and the footer: a WebGL2 fragment shader that blends three blues through
// noise-warped coordinates and adds film grain (the same shader Benefind's landing page runs, in Quorum colors).
// Each `.glow` keeps its CSS gradient underneath, so a browser without WebGL2 still shows a gradient.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const VERT = `#version 300 es
in vec2 position;
void main(){gl_Position=vec4(position,0.0,1.0);}`;

  const FRAG = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uTimeSpeed, uColorBalance, uWarpStrength, uWarpFrequency, uWarpSpeed, uWarpAmplitude;
uniform float uBlendAngle, uBlendSoftness, uRotationAmount, uNoiseScale, uGrainAmount, uGrainScale;
uniform float uContrast, uGamma, uSaturation, uZoom;
uniform vec2 uCenterOffset;
uniform vec3 uColor1, uColor2, uColor3;
out vec4 fragColor;
#define S(a,b,t) smoothstep(a,b,t)
mat2 Rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
vec2 hash(vec2 p){p=vec2(dot(p,vec2(2127.1,81.17)),dot(p,vec2(1269.5,283.37)));return fract(sin(p)*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);float n=mix(mix(dot(-1.0+2.0*hash(i+vec2(0.0,0.0)),f-vec2(0.0,0.0)),dot(-1.0+2.0*hash(i+vec2(1.0,0.0)),f-vec2(1.0,0.0)),u.x),mix(dot(-1.0+2.0*hash(i+vec2(0.0,1.0)),f-vec2(0.0,1.0)),dot(-1.0+2.0*hash(i+vec2(1.0,1.0)),f-vec2(1.0,1.0)),u.x),u.y);return 0.5+0.5*n;}
void main(){
  float t=iTime*uTimeSpeed;
  vec2 uv=gl_FragCoord.xy/iResolution.xy;
  float ratio=iResolution.x/iResolution.y;
  vec2 tuv=uv-0.5+uCenterOffset;
  tuv/=max(uZoom,0.001);
  float degree=noise(vec2(t*0.1,tuv.x*tuv.y)*uNoiseScale);
  tuv.y*=1.0/ratio;
  tuv*=Rot(radians((degree-0.5)*uRotationAmount+180.0));
  tuv.y*=ratio;
  float ws=max(uWarpStrength,0.001);
  float amplitude=uWarpAmplitude/ws;
  float warpTime=t*uWarpSpeed;
  tuv.x+=sin(tuv.y*uWarpFrequency+warpTime)/amplitude;
  tuv.y+=sin(tuv.x*(uWarpFrequency*1.5)+warpTime)/(amplitude*0.5);
  float b=uColorBalance;
  float s=max(uBlendSoftness,0.0);
  float blendX=(tuv*Rot(radians(uBlendAngle))).x;
  float edge0=-0.3-b-s, edge1=0.2-b+s, v0=0.5-b+s, v1=-0.3-b-s;
  vec3 layer1=mix(uColor3,uColor2,S(edge0,edge1,blendX));
  vec3 layer2=mix(uColor2,uColor1,S(edge0,edge1,blendX));
  vec3 col=mix(layer1,layer2,S(v0,v1,tuv.y));
  vec2 grainUv=uv*max(uGrainScale,0.001);
  float grain=fract(sin(dot(grainUv,vec2(12.9898,78.233)))*43758.5453);
  col+=(grain-0.5)*uGrainAmount;
  col=(col-0.5)*uContrast+0.5;
  float luma=dot(col,vec3(0.2126,0.7152,0.0722));
  col=mix(vec3(luma),col,uSaturation);
  col=pow(max(col,0.0),vec3(1.0/max(uGamma,0.001)));
  fragColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

  function mount(el) {
    const canvas = document.createElement('canvas');
    canvas.className = 'glow-canvas';
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power' });
    if (!gl) return;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const u = (n) => gl.getUniformLocation(prog, n);
    const d = el.dataset;
    const f = (name, key, dflt) => gl.uniform1f(u(name), d[key] !== undefined ? +d[key] : dflt);
    f('uTimeSpeed', 'speed', 0.45);
    f('uColorBalance', 'balance', 0.15);
    f('uWarpStrength', 'warp', 1.0);
    f('uWarpFrequency', 'warpFrequency', 5.0);
    f('uWarpSpeed', 'warpSpeed', 2.0);
    f('uWarpAmplitude', 'warpAmplitude', 50.0);
    f('uBlendAngle', 'blendAngle', 0.0);
    f('uBlendSoftness', 'softness', 0.05);
    f('uRotationAmount', 'rotation', 120.0);
    f('uNoiseScale', 'noise', 2.0);
    f('uGrainAmount', 'grain', 0.1);
    f('uGrainScale', 'grainScale', 2.0);
    f('uContrast', 'contrast', 1.5);
    f('uGamma', 'gamma', 1.0);
    f('uSaturation', 'saturation', 1.0);
    f('uZoom', 'zoom', 0.9);
    gl.uniform2f(u('uCenterOffset'), +(d.centerX ?? 0), +(d.centerY ?? -0.25));
    gl.uniform3fv(u('uColor1'), hex(d.c1 ?? '#8ec5ff'));
    gl.uniform3fv(u('uColor2'), hex(d.c2 ?? '#0a62e8'));
    gl.uniform3fv(u('uColor3'), hex(d.c3 ?? '#0b2a4d'));

    const iRes = u('iResolution'), iTime = u('iTime');
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const size = () => {
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width * dpr)), h = Math.max(1, Math.floor(r.height * dpr));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(iRes, w, h);
    };
    el.appendChild(canvas);
    const shade = document.createElement('div');
    shade.className = 'glow-shade';
    el.appendChild(shade);
    size();
    new ResizeObserver(() => { size(); if (reduce) draw(performance.now()); }).observe(el);

    // one frame when motion is reduced; otherwise a loop that only runs while the element is on screen
    const t0 = performance.now();
    let raf = 0, onScreen = true;
    const draw = (t) => {
      gl.uniform1f(iTime, (t - t0) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduce && onScreen) raf = requestAnimationFrame(draw);
    };
    new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      cancelAnimationFrame(raf);
      if (onScreen) raf = requestAnimationFrame(draw);
    }).observe(el);
    raf = requestAnimationFrame(draw);
  }

  document.querySelectorAll('.glow:not(.glow-dark)').forEach(mount);
})();
