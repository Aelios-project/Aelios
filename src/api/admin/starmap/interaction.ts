export const STARMAP_INTERACTION_SCRIPT = String.raw`function noteActivity() {
  idleT0 = performance.now();
  if (autoOrbit) {
    autoOrbit = false;
    controls.enableDamping = true;
  }
}

// deliberate input: also cancels camera tweens and skips the intro
function markActivity() {
  noteActivity();
  camTween = null;
  if (introActive) skipIntro();
}

function skipIntro() {
  if (!introActive) return;
  introActive = false;
  skipHint.classList.remove('show');
  camera.position.set(6, 18, 28);
  controls.target.set(0, 2.5, 1);
  controls.update();
}

function startIntro() {
  introActive = true;
  introT0 = performance.now();
  skipHint.classList.add('show');
  camera.position.set(4, 12, 92);
  controls.target.set(0, -1, 40);
  controls.update();
}

function updateIntro(now) {
  if (!introActive) return;
  var t = (now - introT0) / 3400;
  if (t >= 1) {
    skipIntro();
    return;
  }
  t = easeInOutCubic(clamp(t, 0, 1));
  var fromPos = new THREE.Vector3(4, 12, 92);
  var toPos = new THREE.Vector3(6, 18, 28);
  var fromTarget = new THREE.Vector3(0, -1, 40);
  var toTarget = new THREE.Vector3(0, 2.5, 1);
  camera.position.lerpVectors(fromPos, toPos, t);
  controls.target.lerpVectors(fromTarget, toTarget, t);
  controls.update();
}

function pickStar(clientX, clientY) {
  if (!starsPoints) return null;
  var rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // scale threshold with distance
  var dist = camera.position.distanceTo(controls.target);
  raycaster.params.Points.threshold = clamp(dist * 0.02, 0.45, 2.2);
  var hits = raycaster.intersectObject(starsPoints, false);
  if (!hits.length) return null;
  // nearest visible hit; index→node map keeps this O(hits)
  for (var i = 0; i < hits.length; i++) {
    var node = indexToNode[hits[i].index];
    if (!node) continue;
    if (typeVisible[node.type] === false && !node._special) continue;
    return node;
  }
  return null;
}

function showTooltip(node, clientX, clientY) {
  if (!node) {
    tooltipEl.classList.remove('show');
    return;
  }
  tooltipEl.textContent = node.label || node.id;
  tooltipEl.style.left = clientX + 'px';
  tooltipEl.style.top = clientY + 'px';
  tooltipEl.classList.add('show');
}

function openDrawer(node) {
  if (!node || node._easter) {
    closeDrawer();
    return;
  }
  selectedId = node.id;
  drawerTitle.textContent = node.label || node.id;
  drawerMeta.innerHTML = '';
  var fields = [
    ['type', node.type || '—'],
    ['importance', pct(node.importance)],
    ['status', node.version_status || 'current'],
    ['created', fmtTime(node.created_at)]
  ];
  for (var i = 0; i < fields.length; i++) {
    var cell = document.createElement('div');
    cell.className = 'meta-cell';
    cell.innerHTML = fields[i][0] + '<strong></strong>';
    cell.querySelector('strong').textContent = fields[i][1];
    drawerMeta.appendChild(cell);
  }
  drawerEdges.innerHTML = '';
  var list = [];
  for (var e = 0; e < edges.length; e++) {
    var edge = edges[e];
    if (relVisible[edge.rel_type] === false) continue;
    var otherId = null;
    if (edge.src === node.id) otherId = edge.dst;
    else if (edge.dst === node.id) otherId = edge.src;
    if (!otherId) continue;
    var other = starById[otherId];
    list.push({ rel: edge.rel_type, otherId: otherId, label: other ? other.label : otherId });
  }
  if (!list.length) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:12px;color:var(--muted);padding:8px 0';
    empty.textContent = '这颗星还没有连线。';
    drawerEdges.appendChild(empty);
  } else {
    for (var k = 0; k < list.length; k++) {
      (function (item) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'edge-item';
        var rel = document.createElement('span');
        rel.className = 'edge-rel';
        rel.textContent = item.rel;
        var lab = document.createElement('span');
        lab.textContent = item.label;
        btn.appendChild(rel);
        btn.appendChild(lab);
        btn.addEventListener('click', function () {
          flyTo(item.otherId, true);
        });
        drawerEdges.appendChild(btn);
      })(list[k]);
    }
  }
  drawerEl.classList.add('open');
  applyFocusVisual();
  rebuildEdges();
}

function closeDrawer() {
  selectedId = null;
  drawerEl.classList.remove('open');
  applyFocusVisual();
  rebuildEdges();
}

function flyTo(id, openDetail) {
  var node = starById[id];
  if (!node) return;
  markActivity();
  var dest = node._pos.clone();
  // approach along the current view direction so far-upstream stars stay readable
  var dir = camera.position.clone().sub(controls.target);
  var dist = clamp(dir.length() * 0.45, 7, 18);
  if (dir.lengthSq() < 1e-8) dir.set(0, 0.5, 1);
  dir.normalize();
  camTween = {
    fromPos: camera.position.clone(),
    toPos: dest.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, 1.6, 0)),
    fromTgt: controls.target.clone(),
    toTgt: dest.clone().add(new THREE.Vector3(0, 0.4, 0)),
    t0: performance.now(),
    dur: 1000
  };
  pulseId = id;
  pulseUntil = performance.now() + 900;
  if (openDetail && !node._easter) openDrawer(node);
  else if (node._easter) {
    selectedId = null;
    hoverId = id;
    applyFocusVisual();
    rebuildEdges();
  } else {
    selectedId = id;
    applyFocusVisual();
    rebuildEdges();
  }
}

function searchStars(q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return null;
  var best = null;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n._easter) continue;
    if (typeVisible[n.type] === false) continue;
    var label = (n.label || '').toLowerCase();
    if (label.indexOf(q) !== -1) {
      if (!best || label.length < (best.label || '').length) best = n;
    }
  }
  return best;
}

// ── data load ────────────────────────────────────────────────
function prefs() {
  return {
    apiKey: localStorage.getItem('aelios.admin.apiKey') || '',
    namespace: localStorage.getItem('aelios.admin.namespace') || 'default',
    workerUrl: (localStorage.getItem('aelios.admin.workerUrl') || location.origin).replace(/\/+$/, '')
  };
}

async function loadGraph() {
  var seq = ++loadSeq;
  var p = prefs();
  loadingBanner.hidden = false;
  emptyBanner.hidden = true;
  authBanner.hidden = true;
  errorBanner.hidden = true;
  if (!p.apiKey.trim()) {
    loadingBanner.hidden = true;
    authBanner.hidden = false;
    nodes = layoutStars([]);
    rebuildStars(nodes);
    rebuildAdj();
    rebuildEdges();
    updateCount();
    if (firstLoad) { firstLoad = false; startIntro(); }
    return;
  }
  try {
    var url = p.workerUrl + '/api/relations/graph?limit=800&namespace=' + encodeURIComponent(p.namespace);
    var res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + p.apiKey }
    });
    var text = await res.text();
    if (seq !== loadSeq) return; // superseded by a newer request
    var payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (err) { payload = null; }
    if (!res.ok) {
      throw new Error(
        payload && payload.error && payload.error.message
          ? payload.error.message
          : (res.status + ' ' + res.statusText)
      );
    }
    var rawNodes = (payload && payload.nodes) || [];
    edges = (payload && payload.edges) || [];
    meta = (payload && payload.meta) || { total_nodes: 0, total_edges: 0, truncated: false };
    nodes = layoutStars(rawNodes);
    rebuildStars(nodes);
    rebuildAdj();
    applyFocusVisual();
    rebuildEdges();
    updateCount();
    var realCount = rawNodes.length;
    emptyBanner.textContent = '江还在流，星等你来';
    emptyBanner.hidden = realCount > 0;
    // intro runs on first load only; refresh keeps the user's camera
    if (firstLoad) { firstLoad = false; startIntro(); }
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error(err);
    countLabel.textContent = 'LOAD FAILED';
    errorBanner.textContent = (err && err.message) ? err.message : '加载失败';
    errorBanner.hidden = false;
  }
  loadingBanner.hidden = true;
}

function updateCount() {
  var real = 0;
  for (var i = 0; i < nodes.length; i++) if (!nodes[i]._easter) real++;
  lastRealCount = real;
  var edgeN = edges.length;
  var extra = meta.truncated ? ' · TRUNCATED' : '';
  countLabel.textContent = real + ' MEMORIES · ' + edgeN + ' LINKS' + extra + ' · TWO RIVERS';
}

// ── render loop ──────────────────────────────────────────────
function resize() {
  var w = window.innerWidth;
  var h = window.innerHeight;
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  starMaterial.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
  haloMaterial.uniforms.uPixelRatio.value = starMaterial.uniforms.uPixelRatio.value;
  for (var fm = 0; fm < flowMaterials.length; fm++) {
    flowMaterials[fm].uniforms.uPixelRatio.value = starMaterial.uniforms.uPixelRatio.value;
  }
}

function frame(now) {
  raf = 0;
  if (!pageVisible) return;
  var dt = Math.min(clock.getDelta(), 0.05);
  updateIntro(now);
  if (camTween) {
    var tt = clamp((now - camTween.t0) / camTween.dur, 0, 1);
    var te = easeInOutCubic(tt);
    camera.position.lerpVectors(camTween.fromPos, camTween.toPos, te);
    controls.target.lerpVectors(camTween.fromTgt, camTween.toTgt, te);
    if (tt >= 1) camTween = null;
  }
  if (!introActive && autoOrbit) {
    // slow drift around the confluence; damping off so controls don't fight us
    orbitAng += dt * 0.07; // ~90s per revolution
    var r = camera.position.distanceTo(controls.target);
    camera.position.x = controls.target.x + Math.cos(orbitAng) * r;
    camera.position.z = controls.target.z + Math.sin(orbitAng) * r;
    camera.lookAt(controls.target);
  } else if (!introActive && !camTween && now - idleT0 > 20000) {
    autoOrbit = true;
    controls.enableDamping = false;
    orbitAng = Math.atan2(
      camera.position.z - controls.target.z,
      camera.position.x - controls.target.x
    );
  }
  controls.update();
  var tSec = now * 0.001;
  starMaterial.uniforms.uTime.value = tSec;
  haloMaterial.uniforms.uTime.value = tSec;
  flowClock += dt * flowRate;
  for (var fm = 0; fm < flowMaterials.length; fm++) flowMaterials[fm].uniforms.uTime.value = flowClock;
  for (var rb = 0; rb < ribbonMaterials.length; rb++) ribbonMaterials[rb].uniforms.uTime.value = flowClock;
  updateEdgeSway(tSec);
  for (var f = 0; f < fogSprites.length; f++) {
    var fs = fogSprites[f];
    fs.mat.opacity = fs.base * (0.8 + 0.2 * Math.sin(tSec * fs.speed + fs.phase));
  }
  applyStarAnim(dt);
  updatePulse(now);
  renderer.render(scene, camera);
  fpsEma += (1 / Math.max(dt, 0.001) - fpsEma) * 0.05;
  if (now - statsT0 > 500) {
    statsT0 = now;
    statsEl.textContent = Math.round(fpsEma) + ' fps · ' + lastRealCount + ' 星';
  }
  raf = requestAnimationFrame(frame);
}

function ensureLoop() {
  if (!pageVisible) return;
  if (!raf) raf = requestAnimationFrame(frame);
}

// ── UI wiring ────────────────────────────────────────────────
function buildLegends() {
  typeLegendEl.innerHTML = '<span class="chips-label">类型</span>';
  TYPE_LEGEND.forEach(function (item) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.id = item.id;
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = item.color;
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(item.label));
    btn.addEventListener('click', function () {
      typeVisible[item.id] = !typeVisible[item.id];
      btn.classList.toggle('is-off', !typeVisible[item.id]);
      applyFocusVisual();
      rebuildEdges();
    });
    typeLegendEl.appendChild(btn);
  });
  relLegendEl.innerHTML = '<span class="chips-label">关系</span>';
  REL_LEGEND.forEach(function (item) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.id = item.id;
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = item.color;
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(item.label));
    btn.addEventListener('click', function () {
      relVisible[item.id] = !relVisible[item.id];
      btn.classList.toggle('is-off', !relVisible[item.id]);
      rebuildAdj();
      applyFocusVisual();
      rebuildEdges();
    });
    relLegendEl.appendChild(btn);
  });
}

document.getElementById('chipsToggle').addEventListener('click', function () {
  chipsPanel.classList.toggle('open');
});
document.getElementById('searchToggle').addEventListener('click', function () {
  searchBar.hidden = !searchBar.hidden;
  if (!searchBar.hidden) document.getElementById('searchInput').focus();
});
document.getElementById('refreshBtn').addEventListener('click', function () {
  markActivity();
  closeDrawer();
  loadGraph();
});
document.getElementById('edgesToggle').addEventListener('click', function () {
  showAllEdges = !showAllEdges;
  this.classList.toggle('is-off', !showAllEdges);
  applyFocusVisual();
  rebuildEdges();
});
function runSearch() {
  var hit = searchStars(document.getElementById('searchInput').value);
  if (hit) {
    searchBar.hidden = true;
    flyTo(hit.id, true);
  }
}
document.getElementById('searchBtn').addEventListener('click', runSearch);
document.getElementById('searchInput').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    runSearch();
  } else if (ev.key === 'Escape') {
    searchBar.hidden = true;
  }
});
document.getElementById('drawerClose').addEventListener('click', function () {
  closeDrawer();
});

// mobile: drag the drawer down by its head to dismiss
(function drawerSwipe() {
  var startY = 0;
  var curY = 0;
  var dragging = false;
  drawerEl.addEventListener('touchstart', function (ev) {
    if (window.innerWidth >= 768) return;
    var t = ev.target;
    if (!t || !t.closest || !t.closest('.drawer-head, .drawer-grabber')) return;
    dragging = true;
    startY = ev.touches[0].clientY;
    curY = 0;
    drawerEl.style.transition = 'none';
  }, { passive: true });
  drawerEl.addEventListener('touchmove', function (ev) {
    if (!dragging) return;
    curY = ev.touches[0].clientY - startY;
    if (curY > 0) drawerEl.style.transform = 'translateY(' + curY + 'px)';
  }, { passive: true });
  drawerEl.addEventListener('touchend', function () {
    if (!dragging) return;
    dragging = false;
    drawerEl.style.transition = '';
    drawerEl.style.transform = '';
    if (curY > 70) closeDrawer();
  });
})();

var pointerDown = null;
canvas.addEventListener('pointerdown', function (ev) {
  markActivity();
  pointerDown = { x: ev.clientX, y: ev.clientY, t: performance.now() };
});
canvas.addEventListener('pointermove', function (ev) {
  noteActivity();
  var node = pickStar(ev.clientX, ev.clientY);
  var next = node ? node.id : null;
  if (next !== hoverId) {
    hoverId = next;
    applyFocusVisual();
    rebuildEdges();
  }
  showTooltip(node, ev.clientX, ev.clientY);
  canvas.style.cursor = node ? 'pointer' : 'default';
});
canvas.addEventListener('pointerleave', function () {
  hoverId = null;
  showTooltip(null);
  applyFocusVisual();
  rebuildEdges();
});
canvas.addEventListener('pointerup', function (ev) {
  if (!pointerDown) return;
  var dx = ev.clientX - pointerDown.x;
  var dy = ev.clientY - pointerDown.y;
  var dt = performance.now() - pointerDown.t;
  pointerDown = null;
  if (dx * dx + dy * dy > 36 || dt > 500) return;
  var node = pickStar(ev.clientX, ev.clientY);
  if (!node) {
    closeDrawer();
    return;
  }
  if (node._easter) {
    selectedId = null;
    hoverId = node.id;
    drawerEl.classList.remove('open');
    applyFocusVisual();
    rebuildEdges();
    showTooltip(node, ev.clientX, ev.clientY);
    return;
  }
  openDrawer(node);
});

window.addEventListener('resize', function () {
  resize();
  ensureLoop();
});
document.addEventListener('visibilitychange', function () {
  pageVisible = !document.hidden;
  if (pageVisible) {
    clock.getDelta();
    ensureLoop();
  } else if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
});
['pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(function (evt) {
  window.addEventListener(evt, markActivity, { passive: true });
});

// boot
buildLegends();
resize();
startIntro();
ensureLoop();
loadGraph();`;
