// @bun
// src/auto-continue.ts
function quotaFailure(turn) {
  return turn?.status === "failed" && /usage.?limit|usage_limit_reached|quota.{0,30}exceed/i.test(JSON.stringify(turn.error ?? ""));
}
async function interruptedTurns(client) {
  const interrupted = [];
  let cursor;
  do {
    const loaded = await client.call("thread/loaded/list", { cursor });
    for (const threadId of loaded.data) {
      const { thread } = await client.call("thread/read", { threadId });
      if (thread.ephemeral || thread.status.type === "active")
        continue;
      const turns = await client.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
      const last = turns.data?.[0];
      if (thread.status.type !== "active" && quotaFailure(last))
        interrupted.push({ threadId, turnId: last.id });
    }
    cursor = loaded.nextCursor ?? undefined;
  } while (cursor);
  return interrupted;
}
async function continueTurns(client, interrupted, enabled = () => true) {
  let count = 0;
  for (const { threadId, turnId } of interrupted) {
    if (!enabled())
      break;
    const { thread } = await client.call("thread/read", { threadId });
    if (thread.ephemeral || thread.status.type === "active")
      continue;
    const turns = await client.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
    const last = turns.data?.[0];
    if (!enabled() || thread.status.type === "active" || last?.id !== turnId || !quotaFailure(last))
      continue;
    await client.call("turn/start", { threadId, input: [{ type: "text", text: "continue" }] });
    count++;
  }
  return count;
}

// src/panel-navigation.ts
var panelNavigationScript = `
const sections = { accounts: 'Contas', preferences: 'Prefer\xEAncias', session: 'Sess\xE3o' };
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
 document.title = sections[selected] + ' \xB7 Codex';
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

// src/panel-live.ts
var panelLiveScript = `(() => {
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
  if (error.name !== 'AbortError' && status()) status().textContent = 'Reconectando\u2026';
 } finally { busy = false; if (focused() && !stopped) timer = setTimeout(sync, 3000); }
}
function wake() { clearTimeout(timer); events?.close(); events = undefined; if (focused()) { fresh = true; stopped = false;
 events = new EventSource(new URL('events', document.querySelector('[data-panel-base]').href));
 events.onmessage = () => { if (!busy && focused()) { clearTimeout(timer); sync(); } };
 events.onerror = () => { if(status()) status().textContent = 'Reconectando\u2026'; };
 sync(); } else { controller?.abort(); if(status()) status().textContent = 'Pausado'; } }
