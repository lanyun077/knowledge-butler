// Run only against an isolated DSH profile. Creates a fresh test Vault; never accepts an existing Vault path.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const launchUrl = process.env.DSH_PROBE_URL;
assert.ok(launchUrl, 'DSH_PROBE_URL must be the isolated host login URL');
const origin = new URL(launchUrl).origin;
assert.equal(new URL(origin).hostname, '127.0.0.1');
const login = await fetch(launchUrl, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Isolated host login failed');

async function request(channel, endpoint, payload, authenticated = true, requestOrigin = origin) {
  const response = await fetch(`${origin}${channel}/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: requestOrigin, ...(authenticated ? { cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }),
  });
  if (!authenticated || requestOrigin !== origin) return response.status;
  assert.equal(response.status, 200);
  const envelope = await response.json();
  if (!envelope.result.ok) throw new Error(envelope.result.error.message);
  return envelope.result.value;
}
const settings = (endpoint, args) => request('/api', endpoint, { args });
const describe = async () => (await settings('settings/describe', {})).namespaces.find(value => value.ns === 'dsh-learning-os');
const original = await describe();
assert.ok(original?.value?.vault, 'Host must expose Vault configuration');
const root = await mkdtemp(join(resolve(process.cwd()), 'learning-business-probe-'));
const folders = { inbox: 'Inbox', knowledge: 'Knowledge', daily: 'Daily', projects: 'Projects', learning: 'Learning' };
const config = { root, folders };
const scope = JSON.stringify([root, ...Object.values(folders)]);
const call = (endpoint, payload = {}) => request('/api', `learning-os/${endpoint}`, { ...payload, scope });

try {
  await settings('settings/mutate', { ns: original.ns, ops: [{ op: 'set', path: ['vault'], value: config }], expectedRevision: original.revision });
  assert.deepEqual((await describe()).value.vault, config);
  assert.equal(await request('/api', 'learning-os/list', { query: '', scope }, false), 401);
  assert.equal(await request('/api', 'learning-os/list', { query: '', scope }, true, 'https://foreign.example'), 403);
  assert.deepEqual(await call('list', { query: '' }), []);
  const before = '\uFEFF---\r\nunknown: "keep: value"\r\n---\r\n# 测试记录\r\n原始内容\r\n';
  const note = await call('capture', { title: '业务闭环', content: before });
  assert.equal((await call('list', { query: '原始内容' })).length, 1);
  const plan = await call('plan-update', { path: note.path, version: note.version, content: '# 修改后的正文\n' });
  assert.equal(await readFile(join(root, note.path), 'utf8'), before);
  const changed = await call('execute', { planId: plan.id });
  assert.equal(changed.status, 'completed');
  assert.deepEqual(await call('execute', { planId: plan.id }), changed);
  await call('activity');
  assert.equal((await call('restore', { operationId: plan.id })).status, 'completed');
  assert.equal(await readFile(join(root, note.path), 'utf8'), before);
  const current = await call('read', { path: note.path });
  const conflict = await call('plan-update', { path: note.path, version: current.version, content: 'stale' });
  await writeFile(join(root, note.path), 'External edit');
  assert.equal((await call('execute', { planId: conflict.id })).status, 'failed');
  assert.equal(await readFile(join(root, note.path), 'utf8'), 'External edit');
  await assert.rejects(call('read', { path: '../outside.md' }));
  await assert.rejects(request('/api', 'learning-os/capture', { scope: 'old-space', title: 'blocked', content: 'blocked' }));
  console.log('PASS: authenticated host configuration, capture, search, preview, execute, idempotency, restore and conflict checks');
  console.log(`Isolated evidence Vault: ${root}`);
} finally {
  const latest = await describe();
  await settings('settings/mutate', { ns: latest.ns, ops: [{ op: 'set', path: ['vault'], value: original.value.vault }], expectedRevision: latest.revision });
  assert.deepEqual((await describe()).value.vault, original.value.vault);
  console.log('PASS: original isolated profile Vault configuration restored');
}
