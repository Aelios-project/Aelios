export const STARMAP_STARS_SCRIPT = `function offsetOnCurve(curve, t, id, radiusScale) {
  var rnd = mulberry32(hashStr(id + ':pos'));
  var p = curve.getPointAt(clamp(t, 0, 1));
  var tangent = curve.getTangentAt(clamp(t, 0, 1));
  if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, 1);
  else tangent.normalize();
  var side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
  else side.normalize();
  var up = new THREE.Vector3().crossVectors(side, tangent).normalize();
  var r = (0.35 + rnd() * 1.6) * (radiusScale || 1);
  var ang = rnd() * Math.PI * 2;
  p.addScaledVector(side, Math.cos(ang) * r);
  p.addScaledVector(up, Math.sin(ang) * r * 0.55);
  p.y += (rnd() - 0.35) * 0.8;
  return p;
}

function layoutStars(rawNodes) {
  var now = Date.now();
  var pinned = [];
  var hanOld = [];
  var yangOld = [];
  var recent = [];

  for (var i = 0; i < rawNodes.length; i++) {
    var n = rawNodes[i];
    if (n.pinned) {
      pinned.push(n);
      continue;
    }
    var created = Date.parse(n.created_at);
    if (!Number.isFinite(created)) created = now;
    var isRecent = (now - created) <= RECENT_MS;
    if (isRecent) {
      recent.push(n);
    } else if (isYangType(n.type)) {
      yangOld.push(n);
    } else {
      hanOld.push(n);
    }
  }

  function byTimeAsc(a, b) {
    var ta = Date.parse(a.created_at) || 0;
    var tb = Date.parse(b.created_at) || 0;
    return ta - tb;
  }
  hanOld.sort(byTimeAsc);
  yangOld.sort(byTimeAsc);
  recent.sort(byTimeAsc);
  pinned.sort(function (a, b) {
    return (Number(b.importance) || 0) - (Number(a.importance) || 0);
  });

  var laid = [];

  function placeRiver(list, curve, t0, t1) {
    var n = list.length;
    for (var i = 0; i < n; i++) {
      var node = list[i];
      var t = n === 1 ? (t0 + t1) / 2 : t0 + (t1 - t0) * (i / (n - 1));
      // slight sinusoidal wander along parameter for organic feel
      var wobble = Math.sin(hashStr(node.id) * 0.0001 + i * 0.7) * 0.012;
      t = clamp(t + wobble, 0.02, 0.98);
      var pos = offsetOnCurve(curve, t, node.id, 1);
      var flow = curve.getTangentAt(t);
      if (flow.lengthSq() < 1e-8) flow.set(0, 0, 1); else flow.normalize();
      flow.multiplyScalar(0.3 * (0.75 + mulberry32(hashStr(node.id + ':sway'))() * 0.5));
      laid.push(Object.assign({}, node, {
        _pos: pos,
        _flow: flow,
        _bob: 0.07,
        _river: riverOf(node.type),
        _easter: false,
        _special: false
      }));
    }
  }

  // older memories: source(t~0) → confluence(t~1)
  placeRiver(hanOld, curves.han, 0.04, 0.92);
  placeRiver(yangOld, curves.yang, 0.04, 0.92);
  // recent 30d mixed on merge segment, still time-ordered toward downstream
  placeRiver(recent, curves.merge, 0.05, 0.95);

  // city lights above confluence
  var cityRnd = mulberry32(0xC17A);
  for (var p = 0; p < pinned.length; p++) {
    var pn = pinned[p];
    var ang = (p / Math.max(pinned.length, 1)) * Math.PI * 2 + cityRnd() * 0.4;
    var rad = 1.2 + (p % 5) * 0.55 + cityRnd() * 0.4;
    var pos = new THREE.Vector3(
      Math.cos(ang) * rad,
      3.2 + (p % 4) * 0.55 + cityRnd() * 0.8,
      Math.sin(ang) * rad * 0.7
    );
    laid.push(Object.assign({}, pn, {
      _pos: pos,
      _bob: 0.16,
      _river: 'city',
      _easter: false,
      _special: false
    }));
  }

  // easter eggs: 旦九 at 汉江 source (长江色), 咲咲 at 长江 source (汉江色)
  var danjiuPos = offsetOnCurve(curves.han, 0.02, 'easter:danjiu', 0.5);
  danjiuPos.y += 1.2;
  laid.push({
    id: '__easter_danjiu__',
    label: '旦九',
    type: 'relationship',
    importance: 0.95,
    pinned: false,
    version_status: null,
    created_at: '',
    _pos: danjiuPos,
    _river: 'han',
    _easter: true,
    _special: true,
    _forceColor: YANG_COLORS.relationship.clone()
  });
  var sakuraPos = offsetOnCurve(curves.yang, 0.02, 'easter:sakura', 0.5);
  sakuraPos.y += 1.2;
  laid.push({
    id: '__easter_sakura__',
    label: '咲咲',
    type: 'preference',
    importance: 0.95,
    pinned: false,
    version_status: null,
    created_at: '',
    _pos: sakuraPos,
    _river: 'yang',
    _easter: true,
    _special: true,
    _forceColor: HAN_COLORS.preference.clone()
  });

  return laid;
}

function rebuildStars(laid) {
  if (starsPoints) {
    starsGroup.remove(starsPoints);
    starsPoints.geometry.dispose();
    starsPoints = null;
  }
  if (haloPoints) {
    starsGroup.remove(haloPoints);
    haloPoints.geometry.dispose();
    haloPoints = null;
  }
  starById = {};
  indexToNode = [];
  var n = laid.length;
  if (!n) return;

  var positions = new Float32Array(n * 3);
  var colors = new Float32Array(n * 3);
  var sizes = new Float32Array(n);
  var phases = new Float32Array(n);
  var alphas = new Float32Array(n);
  var cores = new Float32Array(n);
  var kinds = new Float32Array(n);
  var flows = new Float32Array(n * 3);
  var bobs = new Float32Array(n);

  var haloPos = [];
  var haloCol = [];
  var haloSize = [];
  var haloPhase = [];
  var haloAlpha = [];
  var haloFlow = [];
  var haloBob = [];
  var haloCount = 0;
  var white = new THREE.Color(0xffffff);
  var tmpC = new THREE.Color();

  for (var i = 0; i < n; i++) {
    var node = laid[i];
    starById[node.id] = node;
    indexToNode[i] = node;
    var pos = node._pos;
    positions[i * 3] = pos.x;
    positions[i * 3 + 1] = pos.y;
    positions[i * 3 + 2] = pos.z;
    var col = node._forceColor
      ? node._forceColor.clone()
      : (node.pinned ? PINNED_COLOR.clone() : typeColor(node.type));
    if (node.pinned) col.lerp(new THREE.Color(0xf0c060), 0.35);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
    sizes[i] = starSize(node.importance, node.pinned || node._special);
    phases[i] = (hashStr(node.id) % 6283) / 1000;
    alphas[i] = typeVisible[node.type] === false && !node._special ? 0.0 : 1.0;
    var imp = clamp(Number(node.importance) || 0, 0, 1);
    cores[i] = node.pinned || node._special ? 0.85 : 0.25 + imp * 0.5;
    kinds[i] = node.pinned ? 1 : (node._special ? 2 : 0);
    if (!node._flow) node._flow = new THREE.Vector3();
    if (node._bob == null) node._bob = 0;
    flows[i * 3] = node._flow.x;
    flows[i * 3 + 1] = node._flow.y;
    flows[i * 3 + 2] = node._flow.z;
    bobs[i] = node._bob;
    node._phase = phases[i];
    node._index = i;
    node._baseColor = col;
    node._baseSize = sizes[i];
    node._baseAlpha = alphas[i];
    node._halo = -1;

    // wide soft bloom for stars that should carry the scene
    if (node.pinned || node._special || imp >= 0.7) {
      var hk = node.pinned ? 4.0 : (node._special ? 4.4 : 3.0);
      var ha = node.pinned ? 0.5 : (node._special ? 0.42 : 0.28);
      if (node.pinned) tmpC.set(0xffdca8);
      else { tmpC.copy(col); tmpC.lerp(white, 0.3); }
      haloPos.push(pos.x, pos.y, pos.z);
      haloCol.push(tmpC.r, tmpC.g, tmpC.b);
      haloSize.push(sizes[i] * hk);
      haloPhase.push(phases[i]);
      haloAlpha.push(ha);
      haloFlow.push(node._flow.x, node._flow.y, node._flow.z);
      haloBob.push(node._bob);
      node._halo = haloCount++;
      node._haloBaseSize = sizes[i] * hk;
      node._haloBaseAlpha = ha;
    }
  }

  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geo.setAttribute('aCore', new THREE.BufferAttribute(cores, 1));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
  geo.setAttribute('aFlow', new THREE.BufferAttribute(flows, 3));
  geo.setAttribute('aBob', new THREE.BufferAttribute(bobs, 1));
  starsPoints = new THREE.Points(geo, starMaterial);
  starsGroup.add(starsPoints);

  if (haloCount) {
    var hgeo = new THREE.BufferGeometry();
    hgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(haloPos), 3));
    hgeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(haloCol), 3));
    hgeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(haloSize), 1));
    hgeo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(haloPhase), 1));
    hgeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(haloAlpha), 1));
    hgeo.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(haloFlow), 3));
    hgeo.setAttribute('aBob', new THREE.BufferAttribute(new Float32Array(haloBob), 1));
    haloPoints = new THREE.Points(hgeo, haloMaterial);
    starsGroup.add(haloPoints);
  }

  targetSizes = new Float32Array(sizes);
  targetAlphas = new Float32Array(alphas);
  targetHaloSizes = haloCount ? new Float32Array(haloSize) : null;
  targetHaloAlphas = haloCount ? new Float32Array(haloAlpha) : null;
  animActive = false;
}

function rebuildAdj() {
  adj = {};
  for (var i = 0; i < nodes.length; i++) {
    if (!nodes[i]._easter) adj[nodes[i].id] = [];
  }
  for (var e = 0; e < edges.length; e++) {
    var edge = edges[e];
    if (relVisible[edge.rel_type] === false) continue;
    if (!starById[edge.src] || !starById[edge.dst]) continue;
    if (!adj[edge.src]) adj[edge.src] = [];
    if (!adj[edge.dst]) adj[edge.dst] = [];
    adj[edge.src].push(edge.dst);
    adj[edge.dst].push(edge.src);
  }
}

function clearEdges() {
  while (edgesGroup.children.length) {
    var ch = edgesGroup.children[0];
    edgesGroup.remove(ch);
    if (ch.geometry) ch.geometry.dispose();
    if (ch.material) ch.material.dispose();
  }
  edgeObjects = [];
}

function bezierArc(a, b, seed) {
  var mid = a.clone().add(b).multiplyScalar(0.5);
  var dir = new THREE.Vector3().subVectors(b, a);
  var len = dir.length() || 1;
  var up = new THREE.Vector3(0, 1, 0);
  var side = new THREE.Vector3().crossVectors(dir.clone().normalize(), up);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  var rnd = mulberry32(seed);
  var lift = 1.2 + len * 0.12 + rnd() * 1.5;
  mid.y += lift;
  mid.addScaledVector(side, (rnd() - 0.5) * len * 0.15);
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}

function rebuildEdges() {
  clearEdges();
  var focus = hoverId || selectedId;
  for (var i = 0; i < edges.length; i++) {
    var edge = edges[i];
    if (relVisible[edge.rel_type] === false) continue;
    var a = starById[edge.src];
    var b = starById[edge.dst];
    if (!a || !b || a._easter || b._easter) continue;
    if (typeVisible[a.type] === false || typeVisible[b.type] === false) continue;
    var lit = showAllEdges || (focus && (edge.src === focus || edge.dst === focus));
    if (!lit && !showAllEdges) continue;
    if (!showAllEdges && focus && edge.src !== focus && edge.dst !== focus) continue;

    var curve = bezierArc(a._pos, b._pos, hashStr(edge.src + '>' + edge.dst + edge.rel_type));
    var pts = curve.getPoints(EDGE_SEGMENTS);
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    var col = (REL_COLORS[edge.rel_type] || REL_COLORS.supports).clone();
    var isFocusEdge = focus && (edge.src === focus || edge.dst === focus);
    var opacity = isFocusEdge ? 0.75 : (showAllEdges ? 0.18 : 0.55);
    if (edge.rel_type === 'supersedes') opacity *= 0.55;
    var mat = new THREE.LineBasicMaterial({
      color: col,
      transparent: true,
      opacity: opacity,
      depthWrite: false
    });
    // contradicts: dashed via LineDashedMaterial
    if (edge.rel_type === 'contradicts') {
      mat = new THREE.LineDashedMaterial({
        color: col, transparent: true, opacity: opacity,
        dashSize: 0.45, gapSize: 0.28, depthWrite: false
      });
      var line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      edgesGroup.add(line);
      edgeObjects.push({ line: line, a: a, b: b, mid: curve.v1.clone(), dashed: true });
    } else {
      var line2 = new THREE.Line(geo, mat);
      edgesGroup.add(line2);
      edgeObjects.push({ line: line2, a: a, b: b, mid: curve.v1.clone(), dashed: false });
    }
  }
}

function applyFocusVisual() {
  if (!starsPoints) return;
  var focus = hoverId || selectedId;
  var neigh = {};
  if (focus) {
    neigh[focus] = true;
    var list = adj[focus] || [];
    for (var i = 0; i < list.length; i++) neigh[list[i]] = true;
  }
  // colors snap instantly; size/alpha go through the easing targets
  var colors = starsPoints.geometry.getAttribute('aColor');
  var now = performance.now();
  for (var j = 0; j < nodes.length; j++) {
    var node = nodes[j];
    var idx = node._index;
    if (idx == null) continue;
    var typeOn = node._special || typeVisible[node.type] !== false;
    var lit = !focus || neigh[node.id] || node._special;
    var dim = focus ? (lit ? 1 : 0.12) : 1;
    var sizeMul = 1;
    if (typeOn) {
      var col = node._baseColor.clone();
      if (focus && lit && node.id === focus) {
        col.lerp(new THREE.Color(0xffffff), 0.25);
      }
      colors.setXYZ(idx, col.r, col.g, col.b);
      if (hoverId === node.id || selectedId === node.id) sizeMul = 1.1;
      if (pulseId === node.id && now < pulseUntil) {
        var p = (pulseUntil - now) / 900;
        sizeMul *= 1 + 0.55 * Math.sin((1 - p) * Math.PI * 4) * p;
      }
      targetSizes[idx] = node._baseSize * sizeMul;
      targetAlphas[idx] = dim;
    } else {
      targetAlphas[idx] = 0;
    }
    if (targetHaloSizes && node._halo != null && node._halo >= 0) {
      targetHaloSizes[node._halo] = node._haloBaseSize * (sizeMul > 1 ? 1.12 : 1);
      targetHaloAlphas[node._halo] = typeOn ? node._haloBaseAlpha * dim : 0;
    }
  }
  colors.needsUpdate = true;
  animActive = true;
}

// ease current sizes/alphas toward targets; rests (and snaps) when close
function applyStarAnim(dt) {
  if (!animActive || !starsPoints || !targetSizes) return;
  var k = 1 - Math.exp(-dt * 9);
  var sizes = starsPoints.geometry.getAttribute('aSize');
  var alphas = starsPoints.geometry.getAttribute('aAlpha');
  var pulseIdx = -1;
  if (pulseId && starById[pulseId] && starById[pulseId]._index != null) {
    pulseIdx = starById[pulseId]._index;
  }
  var maxD = 0;
  var n = indexToNode.length;
  for (var i = 0; i < n; i++) {
    if (i === pulseIdx) continue; // the pulse owns this star's size
    var ns = sizes.getX(i) + (targetSizes[i] - sizes.getX(i)) * k;
    var na = alphas.getX(i) + (targetAlphas[i] - alphas.getX(i)) * k;
    sizes.setX(i, ns);
    alphas.setX(i, na);
    var d = Math.max(Math.abs(targetSizes[i] - ns), Math.abs(targetAlphas[i] - na) * 2);
    if (d > maxD) maxD = d;
  }
  if (haloPoints && targetHaloSizes) {
    var hs = haloPoints.geometry.getAttribute('aSize');
    var ha = haloPoints.geometry.getAttribute('aAlpha');
    var hn = hs.count;
    for (var j = 0; j < hn; j++) {
      var nhs = hs.getX(j) + (targetHaloSizes[j] - hs.getX(j)) * k;
      var nha = ha.getX(j) + (targetHaloAlphas[j] - ha.getX(j)) * k;
      hs.setX(j, nhs);
      ha.setX(j, nha);
      var hd = Math.abs(targetHaloSizes[j] - nhs) * 0.2;
      if (hd > maxD) maxD = hd;
    }
    hs.needsUpdate = true;
    ha.needsUpdate = true;
  }
  sizes.needsUpdate = true;
  alphas.needsUpdate = true;
  if (maxD < 0.004) {
    for (var i2 = 0; i2 < n; i2++) {
      if (i2 === pulseIdx) continue;
      sizes.setX(i2, targetSizes[i2]);
      alphas.setX(i2, targetAlphas[i2]);
    }
    if (haloPoints && targetHaloSizes) {
      var hs2 = haloPoints.geometry.getAttribute('aSize');
      var ha2 = haloPoints.geometry.getAttribute('aAlpha');
      for (var j2 = 0; j2 < hs2.count; j2++) {
        hs2.setX(j2, targetHaloSizes[j2]);
        ha2.setX(j2, targetHaloAlphas[j2]);
      }
      hs2.needsUpdate = true;
      ha2.needsUpdate = true;
    }
    animActive = false;
  }
}

// per-frame pulse: touches only the pulsing star's size, never rebuilds edges
function updatePulse(now) {
  if (!starsPoints || !pulseId) return;
  var node = starById[pulseId];
  if (!node || node._index == null) { pulseId = null; return; }
  if (now >= pulseUntil) {
    pulseId = null;
    applyFocusVisual();
    return;
  }
  var p = (pulseUntil - now) / 900;
  var sizeMul = 1 + 0.55 * Math.sin((1 - p) * Math.PI * 4) * p;
  if (hoverId === node.id || selectedId === node.id) sizeMul *= 1.1;
  var sizes = starsPoints.geometry.getAttribute('aSize');
  sizes.setX(node._index, node._baseSize * sizeMul);
  sizes.needsUpdate = true;
}

// ── interaction ──────────────────────────────────────────────
// light activity: resets idle timer and stops auto-orbit (mouse move)`;