window.addEventListener('focus', wake); window.addEventListener('blur', wake);
document.addEventListener('visibilitychange', wake);
window.addEventListener('pagehide', () => { stopped = true; events?.close(); clearTimeout(timer); controller?.abort(); });
wake();
})();`;

// src/account-panel.ts
var escape = (value) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function renderAccountPanel(accounts, token, csrf, message, pending, autoSwitch = false, autoContinue = false, resumeAfterReset = false) {
  const fields = (name) => `<input type="hidden" name="csrf" value="${escape(csrf)}">${name === undefined ? "" : `<input type="hidden" name="account" value="${escape(name)}">`}`;
  const action = (path) => `/${encodeURIComponent(token)}/${path}`;
  const windowHtml = (label, value) => {
    const valid = value && Number.isFinite(value.remaining);
    const remaining = valid ? Math.max(0, Math.min(100, value.remaining)) : null;
    const reset = value?.resetsAt ? new Date(value.resetsAt * 1000) : null;
    const date = reset && Number.isFinite(reset.getTime()) ? reset.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;
    let resetText = "Renova\xE7\xE3o n\xE3o informada";
    if (date && reset) {
      const minutes = Math.ceil((reset.getTime() - Date.now()) / 60000);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor(minutes % 1440 / 60);
      const mins = minutes % 60;
      resetText = minutes <= 0 ? "Prazo encerrado \xB7 atualize os limites" : "Reinicia em " + (days > 0 ? days + " dias e " + hours + " h" : hours > 0 ? hours + " h e " + mins + " min" : mins + " min");
    }
    return `<div class="usage-window"><div class="usage-title">${label}</div><div class="usage-label"><span title="${date ? escape(date) + " (Bras\xEDlia)" : ""}">${resetText}</span><strong>${remaining === null ? "Indispon\xEDvel" : remaining.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "% restante"}</strong></div>${remaining === null ? '<div class="usage-empty"></div>' : `<meter min="0" max="100" value="${remaining}" aria-label="${label}: percentual restante">${remaining}%</meter>`}</div>`;
  };
  const usageHtml = (account) => `<section class="plan-limits" aria-label="Limites do plano de ${escape(account.name)}"><h3>Limites do plano</h3><div class="usage-grid">${windowHtml("Limite a cada 5 horas", account.usage?.fiveHour)}${windowHtml("Limite semanal", account.usage?.weekly)}</div></section><div class="usage-meta"><span>${account.usage?.unavailable ? "N\xE3o foi poss\xEDvel consultar. Tente novamente ou reconecte a conta." : account.usage ? "Consultado \xE0s " + new Date(account.usage.updatedAt).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) + " (Bras\xEDlia)" : "Consulte os limites para ver o saldo desta conta."}</span><form method="post" action="${action("limits")}">${fields(account.name)}<button>Atualizar limites</button></form></div>`;
  const icon = (paths) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons = {
    accounts: icon('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M6 16c0-3 6-3 6 0m3-7h3m-3 4h3"/>'),
    preferences: icon('<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--sidebar)"/><circle cx="15" cy="17" r="3" fill="var(--sidebar)"/>'),
    session: icon('<path d="M10 4H5v16h5m4-12 4 4-4 4m-6-4h12"/>'),
    sidebar: icon('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>')
  };
  const currentAccount = accounts.find((account) => account.current);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Contas \xB7 Codex</title>
<style>
:root{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0d0d0d;background:#fff;font-synthesis:none;--muted:#646464;--line:#e8e8e8;--surface:#f7f7f7;--hover:#ededed;--button:#0d0d0d;--button-text:#fff;--danger:#b42318;--notice:#f7f7f7}*{box-sizing:border-box}body{margin:0;font-size:14px;line-height:1.5}button,summary,a{-webkit-tap-highlight-color:transparent}button{font:inherit;cursor:pointer;min-height:40px;border:1px solid var(--line);border-radius:999px;padding:8px 18px;background:transparent;color:inherit;font-weight:500}button:hover{background:var(--hover)}button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #23836a;outline-offset:4px}button:disabled{cursor:default;opacity:.55}.primary{background:var(--button);color:var(--button-text);border-color:var(--button)}.primary:hover{background:var(--muted)}.danger{color:var(--danger)}.topbar{height:72px;padding:0 32px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}.brand{font-size:19px;font-weight:600;letter-spacing:-.5px}.tag{font-size:12px;color:var(--muted);border-left:1px solid var(--line);padding-left:12px}.local{margin-left:auto;color:var(--muted);font-size:12px;display:flex;align-items:center;gap:7px}.dot{width:6px;height:6px;background:#21856b;border-radius:50%}main{max-width:760px;padding:56px 28px 28px;margin:auto}h1{font-size:28px;line-height:1.2;letter-spacing:-.8px;font-weight:600;margin:0 0 12px}h2{font-size:15px;font-weight:600;margin:0}p{margin:0;color:var(--muted)}.intro{max-width:520px;font-size:15px}.notice{background:var(--notice);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-top:24px;overflow-wrap:anywhere}.notice strong{display:block;margin-bottom:4px}.list{margin-top:32px}.list-title{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--line)}.count{color:var(--muted);font-size:12px}.account{padding:20px 0;border-bottom:1px solid var(--line)}.account-main{display:flex;align-items:center;gap:14px}.avatar{width:40px;height:40px;flex-shrink:0;display:grid;place-items:center;background:var(--surface);border:1px solid var(--line);border-radius:50%;font-weight:600;color:var(--muted)}.identity{flex:1;min-width:0}.identity-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}.name{font-weight:600;overflow-wrap:anywhere}.email{color:var(--muted);overflow-wrap:anywhere}.badge{display:inline-block;color:#21856b;font-size:12px;margin-top:4px}.row-action{flex-shrink:0}.remove{margin:10px 0 0 54px}.remove summary{color:var(--muted);cursor:pointer;font-size:12px;min-height:32px;display:flex;align-items:center;width:fit-content}.remove summary:hover{color:var(--danger)}.remove[open] summary{color:var(--danger)}.confirmation{padding:14px 16px;background:var(--surface);border-radius:12px;margin-top:4px}.confirmation p{margin-bottom:12px;font-size:13px}.session{display:flex;align-items:center;gap:24px;margin-top:32px}.session-copy{flex:1}.session-copy p{margin-top:4px;font-size:13px}.session details{flex-shrink:0}.session summary{cursor:pointer;list-style:none;padding:9px 18px;border:1px solid var(--line);border-radius:999px;text-align:center}.session summary::-webkit-details-marker{display:none}.session details[open]{flex:1}.session details[open] summary{width:fit-content}.scope{margin-top:32px;padding:16px 0;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}footer{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:12px;color:var(--muted);font-size:12px}.empty{padding:28px 0}.empty p{margin-bottom:12px}code{font-size:12px;background:var(--surface);padding:5px 8px;border-radius:6px}a{color:inherit;text-decoration:underline;text-underline-offset:3px}
@media(prefers-color-scheme:dark){:root{color:#ececec;background:#212121;--muted:#b4b4b4;--line:#3b3b3b;--surface:#2f2f2f;--hover:#3b3b3b;--button:#ececec;--button-text:#212121;--danger:#ff938a;--notice:#2b2b2b}.badge{color:#7bd5b7}}
@media(max-width:540px){.topbar{padding:0 20px;height:60px}.tag{display:none}main{padding:32px 20px 24px}h1{font-size:25px}.identity-line{display:block}.email{display:block;font-size:13px}.account-main{flex-wrap:wrap;gap:12px}.row-action{margin-left:52px}.remove{margin-left:52px}.session{align-items:flex-start;flex-direction:column;gap:14px}.session details{width:100%}footer{align-items:flex-start;flex-direction:column;gap:12px}}
.avatar{position:relative;overflow:hidden}.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.plan-limits{margin:20px 0 0 54px}.plan-limits h3{font-size:14px;font-weight:500;margin:0 0 10px}.usage-grid{display:grid;grid-template-columns:1fr;gap:22px;padding:14px 16px;border:1px solid var(--line);border-radius:16px}.usage-title{font-size:13px;margin-bottom:4px}.usage-label{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--muted)}.usage-label strong{font-weight:500}.usage-window p{font-size:11px;margin-top:5px}.usage-empty,meter{display:block;width:100%;height:6px;border:0;border-radius:9px;background:var(--line);margin-top:9px}meter::-webkit-meter-bar{background:var(--line);border:0;border-radius:9px}meter::-webkit-meter-optimum-value{background:var(--button);border-radius:9px}meter::-moz-meter-bar{background:var(--button);border-radius:9px}.usage-meta{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:12px 0 0 54px;font-size:11px;color:var(--muted)}.usage-meta button{font-size:12px;padding:6px 12px;min-height:34px}.photo-picker{margin-left:54px;font-size:12px;color:var(--muted)}.photo-picker summary{cursor:pointer;min-height:32px;display:flex;align-items:center;width:fit-content}.photo-picker label{display:block;margin-bottom:8px}.photo-picker input{display:block;max-width:100%;font:inherit;margin:8px 0 14px}.photo-picker button{font-size:12px}.photo-picker p{font-size:12px}@media(max-width:540px){.plan-limits{margin-left:0}.usage-grid{gap:22px}.usage-meta{margin-left:0;align-items:flex-start}.photo-picker{margin-left:52px}.usage-label{flex-wrap:wrap;gap:4px 12px}}@media(max-width:360px){.usage-grid{grid-template-columns:1fr}}
.auto-switch{margin-top:24px;padding:16px;border:1px solid var(--line);border-radius:14px}.auto-switch label{display:flex;gap:10px;align-items:center;font-weight:500}.auto-switch p{font-size:12px;margin:8px 0 12px}.auto-switch input{width:18px;height:18px;accent-color:var(--button)}
:root{--sidebar:#f9f9f9;--selected:#eaeaea}.sidebar{position:fixed;inset:0 auto 0 0;width:260px;background:var(--sidebar);display:flex;flex-direction:column;padding:12px;z-index:30}.sidebar-top{display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 8px 0 12px}.sidebar-brand{font-size:19px;font-weight:600;letter-spacing:-.5px;text-decoration:none}.icon-button{border:0;border-radius:8px;width:40px;min-height:40px;padding:10px;display:grid;place-items:center}.sidebar-caption{font-size:12px;color:var(--muted);padding:30px 12px 10px}.sidebar nav{display:grid;gap:4px}.nav-link{display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;min-height:44px;text-decoration:none;font-size:14px;white-space:nowrap}.nav-link:hover{background:var(--hover)}.nav-link[aria-current="page"]{background:var(--selected);font-weight:500}.sidebar-bottom{margin-top:auto;border-top:1px solid var(--line);padding:16px 10px 6px;display:flex;align-items:center;gap:10px}.sidebar-bottom .avatar{width:32px;height:32px}.sidebar-user{min-width:0;font-size:13px}.sidebar-user strong{display:block;font-weight:500}.sidebar-user small{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px;font-size:11px}.workspace{margin-left:260px;min-height:100dvh}.topbar{height:64px;border:0;padding:0 28px}.topbar .brand{font-size:16px;font-weight:500;letter-spacing:0}.topbar .tag{display:none}.mobile-menu{display:none}.sidebar-close{display:none}main{padding-top:36px;max-width:816px}.config-view{display:none}body:not([data-view]) [data-section="accounts"],body[data-view="accounts"] [data-section="accounts"],body[data-view="preferences"] [data-section="preferences"],body[data-view="session"] [data-section="session"]{display:block}.config-view h1{margin-top:0}.auto-switch{margin-top:28px}.settings-note{margin-top:28px;padding:20px 0;border-top:1px solid var(--line)}.settings-note h2{margin-bottom:8px}.settings-note p{font-size:13px}.backdrop{display:none}body[data-sidebar="collapsed"] .sidebar{width:68px}body[data-sidebar="collapsed"] .workspace{margin-left:68px}body[data-sidebar="collapsed"] .sidebar-brand,body[data-sidebar="collapsed"] .sidebar-caption,body[data-sidebar="collapsed"] .nav-label,body[data-sidebar="collapsed"] .sidebar-user{display:none}body[data-sidebar="collapsed"] .sidebar-top{padding:0;justify-content:center}body[data-sidebar="collapsed"] .nav-link{justify-content:center;padding:12px}body[data-sidebar="collapsed"] .sidebar nav{margin-top:30px}body[data-sidebar="collapsed"] .sidebar-bottom{padding:16px 0 6px;justify-content:center}
@media(prefers-color-scheme:dark){:root{--sidebar:#171717;--selected:#303030}}
@media(max-width:760px){.sidebar,body[data-sidebar="collapsed"] .sidebar{width:260px;transform:translateX(-100%);visibility:hidden}.workspace,body[data-sidebar="collapsed"] .workspace{margin-left:0}.mobile-menu,.sidebar-close{display:grid}.sidebar .desktop-collapse{display:none}.topbar{padding:0 16px;gap:10px}body[data-sidebar="open"] .sidebar{transform:translateX(0);visibility:visible}body[data-sidebar="open"] .backdrop{display:block;position:fixed;inset:0;background:#0008;z-index:25;border:0;border-radius:0;width:100%;height:100%}main{padding-top:24px}body[data-sidebar="collapsed"] .sidebar-brand{display:block}body[data-sidebar="collapsed"] .sidebar-caption{display:block}body[data-sidebar="collapsed"] .nav-label{display:inline}body[data-sidebar="collapsed"] .sidebar-user{display:block}body[data-sidebar="collapsed"] .nav-link{justify-content:flex-start}body[data-sidebar="collapsed"] .sidebar nav{margin-top:0}}
</style></head><body><aside class="sidebar" aria-label="Configura\xE7\xF5es do Codex"><div class="sidebar-top"><a class="sidebar-brand" href="#accounts">Codex</a><button class="icon-button desktop-collapse" data-sidebar-toggle aria-label="Recolher ou expandir sidebar">${icons.sidebar}</button><button class="icon-button sidebar-close" data-sidebar-close aria-label="Fechar menu">\u2715</button></div><div class="sidebar-caption">Configura\xE7\xF5es</div><nav aria-label="Se\xE7\xF5es de configura\xE7\xF5es"><a class="nav-link" href="#accounts" data-nav="accounts" title="Contas" aria-current="page">${icons.accounts}<span class="nav-label">Contas</span></a><a class="nav-link" href="#preferences" data-nav="preferences" title="Prefer\xEAncias">${icons.preferences}<span class="nav-label">Prefer\xEAncias</span></a><a class="nav-link" href="#session" data-nav="session" title="Sess\xE3o">${icons.session}<span class="nav-label">Sess\xE3o</span></a></nav><div class="sidebar-bottom"><span class="avatar" aria-hidden="true">${escape((currentAccount?.email ?? "C").slice(0, 1).toUpperCase())}${currentAccount?.picture ? `<img src="${escape(currentAccount.picture)}" alt="" referrerpolicy="no-referrer">` : ""}</span><div class="sidebar-user"><strong>${escape(currentAccount?.name ?? "Codex Accounts")}</strong><small>${escape(currentAccount?.email ?? "Gerenciador local de contas")}</small></div></div></aside><button class="backdrop" data-sidebar-close aria-label="Fechar menu"></button><div class="workspace"><header class="topbar"><button class="icon-button mobile-menu" data-sidebar-toggle aria-label="Abrir menu de configura\xE7\xF5es" aria-expanded="false">${icons.sidebar}</button><span class="brand" data-section-title>Contas</span><span class="tag">Gerenciar contas</span><span class="local"><span class="dot" aria-hidden="true"></span><span data-live-status>Conectando\u2026</span></span></header><main>

${message && message !== "Contas do Codex" ? `<div class="notice" role="status">${escape(message)}</div>` : ""}
${pending ? `<div class="notice"><strong>Limite de uso atingido</strong><p>Voc\xEA pode trocar de conta para continuar. Depois da troca, volte ao Codex e envie \u201Ccontinue\u201D.</p></div>` : ""}
<section class="config-view" data-section="accounts" aria-label="Contas"><h1>Suas contas</h1><p class="intro">Escolha qual conta usar no Codex. Sua conversa continua de onde parou.</p><section class="list" aria-labelledby="accounts-title"><div class="list-title"><h2 id="accounts-title">Contas salvas</h2><span class="count">${accounts.length} ${accounts.length === 1 ? "conta" : "contas"}</span></div>
${accounts.map((a) => `<article class="account" aria-label="${escape(a.name)}"><div class="account-main"><span class="avatar" aria-hidden="true">${escape((a.email ?? a.name).slice(0, 1).toUpperCase())}${a.picture ? `<img src="${escape(a.picture)}" alt="" referrerpolicy="no-referrer">` : ""}</span><div class="identity"><div class="identity-line"><span class="name">${escape(a.name)}</span><span class="email">${escape(a.email ?? "Email n\xE3o dispon\xEDvel")}</span></div>${a.current ? '<span class="badge">Conta atual</span>' : ""}</div><form class="row-action" method="post" action="${action("switch")}">${fields(a.name)}<button class="${a.current ? "" : "primary"}" aria-label="${escape(`Usar conta ${a.name}`)}" >${a.current ? "Reconectar" : "Usar conta"}</button></form></div>${usageHtml(a)}<details class="photo-picker"><summary>${a.picture ? "Alterar foto" : "Adicionar foto"}</summary><form class="confirmation" method="post" enctype="multipart/form-data" action="${action("photo")}">${fields(a.name)}<label>Foto de ${escape(a.name)}<input type="file" name="photo" accept="image/png,image/jpeg,image/webp" required></label><p>PNG, JPEG ou WebP de at\xE9 2 MB. A foto fica salva neste dispositivo.</p><button>Salvar foto</button></form></details><details class="remove"><summary>Remover conta</summary><form class="confirmation" method="post" action="${action("remove")}">${fields(a.name)}<p>Remover <strong>${escape(a.name)}</strong> deste dispositivo? As credenciais salvas ser\xE3o apagadas. Para usar a conta novamente, cadastre-a de novo.${a.current ? " Fa\xE7a logout ou troque de conta antes de remover." : ""}</p><button class="danger" ${a.current ? "disabled" : ""}>Confirmar remo\xE7\xE3o</button></form></details></article>`).join("") || '<div class="empty"><p>Nenhuma conta salva. Cadastre uma conta pelo terminal para come\xE7ar.</p><code>bun run start add pessoal</code></div>'}
</section><p class="scope">A troca vale para todas as conversas conectadas. Aguarde os turnos em andamento terminarem antes de trocar de conta.</p></section><section class="config-view" data-section="preferences" aria-label="Prefer\xEAncias"><h1>Prefer\xEAncias</h1><p class="intro">Defina como o gerenciador deve cuidar das suas contas.</p><section class="auto-switch"><form method="post" action="${action("settings") + "#preferences"}">${fields()}<label><input type="checkbox" name="autoSwitch" ${autoSwitch ? "checked" : ""}> Trocar de conta automaticamente</label><p>Quando um limite chegar a 100% de uso, troca para uma conta com saldo nos dois limites, sem abrir o painel. Vale para todas as conversas conectadas.</p><label><input type="checkbox" name="autoContinue" ${autoContinue ? "checked" : ""}> Continuar automaticamente ao trocar de conta</label><p>Ap\xF3s o autoswitch, envia \u201Ccontinue\u201D nas conversas interrompidas por limite, mantendo o hist\xF3rico. Requer a troca autom\xE1tica ativada.</p><label><input type="checkbox" name="resumeAfterReset" ${resumeAfterReset ? "checked" : ""}> Continuar ap\xF3s a renova\xE7\xE3o dos limites</label><p>Verifica a cada 30 segundos, inclusive ap\xF3s reset antecipado por token. Continua falhas por limite quando houver saldo nas duas janelas. Requer o backend ativo; independe da troca autom\xE1tica.</p><button>Salvar prefer\xEAncia</button></form></section><div class="settings-note"><h2>Atualiza\xE7\xE3o do painel</h2><p>Os dados s\xE3o atualizados enquanto esta janela est\xE1 em foco. Ao sair, as consultas pausam. Ao voltar, o painel reconecta e busca dados novos.</p></div><div class="settings-note"><h2>Apar\xEAncia</h2><p>O tema acompanha o modo claro ou escuro do seu sistema.</p></div></section><section class="config-view" data-section="session" aria-label="Sess\xE3o"><h1>Sess\xE3o</h1><p class="intro">Gerencie a conex\xE3o do Codex com suas contas salvas.</p><section class="session" aria-labelledby="session-title"><div class="session-copy"><h2 id="session-title">Sess\xE3o do Codex</h2><p>Saia da sess\xE3o sem apagar suas contas salvas.</p></div><details><summary>Sair do Codex</summary><form class="confirmation" method="post" action="${action("logout") + "#session"}">${fields()}<p>Isso encerra a sess\xE3o em todas as conversas conectadas. Voc\xEA poder\xE1 entrar novamente com uma conta salva.</p><button class="danger">Confirmar logout do Codex</button></form></details></section>
<p class="scope">Sair afeta todas as conversas conectadas a esta sess\xE3o. O hist\xF3rico e as contas salvas permanecem neste dispositivo.</p></section><footer><span>Nenhuma mensagem \xE9 reenviada automaticamente.</span>${pending ? `<form method="post" action="${action("cancel")}">${fields()}<button>Manter conta atual</button></form>` : `<a data-panel-base href="${action("")}">Atualizar painel</a>`}</footer><a data-panel-base href="${action("")}" hidden>In\xEDcio</a></main></div><script src="${action("live.js")}" defer></script></body></html>`;
}

