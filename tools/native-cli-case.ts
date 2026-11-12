import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeAuth } from "./fixtures/fake-auth";
import { Store } from "../src/store";
import { UnixRpc } from "../src/rpc";

const binary = process.env.CODEX_ACCOUNTS_CODEX ?? "codex";
const home = await mkdtemp(join(tmpdir(), "codex-native-account-case-"));
const cwd = join(home, "project");
const root = join(import.meta.dir, "..");
const store = new Store(join(home, "vault"));
const ipcDir = join(tmpdir(), `codex-accounts-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0,12)}`);
const env: Record<string,string | undefined> = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, CODEX_ACCOUNTS_HOME: store.root, CODEX_ACCOUNTS_NO_BROWSER: "1",
  OPENAI_API_KEY: "", CODEX_ACCESS_TOKEN: "", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost", TERM: "xterm-256color" };
const autoCase = process.env.AUTO_SWITCH_CASE === "1";
const continueCase = process.env.AUTO_CONTINUE_CASE === "1";
const seen: { account: string | null; input: any }[] = [];
let refreshes = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/usage")) {
    const used = req.headers.get("chatgpt-account-id") === "account-B" ? 60 : 100;
    return Response.json({ plan_type: "plus", rate_limit: { allowed: used < 100, limit_reached: used === 100,
      primary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: Math.floor(Date.now()/1000)+3600 },
      secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: Math.floor(Date.now()/1000)+86400 } } });
  }
  if (path.endsWith("/oauth/token")) {
    refreshes++;
    const a = fakeAuth("account-B",refreshes);
    return Response.json({ id_token: a.tokens.id_token, access_token: a.tokens.access_token, refresh_token: a.tokens.refresh_token, expires_in: 86400, token_type: "Bearer" });
  }
  if (path.endsWith("/accounts/check")) return Response.json({ accounts: [{ id: req.headers.get("chatgpt-account-id") ?? "account-A", workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" }] });
  if (path.endsWith("/responses")) {
    const account = req.headers.get("chatgpt-account-id");
    seen.push({ account, input: await req.json() });
    if (account === "account-A") return Response.json({ error: { type: "usage_limit_reached", plan_type: "plus", message: "You've hit your usage limit", resets_at: Math.floor(Date.now()/1000)+3600 } }, { status: 429 });
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const generation = JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString()).generation;
    if (generation === 0) return Response.json({ error: { message: "expired fake access token", type: "invalid_token" } }, { status: 401 });
    const items = [{ type: "response.created", response: { id: "resp_B" } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "msg_B", content: [{ type: "output_text", text: "ACCOUNT_B_CONTEXT_OK" }] } },
      { type: "response.completed", response: { id: "resp_B", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(items.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
  if (path.endsWith("/models")) return Response.json({ models: [] });
  return Response.json({});
} });
let terminal: Bun.Subprocess | undefined;
let observer: UnixRpc | undefined;
let output = "";
async function command(args: string[]) {
  const p = Bun.spawn([binary, ...args], { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = await p.stdout.text(); const err = await p.stderr.text();
  if (await p.exited !== 0) throw new Error(`Command ${args.slice(0,3).join(" ")} failed: ${out} ${err}`);
  return out;
}
async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 20000) {
  const deadline = Date.now()+timeout;
  while (!(await check())) { if (Date.now()>deadline) throw new Error(`Timeout ${label}; requests=${seen.length}; terminal=${output.slice(-6000)}`); await Bun.sleep(50); }
}
try {
  await mkdir(cwd); await store.init();
  if (autoCase) await Bun.write(join(store.root,"settings.json"), JSON.stringify({autoSwitch:true, autoContinue:continueCase}));
  await store.saveAuth(home, JSON.stringify(fakeAuth("account-A")));
  await store.saveAuth(store.account("one"), JSON.stringify(fakeAuth("account-A")));
  await store.saveAuth(store.account("two"), JSON.stringify(fakeAuth("account-B")));
  const url = `http://127.0.0.1:${server.port}`;
  env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `${url}/oauth/token`;
  // The managed refresh helper must use the fake workspace service too.
  for (const name of ["one", "two"]) await Bun.write(join(store.account(name),"config.toml"), `chatgpt_base_url = "${url}"\ncli_auth_credentials_store = "file"\n`);
  await Bun.write(join(home,"config.toml"), `model = "gpt-5.4"
model_provider = "localtest"
cli_auth_credentials_store = "file"
chatgpt_base_url = "${url}"
check_for_update_on_startup = false
suppress_unstable_features_warning = true
[model_providers.localtest]
name = "Local test"
base_url = "${url}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"
`);
  console.log("Installing local plugin into isolated CODEX_HOME...");
  await command(["plugin", "marketplace", "add", join(root,"marketplace")]);
  await command(["plugin", "add", "codex-accounts@codex-accounts-local"]);
  await command(["app-server", "daemon", "start"]);
  observer = new UnixRpc(join(home,"app-server-control","app-server-control.sock")); await observer.initialize(true);
  const inventory = await observer.call("hooks/list", { cwds: [cwd] });
  const hooks = inventory.data[0].hooks;
  if (hooks.length !== 4) throw new Error("Expected exactly four plugin hooks: "+JSON.stringify(inventory));
  // Trust only these two fixture hooks, equivalent to reviewing them in /hooks.
  await observer.call("config/batchWrite", { edits: [{ keyPath: "hooks.state", value: Object.fromEntries(hooks.map((h: any) => [h.key,{trusted_hash:h.currentHash}])), mergeStrategy: "upsert" }], reloadUserConfig: true });
  console.log("Launching official codex binary directly, no --remote and no wrapper...");
  terminal = Bun.spawn([binary, "--no-alt-screen", "Remember NATIVE_CONTEXT_42 and reply."], { env, cwd,
    terminal: { cols: 120, rows: 35, data(t, chunk) {
      const text = new TextDecoder().decode(chunk); output += text;
      if (text.includes("\x1b[6n")) t.write("\x1b[1;1R");
      if (text.includes("\x1b[c")) t.write("\x1b[?1;2c");
    } } });
  const tuiPid = terminal.pid;
  await waitFor(() => seen.length > 0, "first model request");
  if (autoCase) {
    await waitFor(async () => {
      try { return (await (await fetch("http://localhost/state", {unix:join(ipcDir,"backend.sock")})).json() as any).active === "two"; } catch { return false; }
    }, "automatic switch", 45000);
    if (JSON.parse(await store.auth(home)).tokens.account_id !== "account-B") throw new Error("Auto switch did not apply B");
    if (terminal.pid !== tuiPid || terminal.exitCode !== null) throw new Error("Auto switch restarted CLI");
    if (continueCase) {
      await waitFor(() => seen.some(r => r.account === "account-B"), "automatic continuation request", 45000);
      await waitFor(() => output.includes("ACCOUNT_B_CONTEXT_OK"), "automatic native reply", 45000);
      const bRequest = seen.find(r => r.account === "account-B")!;
      if (!JSON.stringify(bRequest.input).includes("NATIVE_CONTEXT_42")) throw new Error("Automatic continuation lost history");
      console.log("Automatic continuation in the official CLI, same process and preserved context: OK");
    } else {
      await Bun.sleep(1000);
      if (seen.some(r => r.account === "account-B")) throw new Error("Continued with preference disabled");
    }
    console.log("Auto switch enabled from persisted settings, session startup and exhausted-account rotation: OK");
  } else {
  await waitFor(async () => {
    try { const result = await fetch("http://localhost/state", { unix: join(ipcDir,"backend.sock") }); return Boolean((await result.json() as any).pending); } catch { return false; }
  }, "hook offer");
  const endpoint = await Bun.file(join(ipcDir,"endpoint.json")).json();
  const loaded = await observer.call("thread/loaded/list"); const threadId = loaded.data[0];
  if (!threadId) throw new Error("No native CLI thread loaded");
  await waitFor(async () => (await observer!.call("thread/read", { threadId })).thread.status.type !== "active", "turn stopped before switching");
  await Bun.sleep(1000);
  await waitFor(async () => (await observer!.call("thread/read", { threadId })).thread.status.type !== "active", "settled failed turn");
  const before = seen.length;
  if (JSON.parse(await store.auth(home)).tokens.account_id !== "account-A") throw new Error("Switched without confirmation");
  const panelResponse = await fetch(endpoint.url);
  if (panelResponse.headers.get("referrer-policy") !== "same-origin") throw new Error("Panel must preserve same-origin form origins");
  const page = await panelResponse.text();
  if (!page.includes("account-A@example.invalid") || !page.includes("account-B@example.invalid")) throw new Error("Panel must show saved account emails");
  const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("No confirmation form");
  for (const origin of ["null", "https://example.com"]) {
    const rejected = await fetch(endpoint.url+"cancel", { method: "POST", headers: { origin }, body: new URLSearchParams({ csrf }) });
    if (rejected.status !== 403) throw new Error("Origin guard failed");
  }
  const csrfFailure = await fetch(endpoint.url+"switch", { method: "POST", body: new URLSearchParams({ account: "two", csrf: "invalid" }) });
  if (csrfFailure.status !== 403) throw new Error("CSRF guard failed");
  if (seen.length !== before) throw new Error("Switcher made a model request");
  const cancelled = await fetch(endpoint.url+"cancel", { method: "POST", headers: { origin: new URL(endpoint.url).origin }, body: new URLSearchParams({ csrf }) });
  if (!(await cancelled.text()).includes("Troca cancelada")) throw new Error("Cancellation failed");
  if (JSON.parse(await store.auth(home)).tokens.account_id !== "account-A") throw new Error("Cancellation changed account");
  const response = await fetch(endpoint.url+"switch", { method: "POST", headers: { origin: new URL(endpoint.url).origin }, body: new URLSearchParams({ account: "two", csrf }) });
  const switchedPage = await response.text();
  if (!switchedPage.includes("Conta alterada para two")) throw new Error("Switch failed: "+switchedPage);
  if (terminal.pid !== tuiPid || terminal.exitCode !== null) throw new Error("Official CLI restarted unexpectedly");
  // Human continuation, sent to the existing official terminal rather than a new client turn.
  // Let the native UI process account/updated, then type and press Enter as
  // separate input events (a burst is treated as paste by the composer).
  await Bun.sleep(350);
  terminal.terminal!.write("continue");
  await Bun.sleep(150);
  terminal.terminal!.write("\r");
  await waitFor(() => seen.some(r => r.account === "account-B"), "request from B");
  await waitFor(() => output.includes("ACCOUNT_B_CONTEXT_OK"), "native reply");
  const sameThread = (await observer.call("thread/loaded/list")).data.includes(threadId);
  if (!sameThread) throw new Error("Thread identity changed");
  const bRequest = seen.find(r => r.account === "account-B")!;
  const bPayload = JSON.stringify(bRequest.input);
  if (!bPayload.includes("NATIVE_CONTEXT_42")) throw new Error("Context was not preserved");
  if (/codex-accounts|switcher|troca de conta/i.test(bPayload.replaceAll(home, "[TEMP_HOME]").replaceAll(await realpath(home), "[TEMP_HOME]").replaceAll(await realpath(root), "[REPO]"))) throw new Error("Switcher leaked into model context");
  if (refreshes === 0 || JSON.parse(await store.auth(store.account("two"))).tokens.refresh_token !== `fake-refresh-account-B-${refreshes}`) throw new Error("Rotated refresh token was not preserved");
  await waitFor(async () => (await observer!.call("thread/read", { threadId })).thread.status.type !== "active", "idle before logout");
  await waitFor(async () => {
    const state = await (await fetch("http://localhost/state", { unix: join(ipcDir,"backend.sock") })).json() as any;
    return !state.switching;
  }, "refresh complete before logout");
  await Bun.sleep(1000);
  await waitFor(async () => (await observer!.call("thread/read", { threadId })).thread.status.type !== "active", "settled successful turn");
  const beforeDetails = seen.length;
  for (const [name, expected] of [["one", "0% restante"], ["two", "40% restante"]]) {
    const limits = await fetch(endpoint.url+"limits", { method: "POST", body: new URLSearchParams({ account: name!, csrf }) });
    const html = await limits.text();
    if (!html.includes(expected!)) throw new Error(`Account limits missing for ${name}: ${html}`);
  }
  if (JSON.parse(await store.auth(home)).tokens.account_id !== "account-B") throw new Error("Limits query switched live account");
  const uploaded = new FormData();
  uploaded.set("csrf", csrf); uploaded.set("account", "two");
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  uploaded.set("photo", new File([png], "avatar.png", { type: "image/png" }));
  const photoResult = await fetch(endpoint.url+"photo", { method: "POST", body: uploaded });
  if (!(await photoResult.text()).includes("Foto de two atualizada")) throw new Error("Profile upload failed");
  const photo = await fetch(endpoint.url+"photo?account=two");
  if (photo.headers.get("content-type") !== "image/png" || !Buffer.from(await photo.arrayBuffer()).equals(Buffer.from(png))) throw new Error("Profile image did not round-trip");
  if (seen.length !== beforeDetails) throw new Error("Account detail queries made a model request: " + JSON.stringify({ beforeDetails, extra: seen.slice(beforeDetails) }));
  async function localCli(command: string, ...args: string[]) {
    const p = Bun.spawn([process.execPath, join(root, "src/native-cli.ts"), command, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
    const out = await p.stdout.text(); const err = await p.stderr.text();
    if (await p.exited !== 0) throw new Error(`Local CLI ${command}: ${err}`);
    return out.trim();
  }
  const removePost = (name: string, token = csrf!) => fetch(endpoint.url+"remove", { method: "POST", headers: { origin: new URL(endpoint.url).origin }, body: new URLSearchParams({ account: name, csrf: token }) });
  if ((await removePost("one", "invalid")).status !== 403) throw new Error("Removal bypassed CSRF");
  if (!(await (await removePost("two")).text()).includes("Esta conta está em uso")) throw new Error("Active account removal was allowed");
  if (!(await store.names()).includes("two")) throw new Error("Active account was deleted");
  if (!(await (await removePost("one")).text()).includes("Conta one removida")) throw new Error("Panel removal failed");
  if ((await store.names()).includes("one")) throw new Error("Panel removal kept credentials");
  const logoutPage = await fetch(endpoint.url+"logout", { method: "POST", headers: { origin: new URL(endpoint.url).origin }, body: new URLSearchParams({ csrf }) });
  const logoutHtml = await logoutPage.text();
  if (!logoutHtml.includes("Logout concluído")) throw new Error("Panel logout failed: " + logoutHtml);
  if ((await observer.call("account/read", { refreshToken: false })).account !== null) throw new Error("Logout kept live account");
  if (!(await store.names()).includes("two")) throw new Error("Logout removed saved accounts");
  const loginAgain = await fetch(endpoint.url+"switch", { method: "POST", headers: { origin: new URL(endpoint.url).origin }, body: new URLSearchParams({ account: "two", csrf }) });
  if (!(await loginAgain.text()).includes("Conta alterada para two")) throw new Error("Login after logout failed");
  if (!(await localCli("logout")).includes("Logout concluído")) throw new Error("CLI logout failed");
  await localCli("stop");
  await localCli("stop");
  if (!(await localCli("status")).includes("Backend parado")) throw new Error("Stopped status failed");
  const reopenedUrl = await localCli("panel");
  if (!(await fetch(reopenedUrl)).ok) throw new Error("Panel did not start backend");
  const restartedUrl = await localCli("restart");
  if (restartedUrl === reopenedUrl || !(await fetch(restartedUrl)).ok) throw new Error("Restart failed");
  await store.saveAuth(store.account("disposable"), JSON.stringify(fakeAuth("account-C")));
  if (!(await localCli("remove", "disposable")).includes("Conta disposable removida")) throw new Error("CLI removal failed");
  if ((await store.names()).includes("disposable") || !(await store.names()).includes("two")) throw new Error("CLI removal changed other accounts");
  const restartedPage = await (await fetch(restartedUrl)).text();
  const restartedCsrf = restartedPage.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!restartedCsrf) throw new Error("Restarted panel lacks CSRF");
  const liveScript = await fetch(restartedUrl + "live.js");
  if (!liveScript.ok || !(await liveScript.text()).includes("EventSource")) throw new Error("Live client unavailable");
  const eventAbort = new AbortController();
  const eventsResponse = await fetch(restartedUrl + "events", {signal:eventAbort.signal});
  if (!eventsResponse.headers.get("content-type")?.includes("text/event-stream")) throw new Error("SSE not available");
  const eventsReader = eventsResponse.body!.getReader();
  const connectedEvent = await eventsReader.read();
  if (!new TextDecoder().decode(connectedEvent.value).includes("connected")) throw new Error("SSE handshake missing");
  eventAbort.abort(); await eventsReader.cancel().catch(()=>{});
  const settingsResult = await fetch(restartedUrl + "settings", {method:"POST",body:new URLSearchParams({csrf:restartedCsrf,autoSwitch:"on",autoContinue:"on"})});
  if (!(await settingsResult.text()).includes("Troca automática ativada")) throw new Error("Settings save failed");
  const persistedUrl = await localCli("restart");
  const persistedPage = await (await fetch(persistedUrl)).text();
  if (!persistedPage.includes('name="autoSwitch" checked')) throw new Error("Auto switch preference did not persist");
  if (!persistedPage.includes('name="autoContinue" checked')) throw new Error("Auto continue preference did not persist");
  const persistedCsrf = persistedPage.match(/name="csrf" value="([^"]+)"/)![1]!;
  await fetch(persistedUrl + "settings", {method:"POST",body:new URLSearchParams({csrf:persistedCsrf})});
  const liveResponse = await fetch(persistedUrl + "live?fresh=1");
  if (!liveResponse.ok || !(await liveResponse.text()).includes("account-B@example.invalid")) throw new Error("Fresh live snapshot failed");
  console.log("Live client, SSE, fresh snapshots and persistent opt-in/disable: OK");
  console.log("Lifecycle, panel logout, CLI logout and login after logout: OK");
  console.log(JSON.stringify({ officialBinary: binary, wrapper: false, sameCliProcess: terminal.pid === tuiPid, sameThread,
    accounts: seen.map(r=>r.account), contextPreserved: true, switcherInModelContext: false, confirmationRequired: true, csrfGuard: true,
    loggedOut: (await observer.call("account/read", { refreshToken: false })).account === null, refreshAfter401: refreshes > 0,
    rotatedRefreshSaved: JSON.parse(await store.auth(store.account("two"))).tokens.refresh_token === `fake-refresh-account-B-${refreshes}` }, null, 2));
  }
} finally {
  await observer?.close();
  terminal?.kill("SIGTERM"); if (terminal) { await terminal.exited; terminal.terminal?.close(); }
  try {
    await fetch("http://localhost/event", { unix: join(ipcDir,"backend.sock"), method:"POST", body:JSON.stringify({action:"shutdown"}), signal:AbortSignal.timeout(2000) });
    await waitFor(async () => !(await Bun.file(join(ipcDir,"endpoint.json")).exists()), "backend shutdown",3000);
  } catch {}
  await command(["app-server","daemon","stop"]).catch(()=>{});
  server.stop(true);
  if (process.env.KEEP_CASE) { await Bun.write(join(home,"terminal-output.txt"),output); console.log(`Artifacts: ${home}`); }
  else { await rm(home,{recursive:true,force:true}); await rm(ipcDir,{recursive:true,force:true}); }
}
