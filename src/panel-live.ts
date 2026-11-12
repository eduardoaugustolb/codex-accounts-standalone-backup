import { panelNavigationScript } from "./panel-navigation";
// Runs only while the page is visible and focused. No background polling.
export const panelLiveScript = `(() => {
${panelNavigationScript}
let timer, controller, events, busy = false, stopped = false;
const focused = () => !document.hidden && document.hasFocus();
const status = () => document.querySelector('[data-live-status]');
let fresh = true;
async function sync() {
 if (!focused() || busy || stopped) return;
 busy = true; controller = new AbortController();
 try {
  const url = new URL('live', document.querySelector('[data-panel-base]').href);
  if (fresh) url.searchParams.set('fresh', '1');
  const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
  if (!response.ok) throw new Error();
  const html = await response.text(); fresh = false;
  const next = new DOMParser().parseFromString(html, 'text/html');
  const interacting = document.activeElement?.closest('form,details');
  if (!interacting && !document.querySelector('main details[open]')) {
   document.querySelector('main').replaceWith(next.querySelector('main'));
  } else {
   // Keep open confirmations and selected uploads intact while updating account data.
   const currentAccounts = document.querySelectorAll?.('.account') || [];
   for (const current of currentAccounts) {
    const updated = [...next.querySelectorAll('.account')].find(a => a.getAttribute('aria-label') === current.getAttribute('aria-label'));
    if (!updated) continue;
    for (const selector of ['.account-main', '.plan-limits', '.usage-meta']) {
     if (!document.activeElement?.closest(selector)) current.querySelector(selector)?.replaceWith(updated.querySelector(selector));
    }
   }
  }
  applyView();
  const sidebar = next.querySelector('.sidebar-bottom');
  if (sidebar) document.querySelector('.sidebar-bottom')?.replaceWith(sidebar);
  if (status()) status().textContent = 'Ao vivo';
 } catch (error) {
  if (error.name !== 'AbortError' && status()) status().textContent = 'Reconectando…';
 } finally { busy = false; if (focused() && !stopped) timer = setTimeout(sync, 3000); }
}
function wake() { clearTimeout(timer); events?.close(); events = undefined; if (focused()) { fresh = true; stopped = false;
 events = new EventSource(new URL('events', document.querySelector('[data-panel-base]').href));
 events.onmessage = () => { if (!busy && focused()) { clearTimeout(timer); sync(); } };
 events.onerror = () => { if(status()) status().textContent = 'Reconectando…'; };
 sync(); } else { controller?.abort(); if(status()) status().textContent = 'Pausado'; } }
window.addEventListener('focus', wake); window.addEventListener('blur', wake);
document.addEventListener('visibilitychange', wake);
window.addEventListener('pagehide', () => { stopped = true; events?.close(); clearTimeout(timer); controller?.abort(); });
wake();
})();`;
