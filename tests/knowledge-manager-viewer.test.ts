// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('3d-force-graph', () => ({ default: () => () => { throw new Error('WebGL unavailable'); } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it('keeps the directory, short preview and open request usable when WebGL cannot start', async () => {
  const shell = await readFile('src/manager/stars/shell.html', 'utf8');
  document.body.innerHTML = shell.split('<body>')[1].split('<script>')[0];
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const send = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  // @ts-expect-error The standalone browser viewer is JavaScript without a declaration file.
  await import('../src/manager/stars/viewer.js');
  const common = { group: 0, domain: '接口设计', color: '#a8c1ea', summary: '短概况', path: 'Wiki/interface.md', version: 'a'.repeat(64), uri: 'obsidian://open?path=trusted' };
  window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { type: 'knowledge-star-data', theme: 'light', data: {
    domains: [{ id: 'g0', title: '接口设计', color: common.color }],
    nodes: [{ ...common, id: 'g0', title: '接口设计', kind: 'domain' }, { ...common, id: 'g0t0', title: '边界', kind: 'topic', parent: 'g0' }],
    links: [{ id: 'e0', source: 'g0', target: 'g0t0', type: '包含' }],
  } } }));
  expect(error).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#notice')!.textContent).toContain('WebGL unavailable');
  expect(document.querySelector<HTMLButtonElement>('#outside-view')!.disabled).toBe(true);
  document.querySelector<HTMLButtonElement>('#legend button')!.click();
  expect(document.querySelector('#legend button')!.getAttribute('aria-expanded')).toBe('true');
  document.querySelector<HTMLButtonElement>('#legend button')!.click();
  expect(document.querySelector('#legend button')!.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('.topic-list')).toBeNull();
  document.querySelector<HTMLButtonElement>('#legend button')!.click();
  document.querySelector<HTMLButtonElement>('#open-topic')!.click();
  expect(document.querySelector<HTMLElement>('#inspector')!.hidden).toBe(false);
  expect(document.querySelector('#detail-summary')!.textContent).toBe('短概况');
  document.querySelector<HTMLAnchorElement>('#open-note')!.click();
  expect(send).toHaveBeenLastCalledWith({ type: 'knowledge-star-open', id: 'g0' }, '*');
});