// src/account-details.ts
function parseUsage(response) {
  const bucket = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary];
  const window = (minutes) => {
    const value = windows.find((w) => w?.windowDurationMins === minutes);
    if (!value || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent))
      return null;
    return { remaining: Math.max(0, Math.min(100, 100 - value.usedPercent)), resetsAt: typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null };
  };
  return { fiveHour: window(300), weekly: window(10080), updatedAt: Date.now() };
}
function profilePicture(raw) {
  try {
    const auth = JSON.parse(raw);
    const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString());
    const url = new URL(claims.picture);
    const host = url.hostname;
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null;
    if (host === "lh3.googleusercontent.com" || host.endsWith(".googleusercontent.com") || host === "cdn.auth0.com" || host.endsWith(".oaistatic.com") || host === "cdn.openai.com")
      return url.href;
  } catch {}
  return null;
}
function photoType(bytes) {
  if (bytes.length >= 8 && Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString() === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString() === "WEBP")
    return "image/webp";
  return null;
}

// src/native-backend.ts
import { chmod as chmod3, rename as rename2, rm as rm2, writeFile as writeFile2 } from "fs/promises";

// src/store.ts
import { mkdir, chmod, readFile, rename, writeFile, readdir, rm, lstat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";

class Store {
  root;
  constructor(root = process.env.CODEX_ACCOUNTS_HOME ?? join(homedir(), ".local/share/codex-accounts")) {
    this.root = resolve(root);
  }
  account(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
      throw new Error("Nome inv\xE1lido: use letras, n\xFAmeros, _ e - (at\xE9 64 caracteres).");
    return join(this.root, "accounts", name);
  }
  async init() {
    for (const path of [this.root, join(this.root, "accounts")]) {
      await mkdir(path, { recursive: true, mode: 448 });
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("Diret\xF3rio de dados n\xE3o pode ser symlink.");
      await chmod(path, 448);
    }
  }
  async lock() {
    await this.init();
    const path = join(this.root, "lock");
    try {
      await mkdir(path, { mode: 448 });
    } catch {
      throw new Error(`Outro codex-accounts est\xE1 usando estes dados. Se houve uma queda, confirme que n\xE3o est\xE1 rodando antes de remover ${path}.`);
    }
    await writeFile(join(path, "pid"), String(process.pid), { mode: 384 });
    return async () => {
      await rm(path, { recursive: true });
    };
  }
  async names() {
    const names = await readdir(join(this.root, "accounts"), { withFileTypes: true });
    const valid = [];
    for (const entry of names) {
      if (!entry.isDirectory())
        continue;
      try {
        await this.auth(this.account(entry.name));
        valid.push(entry.name);
      } catch {}
    }
    return valid.sort();
  }
  async remove(name) {
    const home = this.account(name);
    const entry = await lstat(home).catch((e) => {
      if (e.code === "ENOENT")
        throw new Error(`Conta ${name} n\xE3o cadastrada.`);
      throw e;
    });
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Diret\xF3rio de conta inv\xE1lido.");
    await rm(home, { recursive: true });
  }
  async auth(home) {
    const path = join(home, "auth.json");
    if (!(await lstat(path)).isFile())
      throw new Error("Cache de autentica\xE7\xE3o inv\xE1lido.");
    const raw = await readFile(path, "utf8");
    let auth;
    try {
      auth = JSON.parse(raw);
    } catch {
      throw new Error("Cache de autentica\xE7\xE3o inv\xE1lido.");
    }
    if (auth.auth_mode !== "chatgpt" || !auth.tokens?.refresh_token || !auth.tokens?.access_token) {
      throw new Error("\xC9 necess\xE1rio um login ChatGPT v\xE1lido, feito pelo fluxo oficial.");
    }
    return raw;
  }
  async saveAuth(home, raw) {
    await mkdir(home, { recursive: true, mode: 448 });
    await chmod(home, 448);
    const temp = join(home, `.auth-${crypto.randomUUID()}.tmp`);
    await writeFile(temp, raw, { mode: 384, flag: "wx" });
    await rename(temp, join(home, "auth.json"));
  }
}

// src/rpc.ts
import WebSocket from "ws";

class RpcPeer {
  seq = 0;
  pending = new Map;
  onNotification = () => {};
  onRequest = async () => {
    return;
  };
  disconnected() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Conex\xE3o com Codex encerrada."));
    }
    this.pending.clear();
  }
  call(method, params = {}, timeout = 15000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout RPC: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.send({ id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Conex\xE3o com Codex indispon\xEDvel."));
      }
    });
  }
  async initialize(experimental = false) {
    await this.call("initialize", { clientInfo: { name: "codex_accounts", version: "0.2.0" }, capabilities: { experimentalApi: experimental } });
    this.send({ method: "initialized", params: {} });
  }
  receive(msg) {
    if (msg.method && msg.id !== undefined) {
      this.onRequest(msg).then((result) => {
        if (result !== undefined)
          this.send({ id: msg.id, result });
      }, () => this.send({ id: msg.id, error: { code: -32603, message: "Local account backend failed" } })).catch(() => {});
    } else if (msg.method)
      this.onNotification(msg);
    else {
      const p = this.pending.get(msg.id);
      if (!p)
        return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(new Error(`RPC rejeitada: ${p.method} (${msg.error.code}).`));
      else
        p.resolve(msg.result);
    }
  }
}

