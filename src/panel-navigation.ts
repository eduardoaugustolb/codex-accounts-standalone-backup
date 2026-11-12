export const panelNavigationScript = `
const sections = { accounts: 'Contas', preferences: 'Preferências', session: 'Sessão' };
function applyView() {
 const key = window.location?.hash?.slice(1);
 const selected = Object.prototype.hasOwnProperty.call(sections, key) ? key : 'accounts';
 if (document.body) document.body.dataset.view = selected;
 for (const link of document.querySelectorAll?.('[data-nav]') || []) {
  if (link.dataset.nav === selected) link.setAttribute('aria-current', 'page');
  else link.removeAttribute('aria-current');
 }
 const title = document.querySelector('[data-section-title]');
 if (title) title.textContent = sections[selected];
 document.title = sections[selected] + ' · Codex';
}
function closeSidebar() {
 if (document.body?.dataset.sidebar === 'open') delete document.body.dataset.sidebar;
 document.querySelector('.mobile-menu')?.setAttribute('aria-expanded', 'false');
}
try { if (localStorage.getItem('codex-accounts-sidebar') === 'collapsed' && document.body) document.body.dataset.sidebar = 'collapsed'; } catch {}
window.addEventListener('hashchange', () => { applyView(); closeSidebar(); });
document.addEventListener('click', event => {
 if (event.target.closest('[data-sidebar-close]')) closeSidebar();
 if (event.target.closest('[data-nav]')) closeSidebar();
 if (event.target.closest('[data-sidebar-toggle]')) {
  if (window.matchMedia('(max-width:760px)').matches) {
   const open = document.body.dataset.sidebar !== 'open';
   document.body.dataset.sidebar = open ? 'open' : '';
   document.querySelector('.mobile-menu')?.setAttribute('aria-expanded', String(open));
  } else {
   const collapsed = document.body.dataset.sidebar !== 'collapsed';
   document.body.dataset.sidebar = collapsed ? 'collapsed' : '';
   try { localStorage.setItem('codex-accounts-sidebar', collapsed ? 'collapsed' : 'expanded'); } catch {}
  }
 }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });
applyView();
`;
