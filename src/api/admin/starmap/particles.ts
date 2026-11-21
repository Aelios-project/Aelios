export const STARMAP_PARTICLES_SCRIPT = String.raw`// Water sits in centre-weighted lanes and the mid-channel runs faster than the banks;
// a share of particles is mist that lifts off the surface and fades, like spray off a shore.
var flowMaterials = [];
var CURVE_SAMPLES = 256;

function bakeCurve(curve) {
  var pos = new Float32Array(CURVE_SAMPLES * 3);
  var tan = new Float32Array(CURVE_SAMPLES * 3);
  for (var i = 0; i < CURVE_SAMPLES; i++) {
    var t = i / (CURVE_SAMPLES - 1);
    var p = curve.getPointAt(t);
    var g = curve.getTangentAt(t);
    if (g.lengthSq() < 1e-8) g.set(0, 0, 1); else g.normalize();
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    tan[i * 3] = g.x; tan[i * 3 + 1] = g.y; tan[i * 3 + 2] = g.z;
  }
  return { pos: pos, tan: tan };
}

function curveTexture(arr) {
  var n = CURVE_SAMPLES;
  var rgba = new Float32Array(n * 4);
  for (var i = 0; i < n; i++) {
    rgba[i * 4] = arr[i * 3];
    rgba[i * 4 + 1] = arr[i * 3 + 1];
    rgba[i * 4 + 2] = arr[i * 3 + 2];
    rgba[i * 4 + 3] = 0;
  }
  var tex = new THREE.DataTexture(rgba, n, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

var flowVertexShader = [
  'attribute vec4 aSeed;', // t0, speed, lane (-1..1, centre-weighted), sizeFactor
  'attribute float aTint;',
  'attribute float aAng;',
  'attribute float aSpray;', // 0 water, 1 mist
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uSize;',
  'uniform float uOpacity;',
  'uniform float uMixToMid;',
  'uniform float uEndFade;',
  'uniform float uWidth;',
  'uniform vec2 uWidthAt;', // width multiplier at the start and end of the curve
  'uniform vec2 uFade;', // fade-in and fade-out lengths, as fractions of the curve
  'uniform float uLen;',
  'uniform vec3 uColorA;',
  'uniform vec3 uColorB;',
  'uniform sampler2D uCurvePos;',
  'uniform sampler2D uCurveTan;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'vec3 bakeSample(sampler2D tex, float t) {',
  '  float ft = t * ' + (CURVE_SAMPLES - 1).toFixed(1) + ';',
  '  float i0 = floor(ft);',
  '  float i1 = min(i0 + 1.0, ' + (CURVE_SAMPLES - 1).toFixed(1) + ');',
  '  vec3 s0 = texture2D(tex, vec2((i0 + 0.5) / ' + CURVE_SAMPLES.toFixed(1) + ', 0.5)).xyz;',
  '  vec3 s1 = texture2D(tex, vec2((i1 + 0.5) / ' + CURVE_SAMPLES.toFixed(1) + ', 0.5)).xyz;',
  '  return mix(s0, s1, fract(ft));',
  '}',
  'void main() {',
  '  float lane = aSeed.z;',
  '  float pace = aSeed.y * (1.3 - 0.75 * lane * lane);',
  '  float t = fract(aSeed.x + uTime * pace);',
  '  vec3 bp = bakeSample(uCurvePos, t);',
  '  vec3 bt = bakeSample(uCurveTan, t);',
  '  vec3 side = cross(bt, vec3(0.0, 1.0, 0.0));',
  '  if (dot(side, side) < 1e-6) side = vec3(1.0, 0.0, 0.0);',
  '  else side = normalize(side);',
  '  vec3 up = normalize(cross(side, bt));',
  '  float drift = sin(uTime * 0.9 + aAng * 5.0) * 0.1;',
  '  float wid = uWidth * mix(uWidthAt.x, uWidthAt.y, t);',
  '  vec3 pos = bp + side * (lane + drift) * wid + up * (sin(aAng + t * 18.0) * 0.18 - 0.22);',
  '  float lift = 0.0;',
  '  if (aSpray > 0.5) {',
  '    lift = fract(aAng * 0.159 + uTime * 0.05);',
  '    pos += up * (0.15 + lift * 2.6) + side * lane * wid * 0.7 * lift;',
  '  }',
  // two lineages start pure, then blend toward each other downstream
  '  float mixT = mix(aTint, 0.5, uMixToMid * smoothstep(0.10, 0.75, t));',
  '  vColor = mix(uColorA, uColorB, mixT);',
  '  float head = smoothstep(0.0, uFade.x, t) * (1.0 - smoothstep(1.0 - uFade.y, 1.0, t));',
  // brighten as the ribbon swells pass (same wave as the ribbon shader)
  '  float swell = pow(0.5 + 0.5 * sin(t * uLen * 0.21 - uTime * 1.05), 4.0);',
  '  float sparkle = 0.55 + 0.45 * sin(uTime * (1.6 + aTint * 2.6) + aAng * 7.0);',
  '  float mist = aSpray > 0.5 ? (1.0 - lift) * smoothstep(0.0, 0.15, lift) * 0.5 : 1.0;',
  '  vAlpha = uOpacity * head * (1.0 - uEndFade * t * 0.6) * sparkle * (0.55 + 0.75 * swell) * mist;',
  '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
  '  gl_PointSize = uSize * aSeed.w * (1.0 + aSpray * 0.4) * uPixelRatio * (180.0 / -mv.z);',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var flowFragmentShader = [
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'void main() {',
  '  float d = length(gl_PointCoord - vec2(0.5));',
  '  if (d > 0.5) discard;',
  '  float a = exp(-d * 5.0) * vAlpha;',
  '  gl_FragColor = vec4(vColor, a);',
  '}'
].join('\n');

function makeFlowParticles(curve, opts) {
  var count = Math.min(opts.count, MAX_PARTICLES);
  var baked = bakeCurve(curve);
  var rnd = mulberry32(hashStr('flow2-' + opts.seed));
  var pos = new Float32Array(count * 3); // dummy; real positions are shader-side
  var seed = new Float32Array(count * 4);
  var tint = new Float32Array(count);
  var ang = new Float32Array(count);
  var spray = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    seed[i * 4] = rnd();
    seed[i * 4 + 1] = opts.speed * (0.75 + rnd() * 0.5);
    seed[i * 4 + 2] = (rnd() + rnd() + rnd()) / 1.5 - 1; // centre-weighted lane
    seed[i * 4 + 3] = 0.6 + rnd() * 0.9;
    tint[i] = rnd();
    ang[i] = rnd() * Math.PI * 2;
    spray[i] = rnd() < 0.16 ? 1 : 0;
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  geo.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
  geo.setAttribute('aSpray', new THREE.BufferAttribute(spray, 1));
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uSize: { value: opts.size },
      uOpacity: { value: opts.opacity },
      uMixToMid: { value: opts.mixToMid ? 1 : 0 },
      uEndFade: { value: opts.endFade ? 1 : 0 },
      uWidth: { value: opts.width },
      uWidthAt: { value: new THREE.Vector2(opts.widthFrom == null ? 1 : opts.widthFrom, opts.widthTo == null ? 1 : opts.widthTo) },
      uFade: { value: new THREE.Vector2(opts.fadeIn == null ? 0.05 : opts.fadeIn, opts.fadeOut == null ? 0.07 : opts.fadeOut) },
      uLen: { value: curve.getLength() },
      uColorA: { value: new THREE.Color(opts.colorA) },
      uColorB: { value: new THREE.Color(opts.colorB) },
      uCurvePos: { value: curveTexture(baked.pos) },
      uCurveTan: { value: curveTexture(baked.tan) }
    },
    vertexShader: flowVertexShader,
    fragmentShader: flowFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  var pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false; // positions are zero CPU-side; culling would hide the river
  scene.add(pts);
  flowMaterials.push(mat);
}

// night water: mid-channel crosses each stretch in roughly half a minute; where one stretch
// hands over to the next the fades are short so the water runs on without a gap.
// Lane width follows the ribbon's width profile.
makeFlowParticles(curves.han, { count: 460, colorA: 0x7cb3e8, colorB: 0xe9eef8, speed: 0.03, size: 0.48, opacity: 0.62, width: 1.2, widthFrom: 0.4, fadeOut: 0.015, seed: 'han' });
makeFlowParticles(curves.yang, { count: 720, colorA: 0xf0c062, colorB: 0xf0977f, speed: 0.026, size: 0.56, opacity: 0.6, width: 2.7, widthFrom: 0.35, fadeOut: 0.015, seed: 'yang' });
makeFlowParticles(curves.merge, { count: 340, colorA: 0x7cb3e8, colorB: 0xbcd0ee, speed: 0.04, size: 0.5, opacity: 0.66, width: 1.2, widthTo: 0.35, fadeIn: 0.015, fadeOut: 0.25, seed: 'merge' });
makeFlowParticles(curves.down, { count: 680, colorA: 0x9fb6d8, colorB: 0xf0c890, speed: 0.024, size: 0.52, opacity: 0.52, width: 2.9, widthTo: 1.45, mixToMid: true, endFade: true, fadeIn: 0.015, seed: 'down' });
// flow 2200 + dust 760 = 2960, within the 3000 particle budget

// edges as lines
var edgesGroup = new THREE.Group();
scene.add(edgesGroup);
var edgeObjects = [];
var EDGE_SEGMENTS = 24;

// motion: stars sway with the water (uSway), the water runs on its own clock so
// prefers-reduced-motion can slow it without freezing the page
var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var swayAmount = reduceMotion ? 0 : 1;
var flowRate = reduceMotion ? 0.3 : 1;
var flowClock = 0;
starMaterial.uniforms.uSway.value = swayAmount;
haloMaterial.uniforms.uSway.value = swayAmount;

// same displacement as the star vertex shader
function starSway(node, tSec, out) {
  var s1 = Math.sin(tSec * 0.42 + node._phase * 1.7) * swayAmount;
  var s2 = Math.sin(tSec * 0.55 + node._phase * 3.1) * swayAmount;
  return out.set(node._flow.x * s1, node._flow.y * s1 + node._bob * s2, node._flow.z * s1);
}

var _swA = new THREE.Vector3();
var _swB = new THREE.Vector3();
var _swP = new THREE.Vector3();
var _swQ = new THREE.Vector3();
var _swM = new THREE.Vector3();
function updateEdgeSway(tSec) {
  if (!swayAmount) return;
  for (var i = 0; i < edgeObjects.length; i++) {
    var eo = edgeObjects[i];
    starSway(eo.a, tSec, _swA);
    starSway(eo.b, tSec, _swB);
    _swP.copy(eo.a._pos).add(_swA);
    _swQ.copy(eo.b._pos).add(_swB);
    _swM.copy(eo.mid).addScaledVector(_swA, 0.5).addScaledVector(_swB, 0.5);
    var attr = eo.line.geometry.getAttribute('position');
    for (var k = 0; k <= EDGE_SEGMENTS; k++) {
      var t = k / EDGE_SEGMENTS;
      var u = 1 - t;
      attr.setXYZ(
        k,
        u * u * _swP.x + 2 * u * t * _swM.x + t * t * _swQ.x,
        u * u * _swP.y + 2 * u * t * _swM.y + t * t * _swQ.y,
        u * u * _swP.z + 2 * u * t * _swM.z + t * t * _swQ.z
      );
    }
    attr.needsUpdate = true;
    if (eo.dashed) eo.line.computeLineDistances();
  }
}

// ── layout stars along rivers ─────────────────────────────────`;