class Rpc extends RpcPeer {
  proc;
  done;
  constructor(binary, args, env) {
    super();
    this.proc = Bun.spawn([binary, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.done = this.read().catch(() => {}).finally(() => this.disconnected());
  }
  send(message) {
    this.proc.stdin.write(JSON.stringify(message) + `
`);
    this.proc.stdin.flush();
  }
  async read() {
    let buffer = "";
    for await (const chunk of this.proc.stdout.pipeThrough(new TextDecoderStream)) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf(`
`)) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim())
          continue;
        this.receive(JSON.parse(line));
      }
    }
  }
  async close() {
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill("SIGKILL"), 2000);
    try {
      await this.proc.exited;
      await this.done;
    } finally {
      clearTimeout(timer);
    }
  }
}

class UnixRpc extends RpcPeer {
  socket;
  ready;
  constructor(socketPath) {
    super();
    this.socket = new WebSocket(`ws+unix:${socketPath}:/`, { handshakeTimeout: 3000, perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () => reject(new Error("Daemon oficial indispon\xEDvel. Inicie codex app-server daemon start e reabra o Codex.")));
    });
    this.ready.catch(() => {});
    this.socket.on("message", (raw) => {
      try {
        this.receive(JSON.parse(String(raw)));
      } catch {
        this.socket.terminate();
      }
    });
    this.socket.on("close", () => this.disconnected());
  }
  get closed() {
    return this.socket.readyState === WebSocket.CLOSED;
  }
  send(message) {
    this.socket.send(JSON.stringify(message));
  }
  async initialize(experimental = false) {
    await this.ready;
    await super.initialize(experimental);
  }
  async close() {
    this.socket.terminate();
    this.disconnected();
  }
}

