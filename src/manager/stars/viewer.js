import ForceGraph3D from '3d-force-graph';
import { Group, Mesh, SphereGeometry, MeshLambertMaterial, MOUSE, TOUCH, Vector3 } from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { layoutGraph, makeView, presentView, collapseOverview } from './layout.js';
function start(sample, initialPath) {
const mode = "manager";
const started = performance.now();
const byId = new Map(sample.nodes.map(node => [node.id, node]));
const adjacent = new Map(sample.nodes.map(node => [node.id, new Set()]));
const groupSizes = new Map(), topicsByGroup = new Map();
for (const node of sample.nodes) {
  if (node.kind !== 'domain') groupSizes.set(node.group, (groupSizes.get(node.group) ?? 0) + 1);
  if (node.kind === 'topic') {
    if (!topicsByGroup.has(node.group)) topicsByGroup.set(node.group, []);
    topicsByGroup.get(node.group).push(node);
  }
}
sample.links.forEach(link => { adjacent.get(link.source).add(link.target); adjacent.get(link.target).add(link.source); });
const $ = id => document.getElementById(id);
const root = $('map');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const duration = () => reducedMotion.matches ? 0 : 420;
let palette;
const css = key => palette.get(key);
function readPalette() {
  const style = getComputedStyle(document.documentElement);
  palette = new Map(['--bg', '--text', '--muted', '--dim', '--focus-edge', '--cross-edge', '--structure-edge', '--edge'].map(key => [key, style.getPropertyValue(key).trim()]));
}
readPalette();
const endpoint = value => typeof value === 'object' ? value.id : value;
let graph, domainId, selected, hovered, view, presentation, fullView = false;
let expandedIds = [], history = [], pendingView = false, cameraAfterLoad;
let overviewCollapsed = true, detailGroups = new Set();
let objects = new Map();

const nodeRadius = node => node.kind === 'domain' ? 11 : node.kind === 'topic' ? 5 : 2.5;
const nodeScale = node => {
  let scale = 1;
  if (!fullView && !domainId && node.kind === 'domain' && !detailGroups.has(node.group)) {
    const camera = graph?.camera();
    const distance = camera ? camera.position.distanceTo(new Vector3(node.x, node.y, node.z)) : 0;
    scale = Math.max(1.8, 3 * distance * 2 * Math.tan((camera?.fov ?? 50) * Math.PI / 360) / root.clientHeight / 11);
  }
  return scale * (node.id === (hovered ?? selected) ? 1.35 : 1);
};
let labelFrame;
function arrangeLabels() {
  if (!graph || labelFrame) return;
  labelFrame = requestAnimationFrame(() => {
    labelFrame = undefined;
    const camera = graph.camera(), boxes = [];
    const candidates = [];
    for (const object of objects.values()) {
      object.sphere.scale.setScalar(nodeScale(object.node));
      syncLabel(object);
      if (object.label) candidates.push({ node: object.node, object });
    }
    candidates.sort((a, b) => Number(b.node.id === (hovered ?? selected)) - Number(a.node.id === (hovered ?? selected)) ||
      camera.position.distanceToSquared(a.object.group.position) - camera.position.distanceToSquared(b.object.group.position));
    for (const { node, object } of candidates) {
      object.label.position.y = nodeRadius(node) * nodeScale(node) + 5;
      if (!showLabel(node)) { object.element.hidden = true; continue; }
      const point = new Vector3(node.x, node.y + object.label.position.y, node.z).project(camera);
      const x = (point.x + 1) * root.clientWidth / 2, y = (1 - point.y) * root.clientHeight / 2;
      const width = [...object.element.textContent].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 14 : 8), 8);
      const box = { left: x - width / 2 - 4, right: x + width / 2 + 4, top: y - 24, bottom: y + 4 };
      const active = node.id === (hovered ?? selected);
      const hidden = point.z < -1 || point.z > 1 || box.left < 8 || box.right > root.clientWidth - 8 || box.top < 96 || box.bottom > root.clientHeight - 96 ||
        !active && boxes.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
      object.element.hidden = hidden;
      if (!hidden) boxes.push(box);
    }
  });
}
function updateOverviewScale() {
  if (!graph || !view) return;
  arrangeLabels();
  const camera = graph.camera();
  if (domainId || fullView) return;
  const groups = new Set(), candidates = [];
  for (const domain of sample.domains) {
    const star = byId.get(domain.id);
    const distance = camera.position.distanceTo(new Vector3(star.x, star.y, star.z));
    const diameter = domain.radius * root.clientHeight / (distance * Math.tan(camera.fov * Math.PI / 360));
    const point = new Vector3(star.x, star.y, star.z).project(camera);
    if (!collapseOverview(diameter, !detailGroups.has(star.group)) && Math.abs(point.x) < 1.2 && Math.abs(point.y) < 1.2 && point.z >= -1 && point.z <= 1)
      candidates.push({ group: star.group, distance });
  }
  // 压力样本中数十个主盘会同时达到像素阈值；全景只展开最近的 800 个细节节点。
  let remaining = 800;
  for (const { group } of candidates.sort((a, b) => a.distance - b.distance)) {
    const count = groupSizes.get(group);
    if (count <= remaining) { groups.add(group); remaining -= count; }
  }
  const next = !groups.size;
  if (next === overviewCollapsed && groups.size === detailGroups.size && [...groups].every(group => detailGroups.has(group))) return;
  detailGroups = groups;
  overviewCollapsed = next;
  if (next && hovered && byId.get(hovered).kind !== 'domain') hovered = undefined;
  updateAppearance();
  $('status').textContent = `全库星空，${$('visible-count').textContent}`;
}

