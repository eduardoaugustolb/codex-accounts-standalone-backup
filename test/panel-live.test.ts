import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { panelLiveScript } from '../src/panel-live';

test('live panel pauses connections when blurred and refreshes external data on focus', async () => {
  let focus = true;
  const handlers: Record<string, () => void> = {};
  const requests: string[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const streams: { closed: boolean; close(): void }[] = [];
  const status = { textContent: '' };
  const document = {
    body: { dataset: {} as Record<string, string> },
    hidden: false, hasFocus: () => focus, activeElement: null,
    addEventListener: (key: string, fn: () => void) => { handlers[key] = fn; },
    querySelector: (selector: string) => selector === '[data-panel-base]' ? { href: 'http://127.0.0.1:1234/token/' } : selector === '[data-live-status]' ? status : selector === 'main' ? { replaceWith() {} } : null,
  };
  runInNewContext(panelLiveScript, {
    document, window: { location: { hash: "#preferences" }, addEventListener: (key: string, fn: () => void) => { handlers[key] = fn; } }, URL, AbortController,
    EventSource: class { closed = false; constructor() { streams.push(this); } close() { this.closed = true; } },
    DOMParser: class { parseFromString() { return { querySelector: () => ({}) }; } },
    fetch: async (url: URL) => { requests.push(url.href); return { ok: true, text: async () => '<main></main>' }; },
    setTimeout: (fn: () => void) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  await flush();
  expect(document.body.dataset.view).toBe("preferences");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('fresh=1');
  expect(timers.size).toBe(1);
  focus = false; handlers.blur!(); await flush();
  expect(timers.size).toBe(0);
  expect(streams[0]!.closed).toBe(true);
  expect(status.textContent).toBe('Pausado');
  focus = true; handlers.focus!(); await flush();
  expect(document.body.dataset.view).toBe("preferences");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain('fresh=1');
  expect(streams).toHaveLength(2);
  document.hidden = true; handlers.visibilitychange!();
  expect(timers.size).toBe(0);
  expect(streams[1]!.closed).toBe(true);
});