// src/native-backend.ts
import { join as join3 } from "path";

// src/native-paths.ts
import { createHash } from "crypto";
import { homedir as homedir2, tmpdir } from "os";
import { join as join2, resolve as resolve2 } from "path";
import { mkdir as mkdir2, lstat as lstat2, chmod as chmod2 } from "fs/promises";
var codexHome = resolve2(process.env.CODEX_HOME ?? join2(homedir2(), ".codex"));
var binary = process.env.CODEX_ACCOUNTS_CODEX ?? "codex";
var serviceDir = join2(tmpdir(), `codex-accounts-${process.getuid?.() ?? "user"}-${createHash("sha256").update(codexHome).digest("hex").slice(0, 12)}`);
var socketPath = join2(serviceDir, "backend.sock");
var endpointPath = join2(serviceDir, "endpoint.json");
async function privateServiceDir() {
  await mkdir2(serviceDir, { recursive: true, mode: 448 });
  const s = await lstat2(serviceDir);
  if (!s.isDirectory() || s.isSymbolicLink() || process.getuid && s.uid !== process.getuid())
    throw new Error("Diret\xF3rio IPC inseguro.");
  await chmod2(serviceDir, 448);
}
function identity(raw) {
  try {
    const a = JSON.parse(raw);
    const t = a.tokens;
    const claims = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString());
    const access = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url").toString());
    const accountId = t.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId)
      throw new Error;
    return { accountId, accessToken: t.access_token, plan: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null, expires: Number(access.exp ?? 0) };
  } catch {
    throw new Error("Credenciais ChatGPT sem identidade v\xE1lida.");
  }
}