function color(node) {
  if (node.id === (hovered ?? selected)) return css('--text');
  if ((hovered || selected) && !presentation.neighbors.has(node.id)) return css('--dim');
  return document.documentElement.dataset.theme === 'light'
    ? ['#476eaa','#8061a0','#996939','#327f73','#4c8050','#8b7420','#a4536b','#546b8d'][node.group % 8] : node.color;
}
function showLabel(node) {
  return presentation.nodes.has(node.id) && (node.kind === 'domain' || node.id === hovered || node.id === selected || node.kind === 'topic' && (node.external || domainId));
}
function nodeObject(node) {
  const group = new Group();
  const radius = nodeRadius(node);
  const sphere = new Mesh(new SphereGeometry(radius, node.kind === 'note' ? 8 : 20, 12), new MeshLambertMaterial({ color: color(node), emissive: color(node), emissiveIntensity: overviewCollapsed ? .65 : .22 }));
  sphere.scale.setScalar(nodeScale(node));
  group.add(sphere);
  const object = { node, group, sphere };
  syncLabel(object);
  group.addEventListener('removed', () => { object.element?.remove(); if (objects.get(node.id)?.group === group) objects.delete(node.id); });
  objects.set(node.id, object);
  return group;
}
function syncLabel(object) {
  const { node } = object;
  if (!showLabel(node)) {
    if (object.label) { object.group.remove(object.label); object.element.remove(); object.label = object.element = undefined; }
    return;
  }
  if (object.label) return;
  const element = document.createElement('button');
  element.className = `node-label ${node.kind}${node.external ? ' external' : ''}`;
  if (node.kind === 'note') element.style.pointerEvents = 'none';
  const title = node.kind === 'note' ? node.title.split(' · ').at(-1) : node.title;
  element.textContent = node.external ? `${title} ↗` : title;
  element.setAttribute('aria-label', node.title);
  if (node.external) element.setAttribute('aria-label', `${node.title}，${node.domain}，外部关联`);
  // 标签与 WebGL 球体各有命中逻辑，避免一次点标题又触发其后方节点。
  for (const type of ['pointerdown', 'pointerup', 'pointermove']) element.addEventListener(type, event => event.stopPropagation());
  element.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
  element.addEventListener('click', event => { event.stopPropagation(); navigate(node.id); });
  element.addEventListener('mouseenter', () => hoverNode(node.id));
  element.addEventListener('mouseleave', () => hoverNode(undefined));
  element.addEventListener('focus', () => hoverNode(node.id));
  element.addEventListener('blur', () => hoverNode(undefined));
  const label = new CSS2DObject(element);
  label.position.set(0, nodeRadius(node) * nodeScale(node) + 5, 0); label.center.set(.5, 1); object.group.add(label);
  object.element = element; object.label = label;

}

