import { interruptedTurns, continueTurns } from "./auto-continue";
import { panelLiveScript } from "./panel-live";
import { renderAccountPanel } from "./account-panel";
import { parseUsage, profilePicture, photoType, type AccountUsage } from "./account-details";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { Store } from "./store";
import { Rpc, UnixRpc } from "./rpc";
import { join } from "node:path";
import { binary, codexHome, endpointPath, identity, privateServiceDir, socketPath } from "./native-paths";

export async function serveNative() {
  await privateServiceDir();
  // Bind first: a second worker cannot replace the live worker's socket.
  const store = new Store(); await store.init();
  let rpc: UnixRpc | undefined;
  let active: string | undefined;
  let pending: { threadId: string; reason: string } | undefined;
  let lastMessage = "Contas do Codex";
  let connection: Promise<UnixRpc> | undefined;
  let switching = false;
  const usage = new Map<string, AccountUsage>();
  const settingsPath = join(store.root, "settings.json");
  const settings = await Bun.file(settingsPath).json().catch(() => ({}));
  let autoSwitch = settings.autoSwitch === true;
  let autoContinue = settings.autoContinue === true;
  let resumeAfterReset = settings.resumeAfterReset === true;
  // Keep a durable claim before submission: a timeout/restart must not duplicate a turn.
  const claimsPath = join(store.root, "reset-continuation-claims.json");
  const resetClaims = new Set<string>(await Bun.file(claimsPath).json().catch(() => []));
  async function claimResetTurn(key: string) {
    resetClaims.add(key);
    const temp = `${claimsPath}.tmp`;
    await writeFile(temp, JSON.stringify([...resetClaims]), { mode: 0o600 });
    await rename(temp, claimsPath);
  }
  let monitoring = false;
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let lastExternalRead = 0;
  let externalDirty = true;
  const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  function publish() {
    for (const listener of listeners) {
      try { listener.enqueue(encoder.encode("data: update\n\n")); } catch { listeners.delete(listener); }
    }
  }
  let refreshWork: Promise<void> | undefined;
  async function currentName() {
    try {
      const id = identity(await store.auth(codexHome)).accountId;
      for (const name of await store.names()) if (identity(await store.auth(store.account(name))).accountId === id) return name;
    } catch {}
    return undefined;
  }
  async function refreshAll(force = false, signal?: AbortSignal) {
    if (refreshWork) return refreshWork;
    if (!force && !externalDirty && Date.now() - lastExternalRead < 30000) return;
    refreshWork = (async () => {
      if (switching) return;
      externalDirty = false;
      for (const name of await store.names()) {
        if (switching || signal?.aborted) { externalDirty = true; return; }
        await readUsage(name);
      }
      lastExternalRead = Date.now();
      externalDirty = false;
    })().finally(() => { refreshWork = undefined; });
    return refreshWork;
  }
  function scheduleMonitor(delay = 300) {
    externalDirty = true;
    if (monitorTimer) return;
    monitorTimer = setTimeout(() => { monitorTimer = undefined; void monitor().catch(() => { externalDirty = true; lastMessage = "Não foi possível verificar a troca automática. Tente atualizar os limites."; publish(); }); }, delay);
  }
  async function monitor() {
    if (monitoring) return;
    monitoring = true;
    try {
      if (switching) { scheduleMonitor(1500); return; }
      const name = await currentName();
      if (!name) return;
      await readUsage(name);
      const snapshot = usage.get(name);
      const exhausted = snapshot?.fiveHour?.remaining === 0 || snapshot?.weekly?.remaining === 0;
      if (resumeAfterReset && !snapshot?.unavailable && snapshot?.fiveHour && snapshot.weekly && snapshot.fiveHour.remaining > 0 && snapshot.weekly.remaining > 0) {
        const client = await connect();
        const interrupted = await interruptedTurns(client);
        for (const turn of interrupted) {
          if (!resumeAfterReset) break;
          const key = JSON.stringify([turn.threadId, turn.turnId]);
          if (resetClaims.has(key)) continue;
          await claimResetTurn(key);
          try {
            const count = await continueTurns(client, [turn], () => resumeAfterReset);
            if (count) lastMessage = "Limites disponíveis. Continuação enviada na mesma conversa.";
          } catch {
            lastMessage = "Não foi possível confirmar a continuação após reset. Verifique o Codex; o envio não será repetido.";
          }
        }
        pending = undefined;
        publish();
        return;
      }
      if (!exhausted && !pending) return;
      if (!autoSwitch) {
        if (!pending) { pending = { threadId: "limits", reason: "usageLimitExceeded" }; if (!resumeAfterReset) openPanel(); }
        if (resumeAfterReset) { lastMessage = "Aguardando saldo nos limites de 5 horas e semanal para continuar."; publish(); }
        return;
      }
      // Hooks can run before the failing turn has become idle. Never interrupt it.
      try { await ensureIdle(await connect()); } catch { scheduleMonitor(1500); return; }
      const currentId = identity(await store.auth(store.account(name))).accountId;
      let switchError: string | undefined;
      for (const candidate of await store.names()) {
        if (!autoSwitch) return;
        if (identity(await store.auth(store.account(candidate))).accountId === currentId) continue;
        await readUsage(candidate);
        const next = usage.get(candidate);
        if (!next || next.unavailable || !next.fiveHour || !next.weekly || next.fiveHour.remaining <= 0 || next.weekly.remaining <= 0) continue;
        try {
          if (!autoSwitch) return;
          const client = await connect();
          const interrupted = autoContinue ? await interruptedTurns(client) : [];
          await switchAccount(candidate);
          lastMessage = 'Troca automática para ' + candidate + '. Volte ao Codex e envie continue.';
          // A continuation failure must never trigger another account switch.
          if (autoContinue && interrupted.length) {
            try {
              const count = await continueTurns(client, interrupted, () => autoContinue && autoSwitch);
              lastMessage = count ? `Troca automática para ${candidate}. Continuação enviada na mesma conversa.` : `Troca automática para ${candidate}. A conversa já mudou; nenhuma continuação enviada.`;
            } catch { lastMessage = `Troca automática para ${candidate} concluída, mas não foi possível confirmar a continuação. Verifique o Codex antes de enviar continue.`; }
          }
          publish();
          return;
        } catch (e) { switchError = e instanceof Error ? e.message : "Troca não concluída."; }
      }
      lastMessage = switchError ? `Não foi possível concluir a troca automática: ${switchError}` : 'Nenhuma outra conta com saldo confirmado nos dois limites. Atualize os logins ou aguarde a renovação.';
      if (!pending) pending = { threadId: "limits", reason: "usageLimitExceeded" };
      // Auto switch never opens a browser, even if all candidates are exhausted.
    } finally { monitoring = false; }
  }
  async function readUsage(name: string) {
    store.account(name);
    if (switching) throw new Error("Troca ou renovação em andamento. Tente novamente.");
    switching = true;
    const unlock = await store.lock().catch(e => { switching = false; throw e; });
    let helper: Rpc | undefined;
    try {
      const raw = await store.auth(store.account(name));
      const selected = identity(raw);
      let currentId: string | undefined;
      try { currentId = identity(await store.auth(codexHome)).accountId; } catch {}
      let result;
      if (selected.accountId === currentId) {
        const client = await connect();
        const current = await client.call("account/read", { refreshToken: false });
        if (current.account?.type !== "chatgpt") throw new Error("Conta desconectada.");
        result = await client.call("account/rateLimits/read", {}, 8000);
      } else {
        // Use the saved account's isolated home, never switch the shared session.
        const home = store.account(name);
        helper = new Rpc(binary, ["app-server", "-c", 'cli_auth_credentials_store="file"'], {
          ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, OPENAI_API_KEY: "", CODEX_ACCESS_TOKEN: "",
        });
        await helper.initialize();
        result = await helper.call("account/rateLimits/read", {}, 8000);
      }
      if (result.accountId && result.accountId !== selected.accountId) throw new Error("Identidade dos limites divergente.");
      usage.set(name, parseUsage(result));
    } catch {
      usage.set(name, { fiveHour: null, weekly: null, updatedAt: Date.now(), unavailable: true });
    } finally { await helper?.close(); switching = false; await unlock(); }
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  const csrf = crypto.randomUUID();

  async function connect() {
    if (rpc && !rpc.closed) return rpc;
    if (connection) return connection;
    connection = (async () => {
      const next = new UnixRpc(join(codexHome, "app-server-control", "app-server-control.sock"));
      next.onNotification = msg => {
        if (["account/rateLimits/updated", "account/updated", "turn/completed", "thread/status/changed"].includes(msg.method)) {
          externalDirty = true;
          publish();
          if (!monitoring && !refreshWork && (autoSwitch || resumeAfterReset || pending)) scheduleMonitor();
        }
      };
      next.onRequest = async msg => {
        if (msg.method !== "account/chatgptAuthTokens/refresh") return undefined;
        if (!active || switching) throw new Error("Refresh indisponível.");
        switching = true;
        const unlock = await store.lock().catch(e => { switching = false; throw e; });
        try {
          const previous = identity(await store.auth(store.account(active)));
          if (msg.params.previousAccountId && previous.accountId !== msg.params.previousAccountId) throw new Error("Conta mudou durante refresh.");
          const raw = await refresh(active);
          const fresh = identity(raw);
          if (fresh.accountId !== previous.accountId) throw new Error("Refresh mudou a identidade.");
          await store.saveAuth(codexHome, raw);
          return { accessToken: fresh.accessToken, chatgptAccountId: fresh.accountId, chatgptPlanType: fresh.plan };
        } finally { switching = false; await unlock(); }
      };
      try { await next.initialize(true); rpc = next; return next; }
      catch (e) { await next.close(); throw e; }
    })().finally(() => { connection = undefined; });
    return connection;
  }
  async function refresh(name: string) {
    const home = store.account(name);
    const helper = new Rpc(binary, ["app-server", "-c", 'cli_auth_credentials_store="file"'], {
      ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, OPENAI_API_KEY: "", CODEX_ACCESS_TOKEN: "",
    });
    try { await helper.initialize(); await helper.call("account/read", { refreshToken: true }, 8000); }
    finally { await helper.close(); }
    const raw = await store.auth(home);
    if (identity(raw).expires < Date.now()/1000 + 30) throw new Error("Login expirado. Cadastre novamente esta conta.");
    return raw;
  }
  async function ensureIdle(client: UnixRpc) {
    let cursor: string | undefined;
    do {
      const loaded = await client.call("thread/loaded/list", { cursor });
      for (const id of loaded.data) {
        const result = await client.call("thread/read", { threadId: id });
        if (result.thread.status.type === "active") throw new Error("Aguarde todos os turnos terminarem antes de trocar a conta.");
      }
      cursor = loaded.nextCursor ?? undefined;
    } while (cursor);
  }
  async function switchAccount(name: string) {
    if (switching) throw new Error("Troca já em andamento.");
    switching = true;
    const unlock = await store.lock().catch(e => { switching = false; throw e; });
    try {
      const client = await connect();
      await ensureIdle(client);
      const config = await client.call("config/read", { includeLayers: false });
      if (config.config.cli_auth_credentials_store !== "file") throw new Error('Este protótipo requer cli_auth_credentials_store = "file" no config.toml e login oficial nesse modo.');
      const account = await client.call("account/read", { refreshToken: false });
      if (account.account && account.account.type !== "chatgpt") throw new Error("A sessão precisa usar autenticação ChatGPT.");
      let nextRaw = await store.auth(store.account(name));
      if (identity(nextRaw).expires < Date.now()/1000 + 120) nextRaw = await refresh(name);
      const next = identity(nextRaw);
      const previousRaw = account.account ? await store.auth(codexHome) : undefined;
      // Match actual identity, never assume a stale active-name marker is correct.
      if (previousRaw) {
        const previous = identity(previousRaw);
        let previousName: string | undefined;
        for (const n of await store.names()) if (identity(await store.auth(store.account(n))).accountId === previous.accountId) previousName = n;
        if (!previousName) previousName = `previous-${Date.now()}`;
        await store.saveAuth(store.account(previousName), previousRaw);
      }
      await store.saveAuth(codexHome, nextRaw);
      try {
        await client.call("account/login/start", { type: "chatgptAuthTokens", accessToken: next.accessToken, chatgptAccountId: next.accountId, chatgptPlanType: next.plan });
      } catch (e) {
        if (previousRaw) await store.saveAuth(codexHome, previousRaw);
        else await rm(join(codexHome, "auth.json"), { force: true });
        throw e;
      }
      active = name;
      lastMessage = `Conta alterada para ${name}. Volte ao Codex e envie continue. O histórico permanece na mesma conversa.`;
      pending = undefined;
    } finally { switching = false; await unlock(); }
  }
  async function removeAccount(name: string) {
    const home = store.account(name);
    if (switching) throw new Error("Troca ou renovação em andamento. Tente novamente.");
    switching = true;
    const unlock = await store.lock().catch(e => { switching = false; throw e; });
    try {
      if (!(await store.names()).includes(name)) throw new Error(`Conta ${name} não cadastrada.`);
      const currentRaw = await store.auth(codexHome).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
      if (active === name || (currentRaw && identity(currentRaw).accountId === identity(await store.auth(home)).accountId)) {
        throw new Error("Esta conta está em uso. Faça logout ou troque para outra conta antes de removê-la.");
      }
      await store.remove(name);
      usage.delete(name);
      lastMessage = `Conta ${name} removida deste dispositivo. Para usá-la novamente, faça um novo cadastro.`;
    } finally { switching = false; await unlock(); }
  }
  async function logout() {
    if (switching) throw new Error("Troca já em andamento.");
    switching = true;
    const unlock = await store.lock().catch(e => { switching = false; throw e; });
    try {
      const client = await connect();
      await ensureIdle(client);
      await client.call("account/logout");
      active = undefined;
      pending = undefined;
      lastMessage = "Logout concluído. As contas cadastradas continuam salvas; selecione uma para entrar novamente.";
    } finally { switching = false; await unlock(); }
  }
  function openPanel() {
    if (process.env.CODEX_ACCOUNTS_NO_BROWSER === "1") return;
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    try { const p = Bun.spawn([opener, panelUrl], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); p.unref(); } catch {}
  }
  async function panel() {
    const names = await store.names();
    let currentId: string | undefined;
    try { currentId = identity(await store.auth(codexHome)).accountId; } catch {}
    const accounts = await Promise.all(names.map(async name => {
      const raw = await store.auth(store.account(name));
      let email: string | null = null;
      try {
        const auth = JSON.parse(raw);
        const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString());
        if (typeof claims.email === "string" && claims.email.trim()) email = claims.email;
      } catch {}
      const photo = Bun.file(join(store.account(name), "profile-image"));
      return { name, email, current: name === active || identity(raw).accountId === currentId,
        picture: await photo.exists() ? `/${token}/photo?account=${encodeURIComponent(name)}` : profilePicture(raw), usage: usage.get(name) };
    }));
    return renderAccountPanel(accounts, token, csrf, lastMessage, Boolean(pending), autoSwitch, autoContinue, resumeAfterReset);
  }
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 3 * 1024 * 1024, async fetch(req) {
    const url = new URL(req.url);
    // Keep the origin on same-origin form POSTs; no-referrer can produce
    // Origin: null, which our origin guard correctly rejects.
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' https://*.googleusercontent.com https://cdn.auth0.com https://*.oaistatic.com https://cdn.openai.com; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" };
    if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith(`/${token}/`)) return new Response("Not found", { status: 404 });
    if (req.method === "GET" && url.pathname === `/${token}/events`) {
      let listener: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { listener = controller; listeners.add(controller); controller.enqueue(encoder.encode("data: connected\n\n")); },
        cancel() { listeners.delete(listener); },
      });
      req.signal.addEventListener("abort", () => { listeners.delete(listener); try { listener.close(); } catch {} }, { once: true });
      return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream", "connection": "keep-alive" } });
    }
    if (req.method === "GET" && url.pathname === `/${token}/live.js`) return new Response(panelLiveScript, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
    if (req.method === "GET" && url.pathname === `/${token}/live`) {
      await refreshAll(url.searchParams.get("fresh") === "1", req.signal);
      return new Response(await panel(), { headers });
    }
    if (req.method === "GET" && url.pathname === `/${token}/photo`) {
      try {
        const file = Bun.file(join(store.account(url.searchParams.get("account") ?? ""), "profile-image"));
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = photoType(bytes);
        if (!type) throw new Error();
        return new Response(bytes, { headers: { ...headers, "content-type": type, "x-content-type-options": "nosniff" } });
      } catch { return new Response("Not found", { status: 404 }); }
    }
    if (req.method === "POST") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });
      const form = await req.formData();
      if (form.get("csrf") !== csrf) return new Response("Forbidden", { status: 403 });
      try {
        if (url.pathname === `/${token}/settings`) {
          const unlock = await store.lock();
          try {
            const enabled = form.get("autoSwitch") === "on";
            const temp = `${settingsPath}.tmp`;
            await writeFile(temp, JSON.stringify({ autoSwitch: enabled, autoContinue: form.get("autoContinue") === "on", resumeAfterReset: form.get("resumeAfterReset") === "on" }), { mode: 0o600 });
            await rename(temp, settingsPath);
            resumeAfterReset = form.get("resumeAfterReset") === "on";
            autoSwitch = enabled;
            autoContinue = form.get("autoContinue") === "on";
          } finally { await unlock(); }
          lastMessage = autoSwitch ? "Troca automática ativada. A troca afeta todas as conversas conectadas." : "Troca automática desativada.";
          if (autoSwitch || resumeAfterReset) scheduleMonitor();
        }
        else if (url.pathname === `/${token}/switch`) await switchAccount(String(form.get("account")));
        else if (url.pathname === `/${token}/logout`) await logout();
        else if (url.pathname === `/${token}/remove`) await removeAccount(String(form.get("account")));
        else if (url.pathname === `/${token}/limits`) await readUsage(String(form.get("account")));
        else if (url.pathname === `/${token}/photo`) {
          const name = String(form.get("account"));
          const home = store.account(name);
          const file = form.get("photo");
          if (!(file instanceof File) || file.size > 2 * 1024 * 1024 || file.size === 0) throw new Error("Escolha uma foto PNG, JPEG ou WebP de até 2 MB.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!photoType(bytes)) throw new Error("Formato inválido. Use PNG, JPEG ou WebP.");
          const unlock = await store.lock();
          try {
            if (!(await store.names()).includes(name)) throw new Error("Conta não cadastrada.");
            await writeFile(join(home, "profile-image"), bytes, { mode: 0o600 });
          } finally { await unlock(); }
          lastMessage = `Foto de ${name} atualizada neste dispositivo.`;
        }
        else if (url.pathname === `/${token}/cancel`) { pending = undefined; lastMessage = "Troca cancelada. A conta atual foi mantida."; }
        else return new Response("Not found", { status: 404 });
      } catch (e) { lastMessage = e instanceof Error ? e.message : "Troca não concluída."; }
      publish();
    } else if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return new Response(await panel(), { headers });
  } });
  const panelUrl = `http://127.0.0.1:${web.port}/${token}/`;
  let ipc: ReturnType<typeof Bun.serve>;
  try {
    ipc = Bun.serve({ unix: socketPath, async fetch(req) {
      if (req.method === "GET") {
        const current = await currentName();
        return Response.json({ url: panelUrl, active: active ?? null, pending: pending ?? null, switching, autoSwitch, autoContinue, resumeAfterReset, message: lastMessage,
          accounts: (await store.names()).map(name => ({ name, current: name === current, usage: usage.get(name) })) });
      }
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const event = await req.json() as any;
      if (["usage", "switch", "resume-after-reset", "settings"].includes(event.action)) {
        try {
          if (event.action === "usage") {
            const names = event.account === undefined ? await store.names() : [String(event.account)];
            const saved = await store.names();
            for (const name of names) {
              if (!saved.includes(name)) throw new Error("Account not registered.");
              await readUsage(name);
            }
            const current = await currentName();
            return Response.json({ accounts: names.map(name => ({ name, current: name === current, usage: usage.get(name) })) });
          }
          if (event.action === "switch") await switchAccount(String(event.account));
          else {
            const next = { autoSwitch, autoContinue, resumeAfterReset };
            if (event.action === "resume-after-reset") {
              if (typeof event.enabled !== "boolean") throw new Error("Expected enabled boolean.");
              next.resumeAfterReset = event.enabled;
            } else {
              for (const key of ["autoSwitch", "autoContinue", "resumeAfterReset"] as const) {
                if (event[key] === undefined) continue;
                if (typeof event[key] !== "boolean") throw new Error(`Expected ${key} boolean.`);
                next[key] = event[key];
              }
            }
            const unlock = await store.lock();
            try {
              const temp = `${settingsPath}.tmp`;
              await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
              await rename(temp, settingsPath);
              ({ autoSwitch, autoContinue, resumeAfterReset } = next);
            } finally { await unlock(); }
            lastMessage = event.action === "settings" ? "Preferences saved." : `Quota-reset continuation ${resumeAfterReset ? "enabled" : "disabled"}.`;
            if (autoSwitch || resumeAfterReset) scheduleMonitor();
          }
          publish();
          return Response.json({ message: lastMessage });
        } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Operation failed." }, { status: 409 }); }
      }
      if (event.action === "remove") {
        try { await removeAccount(String(event.account)); return Response.json({ message: lastMessage }); }
        catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Remoção não concluída." }, { status: 409 }); }
      }
      if (event.action === "logout") {
        try { await logout(); return Response.json({ message: lastMessage }); }
        catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Logout não concluído." }, { status: 409 }); }
      }
      if (event.action === "shutdown") {
        setTimeout(() => { void close(); }, 100);
        return Response.json({ stopped: true });
      }
      if (["SessionStart", "PostModelRequest", "Stop", "Interrupt"].includes(event.hook_event_name)) {
        externalDirty = true;
        publish();
        if (event.hook_event_name === "PostModelRequest" && event.status === "failed" && /usage.?limit|usage_limit_reached|quota.{0,30}exceed/i.test(event.error ?? "")) {
          const alreadyPending = Boolean(pending);
          pending = { threadId: event.session_id, reason: "usageLimitExceeded" };
          if (!autoSwitch && !resumeAfterReset && !alreadyPending) openPanel();
        }
        // Acknowledge immediately: never keep Codex waiting on network reads.
        if (autoSwitch || resumeAfterReset || event.hook_event_name === "SessionStart") scheduleMonitor();
        void connect().catch(() => {});
      }
      return Response.json({});
    } });
  } catch (e) { web.stop(true); throw e; }
  await chmod(socketPath, 0o600);
  await writeFile(endpointPath, JSON.stringify({ url: panelUrl, pid: process.pid }), { mode: 0o600 });
  // Backend-owned recurring job; polling also detects resets purchased before resetsAt.
  // Re-read authoritative quotas instead of assuming a timestamp grants capacity.
  const resetTimer = setInterval(() => {
    if (resumeAfterReset && !monitoring) scheduleMonitor(0);
  }, 30000);
  if (resumeAfterReset) scheduleMonitor();
  const refreshTimer = setInterval(() => {
    if (!active || switching) return;
    // After a daemon restart its managed auth owns refresh again. Do not run
    // a second refresh flow against the same token generation.
    if (!rpc || rpc.closed) { active = undefined; return; }
    const name = active;
    switching = true;
    void (async () => {
      const unlock = await store.lock();
      try {
      const auth = identity(await store.auth(store.account(name)));
      if (auth.expires < Date.now()/1000 + 180) {
        const raw = await refresh(name); const fresh = identity(raw);
        if (fresh.accountId !== auth.accountId) throw new Error("Refresh mudou a identidade.");
        const client = await connect(); await ensureIdle(client);
        await client.call("account/login/start", { type: "chatgptAuthTokens", accessToken: fresh.accessToken, chatgptAccountId: fresh.accountId, chatgptPlanType: fresh.plan });
        await store.saveAuth(codexHome, raw);
      }
      } finally { await unlock(); }
    })().catch(() => { lastMessage = "Não foi possível renovar o login. Cadastre novamente a conta pelo fluxo oficial."; }).finally(() => { switching = false; });
  }, 60000);
  async function close() {
    if (monitorTimer) clearTimeout(monitorTimer);
    for (const listener of listeners) { try { listener.close(); } catch {} }
    listeners.clear();
    clearInterval(resetTimer);
    clearInterval(refreshTimer); ipc.stop(true); web.stop(true); await rpc?.close();
    await rm(endpointPath, { force: true }); await rm(socketPath, { force: true });
  }
  return { panelUrl, close };
}
if (import.meta.main) serveNative().then(service => {
  const exit = () => { void service.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", exit); process.once("SIGINT", exit);
}).catch(() => { process.exitCode = 1; });
