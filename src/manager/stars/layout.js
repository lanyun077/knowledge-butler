// 全库的恒星系中心均匀分布在球面；系内保持规则圆盘，不运行力模拟。
function systemDirection(group) {
  // 二进制反转序列保留已存在星系的方向，增加数量时仅扩大球半径。
  let index = group + 1, fraction = 0, weight = .5;
  while (index) { fraction += (index % 2) * weight; index = Math.floor(index / 2); weight /= 2; }
  const y = 1 - 2 * fraction;
  const ring = Math.sqrt(1 - y * y);
  const angle = group * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(angle) * ring, y, Math.sin(angle) * ring];
}
// 局部 XY 平面沿球面相切，局部 Z 轴沿球心到恒星的径向。
function systemPoint(group, x, y, z = 0) {
  const [nx, ny, nz] = systemDirection(group);
  const ring = Math.hypot(nx, nz);
  const ux = nz / ring, uz = -nx / ring;
  const vx = ny * uz, vy = nz * ux - nx * uz, vz = -ny * ux;
  return [ux * x + vx * y + nx * z, vy * y + ny * z, uz * x + vz * y + nz * z];
}
function diskPoint(group, angle, radius) {
  return systemPoint(group, Math.cos(angle) * radius, Math.sin(angle) * radius);
}
// 每颗行星的卫星环各自倾斜，再随所属恒星系主盘转向。
function satellitePoint(group, topic, angle, radius) {
  const tilt = .55 + topic % 5 * .16;
  const heading = topic * 2.4 + group * .6;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius * Math.cos(tilt);
  const z = Math.sin(angle) * radius * Math.sin(tilt);
  const u = x * Math.cos(heading) - y * Math.sin(heading);
  const v = x * Math.sin(heading) + y * Math.cos(heading);
  return systemPoint(group, u, v, z);
}
// 内容尺寸决定圆环与球半径。外包球之间至少留 80 单位空隙。
export function layoutGraph(data) {
  const nodes = data.nodes.map(node => ({ ...node }));
  const membersByGroup = new Map(), childrenByParent = new Map();
  for (const node of nodes) {
    if (!membersByGroup.has(node.group)) membersByGroup.set(node.group, []);
    membersByGroup.get(node.group).push(node);
    if (node.parent) {
      if (!childrenByParent.has(node.parent)) childrenByParent.set(node.parent, []);
      childrenByParent.get(node.parent).push(node);
    }
  }
  const groups = data.domains.map((domain, group) => {
    const members = membersByGroup.get(group);
    const topics = members.filter(node => node.kind === 'topic');
    const rings = topics.map(topic => {
      const notes = childrenByParent.get(topic.id) ?? [];
      return { topic, notes, radius: Math.max(34, notes.length * 12 / (2 * Math.PI)) };
    });
    const satelliteRadius = Math.max(34, ...rings.map(ring => ring.radius));
    const orbit = Math.max(132, topics.length > 1 ? (2 * satelliteRadius + 32) / (2 * Math.sin(Math.PI / topics.length)) : 132);
    return { ...domain, group, members, rings, orbit, radius: orbit + satelliteRadius + 12, direction: systemDirection(group) };
  });
  let radius = 660;
  for (let i = 0; i < groups.length; i++) for (let j = 0; j < i; j++) {
    const a = groups[i], b = groups[j];
    const chord = Math.hypot(...a.direction.map((value, axis) => value - b.direction[axis]));
    radius = Math.max(radius, (a.radius + b.radius + 80) / chord);
  }
  const degree = new Map(nodes.map(node => [node.id, 0]));
  for (const link of data.links) { degree.set(link.source, degree.get(link.source) + 1); degree.set(link.target, degree.get(link.target) + 1); }
  for (const group of groups) {
    const center = group.direction.map(value => value * radius);
    const star = group.members.find(node => node.kind === 'domain');
    [star.x, star.y, star.z] = center; star.systemRadius = group.radius;
    group.rings.forEach(({ topic, notes, radius: ringRadius }, index) => {
      const angle = index / group.rings.length * Math.PI * 2 + Math.PI / 2;
      const point = diskPoint(group.group, angle, group.orbit);
      [topic.x, topic.y, topic.z] = point.map((value, axis) => center[axis] + value);
      notes.forEach((note, leaf) => {
        const point = satellitePoint(group.group, index, leaf / notes.length * Math.PI * 2 + angle, ringRadius);
        [note.x, note.y, note.z] = point.map((value, axis) => [topic.x, topic.y, topic.z][axis] + value);
      });
    });
  }
  nodes.forEach(node => { node.degree = degree.get(node.id); node.size = node.kind === 'domain' ? 6.5 : node.kind === 'topic' ? 3.7 : 1.6 + Math.min(node.degree, 5) * .18; });
  return { ...data, nodes, links: data.links.map(link => ({ ...link })), radius, gap: 80,
    domains: groups.map(({ id, title, color, radius, orbit }) => ({ id, title, color, radius, orbit })) };
}
// 预留内部节点的一跳端点用于悬停；只有点击过的外部节点才继续展开。
export function makeView(sample, domainId, expandedIds = []) {
  if (!domainId) return { nodes: sample.nodes.map(node => ({ ...node, external: false })), links: sample.links.map(link => ({ ...link })) };
  const center = sample.nodes.find(node => node.id === domainId);
  const starsByGroup = new Map(sample.nodes.filter(node => node.kind === 'domain').map(node => [node.group, node]));
  const boundary = center.systemRadius + Math.max(...sample.domains.map(domain => domain.radius)) + 100;
  const internal = new Set(sample.nodes.filter(node => node.group === center.group).map(node => node.id));
  const seeds = new Set([...internal, ...expandedIds]);
  const base = sample.links.filter(link => seeds.has(link.source) || seeds.has(link.target));
  const baseVisible = new Set(seeds);
  base.forEach(link => { baseVisible.add(link.source); baseVisible.add(link.target); });
  // 外部端点也能悬停看完整一跳；这些候选在常态和全视图中均不自动展开。
  const links = sample.links.filter(link => baseVisible.has(link.source) || baseVisible.has(link.target));
  const visible = new Set(baseVisible);
  links.forEach(link => { visible.add(link.source); visible.add(link.target); });
  return { nodes: sample.nodes.filter(node => visible.has(node.id)).map(node => {
    let x = node.x - center.x, y = node.y - center.y, z = node.z - center.z;
    const external = !internal.has(node.id);
    if (external) {
      const star = starsByGroup.get(node.group);
      const angle = node.group / sample.domains.length * Math.PI * 2;
      x = Math.cos(angle) * boundary + (node.x - star.x) * .66;
      y = Math.sin(angle) * boundary + (node.y - star.y) * .66;
      z = (node.group % 3 - 1) * 45 + (node.z - star.z) * .66;
    }
    return { ...node, x, y, z, external, previewOnly: !baseVisible.has(node.id) };
  }), links: links.map(link => ({ ...link, previewOnly: !seeds.has(link.source) && !seeds.has(link.target) })) };
}