// src/native-backend.ts
async function serveNative() {
  await privateServiceDir();
  const store = new Store;
  await store.init();
  let rpc;
  let active;
  let pending;
  let lastMessage = "Contas do Codex";
  let connection;
  let switching = false;
  const usage = new Map;
  const settingsPath = join3(store.root, "settings.json");
  const settings = await Bun.file(settingsPath).json().catch(() => ({}));
  let autoSwitch = settings.autoSwitch === true;
  let autoContinue = settings.autoContinue === true;
  let resumeAfterReset = settings.resumeAfterReset === true;
  const claimsPath = join3(store.root, "reset-continuation-claims.json");
  const resetClaims = new Set(await Bun.file(claimsPath).json().catch(() => []));
  async function claimResetTurn(key) {
    resetClaims.add(key);
    const temp = `${claimsPath}.tmp`;
    await writeFile2(temp, JSON.stringify([...resetClaims]), { mode: 384 });
    await rename2(temp, claimsPath);
  }
  let monitoring = false;
  let monitorTimer;
  let lastExternalRead = 0;
  let externalDirty = true;
  const listeners = new Set;
  const encoder = new TextEncoder;
  function publish() {
    for (const listener of listeners) {
      try {
        listener.enqueue(encoder.encode(`data: update

`));
      } catch {
        listeners.delete(listener);
      }
    }
  }
  let refreshWork;
  async function currentName() {
    try {
      const id = identity(await store.auth(codexHome)).accountId;
      for (const name of await store.names())
        if (identity(await store.auth(store.account(name))).accountId === id)
          return name;
    } catch {}
    return;
  }
  async function refreshAll(force = false, signal) {
    if (refreshWork)
      return refreshWork;
    if (!force && !externalDirty && Date.now() - lastExternalRead < 30000)
      return;
    refreshWork = (async () => {
      if (switching)
        return;
      externalDirty = false;
      for (const name of await store.names()) {
        if (switching || signal?.aborted) {
          externalDirty = true;
          return;
        }
        await readUsage(name);
      }
      lastExternalRead = Date.now();
      externalDirty = false;
    })().finally(() => {
      refreshWork = undefined;
    });
    return refreshWork;
  }
  function scheduleMonitor(delay = 300) {
    externalDirty = true;
    if (monitorTimer)
      return;
    monitorTimer = setTimeout(() => {
      monitorTimer = undefined;
      monitor().catch(() => {
        externalDirty = true;
        lastMessage = "N\xE3o foi poss\xEDvel verificar a troca autom\xE1tica. Tente atualizar os limites.";
        publish();
      });
    }, delay);
  }
  async function monitor() {
    if (monitoring)
      return;
    monitoring = true;
    try {
      if (switching) {
        scheduleMonitor(1500);
        return;
      }
      const name = await currentName();
      if (!name)
        return;
      await readUsage(name);
      const snapshot = usage.get(name);
      const exhausted = snapshot?.fiveHour?.remaining === 0 || snapshot?.weekly?.remaining === 0;
      if (resumeAfterReset && !snapshot?.unavailable && snapshot?.fiveHour && snapshot.weekly && snapshot.fiveHour.remaining > 0 && snapshot.weekly.remaining > 0) {
        const client = await connect();
        const interrupted = await interruptedTurns(client);
        for (const turn of interrupted) {
          if (!resumeAfterReset)
            break;
          const key = JSON.stringify([turn.threadId, turn.turnId]);
          if (resetClaims.has(key))
            continue;
          await claimResetTurn(key);
          try {
            const count = await continueTurns(client, [turn], () => resumeAfterReset);
            if (count)
              lastMessage = "Limites dispon\xEDveis. Continua\xE7\xE3o enviada na mesma conversa.";
          } catch {
            lastMessage = "N\xE3o foi poss\xEDvel confirmar a continua\xE7\xE3o ap\xF3s reset. Verifique o Codex; o envio n\xE3o ser\xE1 repetido.";
          }
        }
        pending = undefined;
        publish();
        return;
      }
      if (!exhausted && !pending)
        return;
      if (!autoSwitch) {
        if (!pending) {
          pending = { threadId: "limits", reason: "usageLimitExceeded" };
          if (!resumeAfterReset)
            openPanel();
        }
        if (resumeAfterReset) {
          lastMessage = "Aguardando saldo nos limites de 5 horas e semanal para continuar.";
          publish();
        }
        return;
      }
      try {
        await ensureIdle(await connect());
      } catch {
        scheduleMonitor(1500);
        return;
      }
      const currentId = identity(await store.auth(store.account(name))).accountId;
      let switchError;
      for (const candidate of await store.names()) {
        if (!autoSwitch)
          return;
        if (identity(await store.auth(store.account(candidate))).accountId === currentId)
          continue;
        await readUsage(candidate);
        const next = usage.get(candidate);
        if (!next || next.unavailable || !next.fiveHour || !next.weekly || next.fiveHour.remaining <= 0 || next.weekly.remaining <= 0)
          continue;
        try {
          if (!autoSwitch)
            return;
          const client = await connect();
          const interrupted = autoContinue ? await interruptedTurns(client) : [];
          await switchAccount(candidate);
          lastMessage = "Troca autom\xE1tica para " + candidate + ". Volte ao Codex e envie continue.";
          if (autoContinue && interrupted.length) {
            try {
              const count = await continueTurns(client, interrupted, () => autoContinue && autoSwitch);
              lastMessage = count ? `Troca autom\xE1tica para ${candidate}. Continua\xE7\xE3o enviada na mesma conversa.` : `Troca autom\xE1tica para ${candidate}. A conversa j\xE1 mudou; nenhuma continua\xE7\xE3o enviada.`;
            } catch {
              lastMessage = `Troca autom\xE1tica para ${candidate} conclu\xEDda, mas n\xE3o foi poss\xEDvel confirmar a continua\xE7\xE3o. Verifique o Codex antes de enviar continue.`;
            }
          }
          publish();
          return;
        } catch (e) {
          switchError = e instanceof Error ? e.message : "Troca n\xE3o conclu\xEDda.";
        }
      }
      lastMessage = switchError ? `N\xE3o foi poss\xEDvel concluir a troca autom\xE1tica: ${switchError}` : "Nenhuma outra conta com saldo confirmado nos dois limites. Atualize os logins ou aguarde a renova\xE7\xE3o.";
      if (!pending)
        pending = { threadId: "limits", reason: "usageLimitExceeded" };
    } finally {
      monitoring = false;
    }
  }
  async function readUsage(name) {
    store.account(name);
    if (switching)
      throw new Error("Troca ou renova\xE7\xE3o em andamento. Tente novamente.");
    switching = true;
    const unlock = await store.lock().catch((e) => {
      switching = false;
      throw e;
    });
    let helper;
    try {
      const raw = await store.auth(store.account(name));
      const selected = identity(raw);
      let currentId;
      try {
        currentId = identity(await store.auth(codexHome)).accountId;
      } catch {}
      let result;
      if (selected.accountId === currentId) {
        const client = await connect();
        const current = await client.call("account/read", { refreshToken: false });
        if (current.account?.type !== "chatgpt")
          throw new Error("Conta desconectada.");
        result = await client.call("account/rateLimits/read", {}, 8000);
      } else {
        const home = store.account(name);
        helper = new Rpc(binary, ["app-server", "-c", 'cli_auth_credentials_store="file"'], {
          ...process.env,
          CODEX_HOME: home,
          CODEX_SQLITE_HOME: home,
          OPENAI_API_KEY: "",
          CODEX_ACCESS_TOKEN: ""
        });
        await helper.initialize();
        result = await helper.call("account/rateLimits/read", {}, 8000);
      }
      if (result.accountId && result.accountId !== selected.accountId)
        throw new Error("Identidade dos limites divergente.");
      usage.set(name, parseUsage(result));
    } catch {
      usage.set(name, { fiveHour: null, weekly: null, updatedAt: Date.now(), unavailable: true });
    } finally {
      await helper?.close();
      switching = false;
      await unlock();
    }
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  const csrf = crypto.randomUUID();
  async function connect() {
    if (rpc && !rpc.closed)
      return rpc;
    if (connection)
      return connection;
    connection = (async () => {
      const next = new UnixRpc(join3(codexHome, "app-server-control", "app-server-control.sock"));
      next.onNotification = (msg) => {
        if (["account/rateLimits/updated", "account/updated", "turn/completed", "thread/status/changed"].includes(msg.method)) {
          externalDirty = true;
          publish();
          if (!monitoring && !refreshWork && (autoSwitch || resumeAfterReset || pending))
            scheduleMonitor();
        }
      };
      next.onRequest = async (msg) => {
        if (msg.method !== "account/chatgptAuthTokens/refresh")
          return;
        if (!active || switching)
          throw new Error("Refresh indispon\xEDvel.");
        switching = true;
        const unlock = await store.lock().catch((e) => {
          switching = false;
          throw e;
        });
        try {
          const previous = identity(await store.auth(store.account(active)));
          if (msg.params.previousAccountId && previous.accountId !== msg.params.previousAccountId)
            throw new Error("Conta mudou durante refresh.");
          const raw = await refresh(active);
          const fresh = identity(raw);
          if (fresh.accountId !== previous.accountId)
            throw new Error("Refresh mudou a identidade.");
          await store.saveAuth(codexHome, raw);
          return { accessToken: fresh.accessToken, chatgptAccountId: fresh.accountId, chatgptPlanType: fresh.plan };
        } finally {
          switching = false;
          await unlock();
        }
      };
      try {
        await next.initialize(true);
        rpc = next;
        return next;
      } catch (e) {
        await next.close();
        throw e;
      }
    })().finally(() => {
      connection = undefined;
    });
    return connection;
  }
  async function refresh(name) {
    const home = store.account(name);
    const helper = new Rpc(binary, ["app-server", "-c", 'cli_auth_credentials_store="file"'], {
      ...process.env,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: home,
      OPENAI_API_KEY: "",
      CODEX_ACCESS_TOKEN: ""
    });
    try {
      await helper.initialize();
      await helper.call("account/read", { refreshToken: true }, 8000);
    } finally {
      await helper.close();
    }
    const raw = await store.auth(home);
    if (identity(raw).expires < Date.now() / 1000 + 30)
      throw new Error("Login expirado. Cadastre novamente esta conta.");
    return raw;
  }
  async function ensureIdle(client) {
    let cursor;
    do {
      const loaded = await client.call("thread/loaded/list", { cursor });
      for (const id of loaded.data) {
        const result = await client.call("thread/read", { threadId: id });
        if (result.thread.status.type === "active")
          throw new Error("Aguarde todos os turnos terminarem antes de trocar a conta.");
      }
      cursor = loaded.nextCursor ?? undefined;
    } while (cursor);
  }
  async function switchAccount(name) {
    if (switching)
      throw new Error("Troca j\xE1 em andamento.");
    switching = true;
    const unlock = await store.lock().catch((e) => {
      switching = false;
      throw e;
    });
    try {
      const client = await connect();
      await ensureIdle(client);
      const config = await client.call("config/read", { includeLayers: false });
      if (config.config.cli_auth_credentials_store !== "file")
        throw new Error('Este prot\xF3tipo requer cli_auth_credentials_store = "file" no config.toml e login oficial nesse modo.');
      const account = await client.call("account/read", { refreshToken: false });
      if (account.account && account.account.type !== "chatgpt")
        throw new Error("A sess\xE3o precisa usar autentica\xE7\xE3o ChatGPT.");
      let nextRaw = await store.auth(store.account(name));
      if (identity(nextRaw).expires < Date.now() / 1000 + 120)
        nextRaw = await refresh(name);
      const next = identity(nextRaw);
      const previousRaw = account.account ? await store.auth(codexHome) : undefined;
      if (previousRaw) {
        const previous = identity(previousRaw);
        let previousName;
        for (const n of await store.names())
          if (identity(await store.auth(store.account(n))).accountId === previous.accountId)
            previousName = n;
        if (!previousName)
          previousName = `previous-${Date.now()}`;
        await store.saveAuth(store.account(previousName), previousRaw);
      }
      await store.saveAuth(codexHome, nextRaw);
      try {
        await client.call("account/login/start", { type: "chatgptAuthTokens", accessToken: next.accessToken, chatgptAccountId: next.accountId, chatgptPlanType: next.plan });
      } catch (e) {
        if (previousRaw)
          await store.saveAuth(codexHome, previousRaw);
        else
          await rm2(join3(codexHome, "auth.json"), { force: true });
        throw e;
      }
      active = name;
      lastMessage = `Conta alterada para ${name}. Volte ao Codex e envie continue. O hist\xF3rico permanece na mesma conversa.`;
      pending = undefined;
    } finally {
      switching = false;
      await unlock();
    }
  }
  async function removeAccount(name) {
    const home = store.account(name);
    if (switching)
      throw new Error("Troca ou renova\xE7\xE3o em andamento. Tente novamente.");
    switching = true;
    const unlock = await store.lock().catch((e) => {
      switching = false;
      throw e;
    });
    try {
      if (!(await store.names()).includes(name))
        throw new Error(`Conta ${name} n\xE3o cadastrada.`);
      const currentRaw = await store.auth(codexHome).catch((e) => {
        if (e.code === "ENOENT")
          return;
        throw e;
      });
      if (active === name || currentRaw && identity(currentRaw).accountId === identity(await store.auth(home)).accountId) {
        throw new Error("Esta conta est\xE1 em uso. Fa\xE7a logout ou troque para outra conta antes de remov\xEA-la.");
      }
      await store.remove(name);
      usage.delete(name);
      lastMessage = `Conta ${name} removida deste dispositivo. Para us\xE1-la novamente, fa\xE7a um novo cadastro.`;
    } finally {
      switching = false;
      await unlock();
    }
  }
  async function logout() {
    if (switching)
      throw new Error("Troca j\xE1 em andamento.");
    switching = true;
    const unlock = await store.lock().catch((e) => {
      switching = false;
      throw e;
    });
    try {
      const client = await connect();
      await ensureIdle(client);
      await client.call("account/logout");
      active = undefined;
      pending = undefined;
      lastMessage = "Logout conclu\xEDdo. As contas cadastradas continuam salvas; selecione uma para entrar novamente.";
    } finally {
      switching = false;
      await unlock();
    }
  }
  function openPanel() {
    if (process.env.CODEX_ACCOUNTS_NO_BROWSER === "1")
      return;
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    try {
      const p = Bun.spawn([opener, panelUrl], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      p.unref();
    } catch {}
  }
  async function panel() {
    const names = await store.names();
    let currentId;
    try {
      currentId = identity(await store.auth(codexHome)).accountId;
    } catch {}
    const accounts = await Promise.all(names.map(async (name) => {
      const raw = await store.auth(store.account(name));
      let email = null;
      try {
        const auth = JSON.parse(raw);
        const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString());
        if (typeof claims.email === "string" && claims.email.trim())
          email = claims.email;
      } catch {}
      const photo = Bun.file(join3(store.account(name), "profile-image"));
      return {
        name,
        email,
        current: name === active || identity(raw).accountId === currentId,
        picture: await photo.exists() ? `/${token}/photo?account=${encodeURIComponent(name)}` : profilePicture(raw),
        usage: usage.get(name)
      };
    }));
    return renderAccountPanel(accounts, token, csrf, lastMessage, Boolean(pending), autoSwitch, autoContinue, resumeAfterReset);
  }
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 3 * 1024 * 1024, async fetch(req) {
    const url = new URL(req.url);
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' https://*.googleusercontent.com https://cdn.auth0.com https://*.oaistatic.com https://cdn.openai.com; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" };
    if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith(`/${token}/`))
      return new Response("Not found", { status: 404 });
    if (req.method === "GET" && url.pathname === `/${token}/events`) {
      let listener;
      const stream = new ReadableStream({
        start(controller) {
          listener = controller;
          listeners.add(controller);
          controller.enqueue(encoder.encode(`data: connected

`));
        },
        cancel() {
          listeners.delete(listener);
        }
      });
      req.signal.addEventListener("abort", () => {
        listeners.delete(listener);
        try {
          listener.close();
        } catch {}
      }, { once: true });
      return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream", connection: "keep-alive" } });
    }
    if (req.method === "GET" && url.pathname === `/${token}/live.js`)
      return new Response(panelLiveScript, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
    if (req.method === "GET" && url.pathname === `/${token}/live`) {
      await refreshAll(url.searchParams.get("fresh") === "1", req.signal);
      return new Response(await panel(), { headers });
    }
    if (req.method === "GET" && url.pathname === `/${token}/photo`) {
      try {
        const file = Bun.file(join3(store.account(url.searchParams.get("account") ?? ""), "profile-image"));
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = photoType(bytes);
        if (!type)
          throw new Error;
        return new Response(bytes, { headers: { ...headers, "content-type": type, "x-content-type-options": "nosniff" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    if (req.method === "POST") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin)
        return new Response("Forbidden", { status: 403 });
      const form = await req.formData();
      if (form.get("csrf") !== csrf)
        return new Response("Forbidden", { status: 403 });
      try {
        if (url.pathname === `/${token}/settings`) {
          const unlock = await store.lock();
          try {
            const enabled = form.get("autoSwitch") === "on";
            const temp = `${settingsPath}.tmp`;
            await writeFile2(temp, JSON.stringify({ autoSwitch: enabled, autoContinue: form.get("autoContinue") === "on", resumeAfterReset: form.get("resumeAfterReset") === "on" }), { mode: 384 });
            await rename2(temp, settingsPath);
            resumeAfterReset = form.get("resumeAfterReset") === "on";
            autoSwitch = enabled;
            autoContinue = form.get("autoContinue") === "on";
          } finally {
            await unlock();
          }
          lastMessage = autoSwitch ? "Troca autom\xE1tica ativada. A troca afeta todas as conversas conectadas." : "Troca autom\xE1tica desativada.";
          if (autoSwitch || resumeAfterReset)
            scheduleMonitor();
        } else if (url.pathname === `/${token}/switch`)
          await switchAccount(String(form.get("account")));
        else if (url.pathname === `/${token}/logout`)
          await logout();
        else if (url.pathname === `/${token}/remove`)
          await removeAccount(String(form.get("account")));
        else if (url.pathname === `/${token}/limits`)
          await readUsage(String(form.get("account")));
        else if (url.pathname === `/${token}/photo`) {
          const name = String(form.get("account"));
          const home = store.account(name);
          const file = form.get("photo");
          if (!(file instanceof File) || file.size > 2 * 1024 * 1024 || file.size === 0)
            throw new Error("Escolha uma foto PNG, JPEG ou WebP de at\xE9 2 MB.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!photoType(bytes))
            throw new Error("Formato inv\xE1lido. Use PNG, JPEG ou WebP.");
          const unlock = await store.lock();
          try {
            if (!(await store.names()).includes(name))
              throw new Error("Conta n\xE3o cadastrada.");
            await writeFile2(join3(home, "profile-image"), bytes, { mode: 384 });
          } finally {
            await unlock();
          }
          lastMessage = `Foto de ${name} atualizada neste dispositivo.`;
        } else if (url.pathname === `/${token}/cancel`) {
          pending = undefined;
          lastMessage = "Troca cancelada. A conta atual foi mantida.";
        } else
          return new Response("Not found", { status: 404 });
      } catch (e) {
        lastMessage = e instanceof Error ? e.message : "Troca n\xE3o conclu\xEDda.";
      }
      publish();
    } else if (req.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    return new Response(await panel(), { headers });
  } });
  const panelUrl = `http://127.0.0.1:${web.port}/${token}/`;
  let ipc;
  try {
    ipc = Bun.serve({ unix: socketPath, async fetch(req) {
      if (req.method === "GET") {
        const current = await currentName();
        return Response.json({
          url: panelUrl,
          active: active ?? null,
          pending: pending ?? null,
          switching,
          autoSwitch,
          autoContinue,
          resumeAfterReset,
          message: lastMessage,
          accounts: (await store.names()).map((name) => ({ name, current: name === current, usage: usage.get(name) }))
        });
      }
      if (req.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      const event = await req.json();
      if (["usage", "switch", "resume-after-reset", "settings"].includes(event.action)) {
        try {
          if (event.action === "usage") {
            const names = event.account === undefined ? await store.names() : [String(event.account)];
            const saved = await store.names();
            for (const name of names) {
              if (!saved.includes(name))
                throw new Error("Account not registered.");
              await readUsage(name);
            }
            const current = await currentName();
            return Response.json({ accounts: names.map((name) => ({ name, current: name === current, usage: usage.get(name) })) });
          }
          if (event.action === "switch")
            await switchAccount(String(event.account));
          else {
            const next = { autoSwitch, autoContinue, resumeAfterReset };
            if (event.action === "resume-after-reset") {
              if (typeof event.enabled !== "boolean")
                throw new Error("Expected enabled boolean.");
              next.resumeAfterReset = event.enabled;
            } else {
              for (const key of ["autoSwitch", "autoContinue", "resumeAfterReset"]) {
                if (event[key] === undefined)
                  continue;
                if (typeof event[key] !== "boolean")
                  throw new Error(`Expected ${key} boolean.`);
                next[key] = event[key];
              }
            }
            const unlock = await store.lock();
            try {
              const temp = `${settingsPath}.tmp`;
              await writeFile2(temp, JSON.stringify(next), { mode: 384 });
              await rename2(temp, settingsPath);
              ({ autoSwitch, autoContinue, resumeAfterReset } = next);
            } finally {
              await unlock();
            }
            lastMessage = event.action === "settings" ? "Preferences saved." : `Quota-reset continuation ${resumeAfterReset ? "enabled" : "disabled"}.`;
            if (autoSwitch || resumeAfterReset)
              scheduleMonitor();
          }
          publish();
          return Response.json({ message: lastMessage });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "Operation failed." }, { status: 409 });
        }
      }
      if (event.action === "remove") {
        try {
          await removeAccount(String(event.account));
          return Response.json({ message: lastMessage });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "Remo\xE7\xE3o n\xE3o conclu\xEDda." }, { status: 409 });
        }
      }
      if (event.action === "logout") {
        try {
          await logout();
          return Response.json({ message: lastMessage });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "Logout n\xE3o conclu\xEDdo." }, { status: 409 });
        }
      }
      if (event.action === "shutdown") {
        setTimeout(() => {
          close();
        }, 100);
        return Response.json({ stopped: true });
      }
      if (["SessionStart", "PostModelRequest", "Stop", "Interrupt"].includes(event.hook_event_name)) {
        externalDirty = true;
        publish();
        if (event.hook_event_name === "PostModelRequest" && event.status === "failed" && /usage.?limit|usage_limit_reached|quota.{0,30}exceed/i.test(event.error ?? "")) {
          const alreadyPending = Boolean(pending);
          pending = { threadId: event.session_id, reason: "usageLimitExceeded" };
          if (!autoSwitch && !resumeAfterReset && !alreadyPending)
            openPanel();
        }
        if (autoSwitch || resumeAfterReset || event.hook_event_name === "SessionStart")
          scheduleMonitor();
        connect().catch(() => {});
      }
      return Response.json({});
    } });
  } catch (e) {
    web.stop(true);
    throw e;
  }
  await chmod3(socketPath, 384);
  await writeFile2(endpointPath, JSON.stringify({ url: panelUrl, pid: process.pid }), { mode: 384 });
  const resetTimer = setInterval(() => {
    if (resumeAfterReset && !monitoring)
      scheduleMonitor(0);
  }, 30000);
  if (resumeAfterReset)
    scheduleMonitor();
  const refreshTimer = setInterval(() => {
    if (!active || switching)
      return;
    if (!rpc || rpc.closed) {
      active = undefined;
      return;
    }
    const name = active;
    switching = true;
    (async () => {
      const unlock = await store.lock();
      try {
        const auth = identity(await store.auth(store.account(name)));
        if (auth.expires < Date.now() / 1000 + 180) {
          const raw = await refresh(name);
          const fresh = identity(raw);
          if (fresh.accountId !== auth.accountId)
            throw new Error("Refresh mudou a identidade.");
          const client = await connect();
          await ensureIdle(client);
          await client.call("account/login/start", { type: "chatgptAuthTokens", accessToken: fresh.accessToken, chatgptAccountId: fresh.accountId, chatgptPlanType: fresh.plan });
          await store.saveAuth(codexHome, raw);
        }
      } finally {
        await unlock();
      }
    })().catch(() => {
      lastMessage = "N\xE3o foi poss\xEDvel renovar o login. Cadastre novamente a conta pelo fluxo oficial.";
    }).finally(() => {
      switching = false;
    });
  }, 60000);
  async function close() {
    if (monitorTimer)
      clearTimeout(monitorTimer);
    for (const listener of listeners) {
      try {
        listener.close();
      } catch {}
    }
    listeners.clear();
    clearInterval(resetTimer);
    clearInterval(refreshTimer);
    ipc.stop(true);
    web.stop(true);
    await rpc?.close();
    await rm2(endpointPath, { force: true });
    await rm2(socketPath, { force: true });
  }
  return { panelUrl, close };
}
if (import.meta.main)
  serveNative().then((service) => {
    const exit = () => {
      service.close().finally(() => process.exit(0));
    };
    process.once("SIGTERM", exit);
    process.once("SIGINT", exit);
  }).catch(() => {
    process.exitCode = 1;
  });
export {
  serveNative
};