function edgeColor(link) {
  if (presentation.highlighted.has(link.id)) return css('--focus-edge');
  if (link.type !== '包含') return css('--cross-edge');
  return css(byId.get(endpoint(link.source)).kind === 'domain' ? '--structure-edge' : '--edge');
}
function updateAppearance() {
  presentation = presentView(view, { fullView, hovered, selected, expandedIds, collapsed: overviewCollapsed, visibleGroups: domainId ? undefined : detailGroups });
  for (const node of view.nodes) {
    const object = objects.get(node.id);
    if (!object) continue;
    object.sphere.material.color.set(color(node)); object.sphere.material.emissive.set(color(node));
    object.sphere.scale.setScalar(nodeScale(node));
    object.sphere.material.emissiveIntensity = overviewCollapsed ? .65 : .22;
    syncLabel(object);
    if (object.label) { object.label.position.y = nodeRadius(node) * nodeScale(node) + 5; object.element.classList.toggle('selected', node.id === (hovered ?? selected)); }
  }
  if (graph) graph.nodeVisibility(node => presentation.nodes.has(node.id))
    .linkVisibility(link => presentation.links.has(link.id))
    .linkColor(link => edgeColor(link))
    .linkWidth(link => presentation.highlighted.has(link.id) ? 1.2 : 0);
  const externalCount = view.nodes.filter(node => node.external && presentation.nodes.has(node.id)).length;
  $('visible-count').textContent = overviewCollapsed && !fullView ? `${presentation.nodes.size} 个恒星系` : `${presentation.nodes.size} 个节点 · ${presentation.links.size} 条连线${externalCount ? ` · ${externalCount} 个外部节点` : ''}`;
  $('compact-count').textContent = `${presentation.nodes.size} 节点 · ${presentation.links.size} 连线`;
  $('hover-caption').textContent = hovered ? `${byId.get(hovered).title} · ${adjacent.get(hovered).size} 条直接关联` : '';
  $('map').dataset.visibleLinks = presentation.links.size;
  $('map').dataset.highlightedLinks = presentation.highlighted.size;
  $('map').dataset.hovered = hovered ?? '';
  $('map').dataset.selected = selected ?? '';
  $('map').dataset.externalNodes = externalCount;
  $('map').dataset.detailLevel = overviewCollapsed && !fullView ? 'stars' : 'systems';
  $('map').dataset.visibleNodes = presentation.nodes.size;
  $('map').dataset.drawnSystems = domainId ? 1 : detailGroups.size;
  arrangeLabels();
}
function hoverNode(id) {
  if (hovered === id) return;
  hovered = id;
  updateAppearance();
}
function closeDetail() {
  selected = hovered = undefined; $('inspector').hidden = true;
  if (graph) { updateAppearance(); renderNavigation(); }
}
function focus(id) {
  const node = view.nodes.find(node => node.id === id);
  if (!node || !graph) return;
  fit(view.nodes.filter(other => presentation.nodes.has(other.id) && (other.id === id || adjacent.get(id).has(other.id))));
}
function inspect(id) {
  selected = id;
  const node = byId.get(id);
  const isExternal = domainId && node.group !== byId.get(domainId).group;
  $('inspector').hidden = false;
  $('detail-kind').textContent = `${node.domain} / ${isExternal ? '外部关联' : node.kind === 'domain' ? '知识主题' : node.kind === 'topic' ? '分组行星' : '知识条目'}`;
  $('detail-title').textContent = node.title; $('detail-summary').textContent = node.summary;
  $('detail-path').textContent = node.path; $('detail-degree').textContent = `${node.degree} 条直接关联`;
  $('open-note').hidden = !node.uri;
  if (node.uri) $('open-note').href = '#';
  $('detail-focus').textContent = isExternal ? '进入所属星系' : '定位此处';
  $('related').replaceChildren();
  for (const relatedId of adjacent.get(id)) {
    const button = document.createElement('button'); button.textContent = byId.get(relatedId).title;
    const link = sample.links.find(link => link.source === id && link.target === relatedId || link.target === id && link.source === relatedId);
    if (link?.origin) {
      const label = document.createElement('small'); label.style.display = 'block'; label.style.color = css('--muted');
      label.textContent = `${link.type === '引用' && link.target === id ? '被引用' : link.type}${link.inferred ? ' · 推断' : ''}`;
      button.append(label); button.title = link.evidence ?? '';
    }
    button.addEventListener('mouseenter', () => hoverNode(relatedId));
    button.addEventListener('mouseleave', () => hoverNode(undefined));
    button.addEventListener('focus', () => hoverNode(relatedId));
    button.addEventListener('blur', () => hoverNode(undefined));
    button.addEventListener('click', () => navigate(relatedId)); $('related').append(button);
  }
  $('status').textContent = `已选择 ${node.title}，${node.degree} 条直接关联`;
  updateAppearance(); renderNavigation();
}
function hideMobileNavigation() { document.body.classList.remove('sidebar-open'); $('navigation-toggle').setAttribute('aria-expanded', 'false'); }
function cameraSnapshot() {
  return graph ? { position: graph.camera().position.clone(), target: graph.controls().target.clone(), view: root.dataset.cameraView ?? 'outside' } : undefined;
}
function syncCameraView(mode) {
  root.dataset.cameraView = mode;
  if (graph) graph.controls().minDistance = mode === 'center' ? .01 : 40;
  $('center-view').setAttribute('aria-pressed', String(mode === 'center'));
  $('outside-view').setAttribute('aria-pressed', String(mode !== 'center'));
}
function navigate(id) {
  const node = byId.get(id), owner = `g${node.group}`;
  if (node.kind === 'domain' && domainId === owner && !selected && !expandedIds.length) return;
  if (node.id === selected) { focus(id); return; }
  history.push({ domainId, selected, expandedIds: [...expandedIds], fullView,
    camera: cameraSnapshot() });
  if (node.kind === 'domain') setView(owner);
  else {
    // 画布与详情中的外部节点在原星系向外展开，搜索另行进入所属领域。
    setView(domainId ?? owner, { selectedId: id, expansions: [...new Set([...expandedIds, id])] });
  }
  hideMobileNavigation();
}
function goBack() {
  const previous = history.pop();
  if (!previous) return;
  fullView = previous.fullView;
  setView(previous.domainId, { selectedId: previous.selected, expansions: previous.expandedIds, camera: previous.camera });
}
function renderNavigation() {
  $('legend').replaceChildren(); $('overview').setAttribute('aria-current', domainId ? 'false' : 'page');
  for (const domain of sample.domains) {
    const row = document.createElement('button');
    const dot = document.createElement('i'); dot.style.background = domain.color;
    const title = document.createElement('span'); title.textContent = domain.title;
    const meta = document.createElement('small'); meta.textContent = (topicsByGroup.get(byId.get(domain.id).group) ?? []).length;
    row.append(dot, title, meta); row.className = 'domain-row'; row.setAttribute('aria-expanded', String(domain.id === domainId));
    row.addEventListener('click', () => {
      if (domain.id === domainId) { history = []; setView(undefined); }
      else navigate(domain.id);
    }); $('legend').append(row);
    if (domain.id !== domainId) continue;
    const topics = document.createElement('div'); topics.className = 'topic-list';
    for (const topic of topicsByGroup.get(byId.get(domainId).group) ?? []) {
      const button = document.createElement('button'); button.textContent = topic.title;
      button.setAttribute('aria-current', selected === topic.id ? 'true' : 'false');
      button.addEventListener('click', () => navigate(topic.id)); topics.append(button);
    }
    $('legend').append(topics);
  }
  const external = view.nodes.filter(node => node.external && presentation.nodes.has(node.id));
  $('external-section').hidden = !external.length; $('external-list').replaceChildren();
  for (const node of external) {
    const button = document.createElement('button');
    const title = document.createElement('span'); title.textContent = `${node.title} ↗`;
    const meta = document.createElement('small'); meta.textContent = node.domain;
    button.append(title, meta); button.addEventListener('click', () => navigate(node.id)); $('external-list').append(button);
  }
}
function fit(nodes = view.nodes.filter(node => !domainId || presentation.nodes.has(node.id) || !node.previewOnly)) {
  if (!graph) return;
  // 固定坐标直接测量数据，避免依赖刚换场景、尚未更新的 Three.js 世界矩阵。
  const center = new Vector3(...['x', 'y', 'z'].map(axis => {
    const values = nodes.map(node => node[axis]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  }));
  const radius = Math.max(100, ...nodes.map(node => new Vector3(node.x, node.y, node.z).distanceTo(center))) + 28;
  const camera = graph.camera();
  const halfFov = camera.fov * Math.PI / 360;
  const angle = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
  const distance = radius / Math.sin(angle) * 1.15;
  const direction = camera.position.clone().sub(graph.controls().target).normalize();
  graph.cameraPosition(center.clone().addScaledVector(direction, distance), center, duration());
}
function cameraPreset(center = false) {
  if (!graph) return;
  graph.controls().minDistance = center ? .01 : 40;
  if (center) {
    const star = byId.get(domainId ?? sample.domains[0].id);
    const camera = { position: new Vector3(star.x, star.y, star.z).normalize().multiplyScalar(-.1), target: new Vector3(), view: 'center' };
    if (domainId) {
      history.push({ domainId, selected, expandedIds: [...expandedIds], fullView, camera: cameraSnapshot() });
      setView(undefined, { camera });
    }
    graph.cameraPosition(camera.position, camera.target, duration());
  } else {
    const star = domainId && byId.get(domainId);
    graph.cameraPosition(star ? new Vector3(star.x, star.y, star.z).normalize().multiplyScalar(star.systemRadius * 5) : { x: 60, y: 140, z: sample.radius * 3 }, { x: 0, y: 0, z: 0 });
    fit();
  }
  syncCameraView(center ? 'center' : 'outside');
}
function setView(id, { selectedId, expansions = [], camera } = {}) {
  domainId = id; selected = selectedId; hovered = undefined; expandedIds = expansions;
  overviewCollapsed = !id; detailGroups = new Set();
  $('inspector').hidden = !selected;
  // CSS2D 标签是独立 DOM，移除父 Group 不会触发子标签的 removed 事件。
  objects.forEach(object => object.element?.remove());
  objects = new Map(); view = makeView(sample, id, expandedIds);
  presentation = presentView(view, { fullView, selected, expandedIds, collapsed: overviewCollapsed });
  $('view-title').textContent = id ? byId.get(id).title : '全库星空';
  $('view-subtitle').textContent = selected ? byId.get(selected).title : '';
  $('back').hidden = !history.length; $('open-topic').hidden = !id;
  $('back').title = history.at(-1)?.selected ? `返回 ${byId.get(history.at(-1).selected).title}` : history.at(-1)?.domainId ? `返回 ${byId.get(history.at(-1).domainId).title}` : '返回全库星空';
  $('full-view').setAttribute('aria-pressed', String(fullView)); $('normal-view').setAttribute('aria-pressed', String(!fullView));
  syncCameraView(camera?.view ?? 'outside');
  pendingView = true; cameraAfterLoad = camera;
  graph?.graphData({ nodes: view.nodes.map(node => ({ ...node, fx: node.x, fy: node.y, fz: node.z })), links: view.links.map(link => ({ ...link })) });
  updateAppearance();
  if (selected) inspect(selected); else renderNavigation();
  if (!camera) {
    // 进入星系时从球外沿径向看向主盘，避免切面侧对镜头挤成一条线。
    const star = id && byId.get(id);
    graph?.cameraPosition(star ? new Vector3(star.x, star.y, star.z).normalize().multiplyScalar(star.systemRadius * 5) : { x: 60, y: 140, z: sample.radius * 3 }, { x: 0, y: 0, z: 0 });
  }
  $('status').textContent = `${id ? byId.get(id).title : '全库星空'}，${$('visible-count').textContent}`;
}
function mount() {
  const labels = new CSS2DRenderer(); labels.domElement.style.pointerEvents = 'none';
  graph = ForceGraph3D({ controlType: 'orbit', rendererConfig: { antialias: true, alpha: false }, extraRenderers: [labels] })(root)
    .width(root.clientWidth).height(root.clientHeight).backgroundColor(css('--bg')).showNavInfo(false)
    .cooldownTicks(0).enableNodeDrag(false).nodeLabel(() => '').nodeThreeObject(nodeObject)
    .nodeVisibility(node => presentation?.nodes.has(node.id) ?? false)
    .linkVisibility(link => presentation?.links.has(link.id) ?? false)
    .onEngineStop(() => {
      if (!pendingView) return;
      pendingView = false;
      // 引擎停止这一帧仍在更新物体坐标，下一帧再测量边界和移动镜头。
      requestAnimationFrame(() => {
        updateAppearance();
        if (cameraAfterLoad) graph.cameraPosition(cameraAfterLoad.position, cameraAfterLoad.target, duration());
        else if (selected) focus(selected); else fit();
        root.dataset.readyMs ??= (performance.now() - started).toFixed(1);
      });
    })
    .linkColor(edgeColor).linkOpacity(1).linkWidth(0)
    .onNodeClick(node => navigate(node.id))
    .onNodeHover(node => {
      root.style.cursor = node ? 'pointer' : 'grab';
      if (!node && root.querySelector('.node-label:hover, .node-label:focus-visible')) return;
      hoverNode(node?.id);
    }).onBackgroundClick(closeDetail);
  graph.renderer().setPixelRatio(Math.min(devicePixelRatio, 2));
  const controls = graph.controls();
  controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN };
  controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
  controls.enableDamping = true; controls.dampingFactor = .12; controls.autoRotate = false;
  controls.addEventListener('change', updateOverviewScale);
  controls.minDistance = 40; controls.maxDistance = Math.max(5000, sample.radius * 12);
  root.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
  root.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  const resize = new ResizeObserver(() => { graph.width(root.clientWidth).height(root.clientHeight); updateOverviewScale(); }); resize.observe(root);
  const visibility = () => document.hidden ? graph.pauseAnimation() : graph.resumeAnimation();
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', () => {
    resize.disconnect(); controls.removeEventListener('change', updateOverviewScale);
    document.removeEventListener('visibilitychange', visibility);
    if (labelFrame) cancelAnimationFrame(labelFrame);
    graph._destructor();
  }, { once: true });
  setView(undefined);
}
function hideSearch() { $('results').hidden = true; $('search').setAttribute('aria-expanded', 'false'); }
function search() {
  const query = $('search').value.trim().toLocaleLowerCase();
  $('results').replaceChildren(); $('results').hidden = !query; $('search').setAttribute('aria-expanded', String(!!query));
  if (!query) return;
  const found = sample.nodes.filter(node => `${node.title} ${node.domain}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => ({ domain: 0, topic: 1, note: 2 }[a.kind]) - ({ domain: 0, topic: 1, note: 2 }[b.kind])).slice(0, 12);
  if (!found.length) { const text = document.createElement('p'); text.textContent = '没有找到相关主题或知识'; $('results').append(text); }
  for (const node of found) {
    const button = document.createElement('button'); const title = document.createElement('span'); title.textContent = node.title;
    const meta = document.createElement('small'); meta.textContent = node.domain; button.append(title, meta);
    button.addEventListener('click', () => {
      if (node.kind !== 'domain' && domainId !== `g${node.group}`) {
        history.push({ domainId, selected, expandedIds: [...expandedIds], fullView,
          camera: cameraSnapshot() });
        setView(`g${node.group}`, { selectedId: node.id, expansions: [node.id] }); hideMobileNavigation();
      } else navigate(node.id);
      hideSearch();
    }); $('results').append(button);
  }
}
$('search').addEventListener('input', search); $('search').addEventListener('focus', search);
$('open-topic').addEventListener('click', () => inspect(domainId));
$('close').addEventListener('click', closeDetail);
$('detail-focus').addEventListener('click', () => {
  const node = byId.get(selected);
  if (node.group !== byId.get(domainId)?.group) navigate(`g${node.group}`); else { focus(selected); hideMobileNavigation(); }
});
$('overview').addEventListener('click', () => { history = []; setView(undefined); hideMobileNavigation(); });
$('back').addEventListener('click', goBack);
$('outside-view').addEventListener('click', () => cameraPreset());
$('center-view').addEventListener('click', () => cameraPreset(true));
$('normal-view').addEventListener('click', () => {
  fullView = false; $('full-view').setAttribute('aria-pressed', 'false'); $('normal-view').setAttribute('aria-pressed', 'true');
  updateAppearance(); updateOverviewScale(); renderNavigation();
});
$('full-view').addEventListener('click', () => {
  fullView = true; $('full-view').setAttribute('aria-pressed', 'true'); $('normal-view').setAttribute('aria-pressed', 'false');
  updateAppearance(); renderNavigation();
});
for (const [id, factor] of [['zoom-in', .75], ['zoom-out', 1.33]]) $(id).addEventListener('click', () => {
  const target = graph.controls().target;
  const position = graph.camera().position.clone().sub(target).multiplyScalar(factor).add(target);
  graph.cameraPosition(position, target, duration());
});
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme; readPalette();
  graph?.backgroundColor(css('--bg')); updateAppearance();
}
$('theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
const receive = event => {
  if (event.source !== parent) return;
  if (event.data?.type === 'knowledge-star-theme' && ['light', 'dark'].includes(event.data.theme)) applyTheme(event.data.theme);
  if (event.data?.type === 'knowledge-star-focus-last') {
    const controls = [...document.querySelectorAll('button:not(:disabled), input, a[href]')].filter(element => element.getClientRects().length);
    controls.at(-1)?.focus();
  }
};
window.addEventListener('message', receive);
window.addEventListener('pagehide', () => window.removeEventListener('message', receive), { once: true });
$('navigation-toggle').addEventListener('click', () => { const open = document.body.classList.toggle('sidebar-open'); $('navigation-toggle').setAttribute('aria-expanded', String(open)); });
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `knowledge-star-map-${mode}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('interaction-hint').textContent = matchMedia('(pointer: coarse)').matches ? '单指旋转 · 双指缩放与平移' : '中键旋转 · 滚轮缩放';
$('data-source').textContent = `已保存知识 · ${sample.domains.length} 个主题`;
root.dataset.totalNodes = sample.nodes.length; root.dataset.totalLinks = sample.links.length;
root.dataset.sphereRadius = sample.radius.toFixed(1);
document.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement.tagName !== 'INPUT') { event.preventDefault(); document.body.classList.add('sidebar-open'); $('navigation-toggle').setAttribute('aria-expanded', 'true'); $('search').focus(); }
  if (event.key === 'Escape') { hideSearch(); closeDetail(); hideMobileNavigation(); parent.postMessage({ type: 'knowledge-star-escape' }, '*'); }
  if (event.key === 'ArrowDown' && document.activeElement === $('search')) { event.preventDefault(); $('results').querySelector('button')?.focus(); }
  if (event.key === 'Enter' && document.activeElement === $('search')) $('results').querySelector('button')?.click();
});
document.addEventListener('click', event => { if (!event.target.closest('.search')) hideSearch(); });
$('open-note').addEventListener('click', event => { event.preventDefault(); parent.postMessage({ type: 'knowledge-star-open', id: selected }, '*'); });
if (!sample.nodes.length) { $('notice').hidden = false; $('notice').textContent = '还没有知识主题，可先整理一份材料。'; return; }
try { mount(); const initial = sample.nodes.find(node => node.kind === 'domain' && node.path === initialPath); if (initial) navigate(initial.id); } catch (error) {
  graph = undefined; setView(undefined);
  $('notice').hidden = false; $('notice').textContent = `三维星图未能绘制：${error.message}。仍可通过左侧目录查看短摘要。`;
  document.querySelectorAll('.controls button:not(#open-topic), #theme').forEach(button => { button.disabled = true; }); console.error(error);
}
}

window.addEventListener('message', function initialize(event) {
  if (event.source !== parent || event.data?.type !== 'knowledge-star-data') return;
  window.removeEventListener('message', initialize);
  document.documentElement.dataset.theme = event.data.theme;
  start(layoutGraph(event.data.data), event.data.focusPath);
});
parent.postMessage({ type: 'knowledge-star-ready' }, '*');