// 常态只画归属骨架，悬停临时揭示，点击展开保持，全部关系由用户开启。
export function collapseOverview(projectedDiameter, wasCollapsed = false) {
  return projectedDiameter < (wasCollapsed ? 144 : 120);
}

export function presentView(view, { fullView = false, hovered, selected, expandedIds = [], collapsed = false, visibleGroups } = {}) {
  if (collapsed && !fullView) return {
    nodes: new Set(view.nodes.filter(node => node.kind === 'domain').map(node => node.id)),
    links: new Set(), highlighted: new Set(), neighbors: new Set(hovered ? [hovered] : []),
  };
  const byId = new Map(view.nodes.map(node => [node.id, node]));
  const expanded = new Set(expandedIds);
  const reveals = new Set([...expanded, hovered, selected].filter(Boolean));
  const focus = hovered ?? selected;
  const nodes = new Set(view.nodes.filter(node => fullView && !node.previewOnly || !node.external || reveals.has(node.id)).map(node => node.id));
  const links = new Set(), highlighted = new Set(), neighbors = new Set(focus ? [focus] : []);
  for (const link of view.links) {
    const source = byId.get(link.source), target = byId.get(link.target);
    if (!fullView && visibleGroups && (!visibleGroups.has(source.group) || !visibleGroups.has(target.group))) continue;
    const direct = link.source === focus || link.target === focus;
    const reveal = reveals.has(link.source) || reveals.has(link.target);
    const skeleton = link.type === '包含' && source.group === target.group && !source.external && !target.external;
    if (fullView && !link.previewOnly || skeleton || reveal) {
      links.add(link.id); nodes.add(link.source); nodes.add(link.target);
    }
    if (direct) { highlighted.add(link.id); neighbors.add(link.source); neighbors.add(link.target); }
  }
  if (!fullView && visibleGroups) for (const id of nodes) if (byId.get(id).kind !== 'domain' && !visibleGroups.has(byId.get(id).group)) nodes.delete(id);
  return { nodes, links, highlighted, neighbors };
}
