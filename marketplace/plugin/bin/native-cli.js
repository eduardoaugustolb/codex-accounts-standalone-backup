#!/usr/bin/env bun
// @bun

// src/native-cli.ts
import { mkdir as mkdir3, rm as rm2 } from "fs/promises";
import { join as join3, resolve as resolve3 } from "path";

// src/tui.ts
function terminalText(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
function usageText(window, now = Date.now()) {
  if (!window)
    return "unknown";
  const filled = Math.round(window.remaining / 10);
  const bar = "#".repeat(filled) + "-".repeat(10 - filled);
  const minutes = window.resetsAt ? Math.max(0, Math.ceil((window.resetsAt * 1000 - now) / 60000)) : null;
  const reset = minutes === null ? "unknown" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  return `[${bar}] ${Math.round(window.remaining)}% left; reset ${reset}`;
}
function moveSelection(index, direction, count) {
  return count ? (index + direction + count) % count : 0;
}
function renderTui(state, selected = 0, message = "", width = 100, height = 30, modal) {
  width = Math.max(10, width);
  const on = (v) => v ? "ON" : "OFF";
  const rows = ["Codex Accounts", "", `Autoswitch ${on(state.autoSwitch)} | Continue on switch ${on(state.autoContinue)} | Continue after reset ${on(state.resumeAfterReset)}`, ""];
  const perAccount = width < 115 ? 3 : 1;
  const visible = Math.max(1, Math.floor((height - 12) / perAccount));
  const start = Math.max(0, selected - visible + 1);
  const accounts = state.accounts.slice(start, start + visible);
  if (!accounts.length)
    rows.push("No saved accounts. Press n to add one or s to capture the current login.");
  for (const [offset, account] of accounts.entries()) {
    const label = `${start + offset === selected ? ">" : " "} ${account.name}${account.current ? " * current" : ""}`;
    const five = account.usage?.unavailable ? "unavailable" : usageText(account.usage?.fiveHour);
    const week = account.usage?.unavailable ? "unavailable" : usageText(account.usage?.weekly);
    if (perAccount === 1)
      rows.push(`${label.padEnd(28)} 5h ${five} | Week ${week}`);
    else
      rows.push(label, `    5h   ${five}`, `    Week ${week}`);
  }
  if (state.accounts.length > visible)
    rows.push(`Accounts ${start + 1}-${start + accounts.length} of ${state.accounts.length}`);
  rows.push("", message || state.message || "Ready. Percentages show remaining capacity.", "");
  if (modal?.type === "add" || modal?.type === "capture") {
    rows.push(`${modal.type === "add" ? "Add (device login)" : "Capture current login"} - name: ${modal.name}_`, "Enter: save / start login | Esc: cancel");
  } else if (modal) {
    rows.push(`Confirm ${modal.type}${modal.name ? ` ${modal.name}` : ""}? This affects the shared session.`, "y: confirm | Any other key: cancel");
  } else {
    rows.push("Up/Down j/k: select | Enter: switch | r: refresh | q/Esc: quit", "a: autoswitch | c: continue on switch | w: continue after reset", "n: add | s: capture login | d: remove selected | l: logout");
  }
  return rows.slice(0, Math.max(1, height)).map((line, i) => {
    const text = terminalText(line).slice(0, width);
    return i === 0 ? `\x1B[1m${text}\x1B[0m` : text.startsWith("> ") ? `\x1B[7m${text}\x1B[0m` : i === 2 || text.startsWith("    ") ? `\x1B[2m${text}\x1B[0m` : text;
  }).join(`\r
`);
}
async function runTui(client) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The TUI requires an interactive terminal. Use usage --json for scripts.");
  let state = { accounts: [], autoSwitch: false, autoContinue: false, resumeAfterReset: false };
  let selected = 0;
  let modal;
  let busy = false;
  let closed = false;
  let suspended = false;
  let message = "Loading saved accounts and quotas...";
  const previousRaw = process.stdin.isRaw;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const draw = () => {
    if (!closed && !suspended)
      process.stdout.write(`\x1B[H\x1B[2J${renderTui(state, selected, message, process.stdout.columns, process.stdout.rows, modal)}`);
  };
  const enter = () => {
    suspended = false;
    process.stdout.write("\x1B[?1049h\x1B[?25l");
    process.stdin.setRawMode(true);
    process.stdin.resume();
  };
  const leave = () => {
    suspended = true;
    process.stdin.setRawMode(previousRaw ?? false);
    process.stdout.write("\x1B[?25h\x1B[?1049l");
  };
  const cleanup = () => {
    if (closed)
      return;
    closed = true;
    clearInterval(timer);
    process.stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", draw);
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
    if (!suspended)
      leave();
    process.stdin.pause();
    finish();
  };
  async function update(fresh) {
    const previousName = state.accounts[selected]?.name;
    state = await client.state();
    if (fresh) {
      const response = await client.request({ action: "usage" });
      state.accounts = response.accounts;
    }
    const index = state.accounts.findIndex((a) => a.name === previousName);
    selected = index >= 0 ? index : Math.max(0, state.accounts.findIndex((a) => a.current));
  }
  async function perform(work) {
    if (busy || closed)
      return;
    busy = true;
    message = "Working...";
    draw();
    try {
      await work();
    } catch (e) {
      message = e instanceof Error ? e.message : "Operation failed. Press r to retry.";
    } finally {
      busy = false;
      draw();
    }
  }
  async function handle(key) {
    if (suspended || closed)
      return;
    if (key === "\x03" || key === "q" && !modal) {
      cleanup();
      return;
    }
    if (busy)
      return;
    if (modal?.type === "add" || modal?.type === "capture") {
      if (key === "\x1B") {
        modal = undefined;
        draw();
        return;
      }
      if (key === "\x7F" || key === "\b")
        modal.name = modal.name.slice(0, -1);
      else if (key === "\r" || key === `
`) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(modal.name)) {
          message = "Use 1-64 letters, numbers, underscores or hyphens; start with a letter or number.";
          draw();
          return;
        }
        const registration = modal;
        modal = undefined;
        await perform(async () => {
          leave();
          try {
            await client.register(registration.type, registration.name);
          } finally {
            if (!closed)
              enter();
          }
          await update(true);
          message = `Account ${registration.name} saved.`;
        });
        return;
      } else if (/^[a-zA-Z0-9_-]+$/.test(key))
        modal.name = (modal.name + key).slice(0, 64);
      draw();
      return;
    }
    if (modal) {
      const action = modal;
      modal = undefined;
      if (key.toLowerCase() !== "y") {
        message = "Canceled.";
        draw();
        return;
      }
      await perform(async () => {
        const result = await client.request({ action: action.type, account: action.name });
        await update(false);
        message = result.message ?? "Done.";
      });
      return;
    }
    if (key === "\x1B") {
      cleanup();
      return;
    }
    if (key === "\x1B[A" || key === "k")
      selected = moveSelection(selected, -1, state.accounts.length);
    else if (key === "\x1B[B" || key === "j")
      selected = moveSelection(selected, 1, state.accounts.length);
    else if (key === "\r" || key === `
` || key === "d") {
      const account = state.accounts[selected];
      if (account)
        modal = { type: key === "d" ? "remove" : "switch", name: account.name };
    } else if (key === "l")
      modal = { type: "logout" };
    else if (key === "n" || key === "s")
      modal = { type: key === "n" ? "add" : "capture", name: "" };
    else if (key === "r") {
      await perform(async () => {
        await update(true);
        message = "Quotas refreshed.";
      });
      return;
    } else if (["a", "c", "w"].includes(key)) {
      const setting = key === "a" ? "autoSwitch" : key === "c" ? "autoContinue" : "resumeAfterReset";
      await perform(async () => {
        await client.request({ action: "settings", [setting]: !state[setting] });
        await update(false);
        message = `${setting}: ${state[setting] ? "ON" : "OFF"}.`;
      });
      return;
    }
    draw();
  }
  const onData = (data) => {
    handle(data.toString()).catch((e) => {
      message = String(e);
      draw();
    });
  };
  const timer = setInterval(() => {
    if (!busy && !modal)
      perform(async () => {
        await update(true);
        message = "Quotas refreshed.";
      });
  }, 30000);
  process.stdin.on("data", onData);
  process.stdout.on("resize", draw);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  try {
    enter();
    draw();
    perform(async () => {
      await update(true);
      message = "Ready. Quotas refreshed.";
    });
    await done;
  } finally {
    cleanup();
  }
}

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

// src/native-cli.ts
async function main() {
  const [requestedCommand, name, flag] = process.argv.slice(2);
  const command = requestedCommand ?? (process.stdin.isTTY && process.stdout.isTTY ? "tui" : undefined);
  const help = `Usage: bun run start <command>
  tui                            Open the interactive terminal account manager
  help, --help, -h                Show this help (also: <command> --help)
  add NAME [--device]             Register an account using official login
  capture NAME                   Save the current official login
  list                           List saved account names
  usage [NAME] [--json]           Read fresh quotas for one or all accounts
  switch NAME                    Switch all idle conversations to this account
  resume-after-reset on|off       Enable/disable automatic quota-reset continuation
  remove NAME                    Remove an inactive saved account
  logout                         Sign out, keeping saved accounts
  panel                          Start backend and open panel
  status                         Print panel address or stopped status
  start, restart, stop            Manage backend lifecycle
  install                        Install plugin and start official daemon

Examples:
  bun run start usage
  bun run start usage work --json
  bun run start switch personal
  bun run start resume-after-reset on

Usage shows remaining percentages and reset timestamps for 5h and weekly quotas.
Switching waits for idle conversations; busy sessions return an error.
Reset continuation is opt-in, requires the backend and daemon to stay running,
and checks for early/token resets every 30 seconds. Both quotas must have capacity.`;
  const args = process.argv.slice(2);
  if (!command || args.some((a) => ["--help", "-h", "help"].includes(a))) {
    console.log(help);
    return;
  }
  const valid = ["tui", "add", "capture", "list", "usage", "switch", "resume-after-reset", "remove", "logout", "panel", "status", "start", "restart", "stop", "install"];
  if (!valid.includes(command))
    throw new Error(`Unknown command: ${command}. Run --help.`);
  if (command === "usage" ? args.slice(1).filter((a) => a !== "--json").length > 1 || args.slice(1).some((a) => a.startsWith("--") && a !== "--json") : command === "resume-after-reset" ? !["on", "off"].includes(name ?? "") || args.length !== 2 : ["switch", "remove", "capture"].includes(command) ? !name || args.length !== 2 : command === "add" ? !name || args.length > 3 || Boolean(flag && flag !== "--device") : args.length !== (requestedCommand ? 1 : 0))
    throw new Error("Invalid arguments. Run --help.");
  if (command === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error("The TUI requires an interactive terminal. Use usage --json for scripts.");
  const store = new Store;
  await store.init();
  if (command === "remove") {
    if (!name || flag)
      throw new Error("Use: remove NOME");
    store.account(name);
  }
  if (["status", "panel", "stop", "start", "restart", "logout", "remove", "usage", "switch", "resume-after-reset", "tui"].includes(command)) {
    async function state() {
      try {
        const response = await fetch("http://localhost/state", { unix: socketPath, signal: AbortSignal.timeout(1000) });
        if (!response.ok)
          return null;
        return await response.json();
      } catch {
        return null;
      }
    }
    async function stop() {
      if (!await state())
        return;
      const result = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify({ action: "shutdown" }), signal: AbortSignal.timeout(3000) });
      if (!result.ok)
        throw new Error("Backend n\xE3o confirmou o encerramento.");
      for (let i = 0;i < 60; i++) {
        if (!await Bun.file(endpointPath).exists() && !await state())
          return;
        await Bun.sleep(50);
      }
      throw new Error("Backend ainda est\xE1 encerrando. Tente novamente.");
    }
    if (command === "stop") {
      await stop();
      console.log("Backend parado. Use panel ou start para iniciar novamente.");
      return;
    }
    if (command === "restart")
      await stop();
    let endpoint = await state();
    if (!endpoint && command === "status") {
      console.log("Backend parado. Use bun run start panel para iniciar.");
      return;
    }
    if (!endpoint) {
      const script = join3(import.meta.dir, `native-hook.${import.meta.path.endsWith(".ts") ? "ts" : "js"}`);
      const p = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
      p.stdin.write(JSON.stringify({ hook_event_name: "SessionStart" }));
      p.stdin.end();
      await p.exited;
      endpoint = await state();
      if (!endpoint)
        throw new Error("N\xE3o foi poss\xEDvel iniciar o backend local.");
    }
    if (command === "tui") {
      await runTui({
        async state() {
          const response = await fetch("http://localhost/state", { unix: socketPath, signal: AbortSignal.timeout(5000) });
          if (!response.ok)
            throw new Error("Backend unavailable. Restart it and reopen the TUI.");
          return await response.json();
        },
        async request(event) {
          const response = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify(event), signal: AbortSignal.timeout(120000) });
          const body = await response.json();
          if (!response.ok)
            throw new Error(body.error ?? "Operation failed.");
          return body;
        },
        async register(action, account) {
          const child = Bun.spawn([process.execPath, import.meta.path, action, account, ...action === "add" ? ["--device"] : []], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
          if (await child.exited !== 0)
            throw new Error("Registration failed. Existing accounts were preserved.");
        }
      });
      return;
    }
    if (["usage", "switch", "resume-after-reset"].includes(command)) {
      const account = command === "usage" ? args.slice(1).find((a) => a !== "--json") : name;
      const result = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify({ action: command, account, enabled: name === "on" }), signal: AbortSignal.timeout(120000) });
      const body = await result.json();
      if (!result.ok)
        throw new Error(body.error ?? "Operation failed.");
      if (command !== "usage")
        console.log(body.message);
      else if (args.includes("--json"))
        console.log(JSON.stringify(body, null, 2));
      else
        for (const a of body.accounts) {
          const window = (w) => w ? `${w.remaining}% remaining; resets ${w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : "unknown"}` : "unknown";
          console.log(`${a.name}${a.current ? " (current)" : ""}
  5h: ${window(a.usage?.fiveHour)}
  Weekly: ${window(a.usage?.weekly)}${a.usage?.unavailable ? `
  Quotas unavailable` : ""}`);
        }
      return;
    }
    if (command === "logout" || command === "remove") {
      const result = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify({ action: command, account: name }), signal: AbortSignal.timeout(20000) });
      const body = await result.json();
      if (!result.ok)
        throw new Error(body.error ?? "Opera\xE7\xE3o n\xE3o conclu\xEDda.");
      console.log(body.message);
      return;
    }
    console.log(endpoint.url);
    if (command === "panel" && process.env.CODEX_ACCOUNTS_NO_BROWSER !== "1") {
      const p = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", endpoint.url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      await p.exited;
    }
    return;
  }
  if (command === "install") {
    const root = import.meta.path.endsWith(".ts") ? resolve3(import.meta.dir, "../marketplace") : resolve3(import.meta.dir, "../..");
    for (const args of [["plugin", "marketplace", "add", root], ["plugin", "add", "codex-accounts@codex-accounts-local"], ["app-server", "daemon", "start"]]) {
      const p = Bun.spawn([binary, ...args], { env: { ...process.env, CODEX_HOME: codexHome }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      if (await p.exited !== 0)
        throw new Error("Instala\xE7\xE3o n\xE3o conclu\xEDda.");
    }
    console.log("Plugin instalado. Abra codex e revise/confie nos quatro hooks em /hooks. Depois inicie uma nova conversa.");
    return;
  }
  if (command === "list") {
    console.log((await store.names()).join(`
`) || "Nenhuma conta cadastrada.");
    return;
  }
  if (!["add", "capture"].includes(command) || !name || flag && flag !== "--device") {
    console.log(help);
    return;
  }
  const home = store.account(name);
  const unlock = await store.lock();
  let staging;
  try {
    if ((await store.names()).includes(name))
      throw new Error("Nome j\xE1 cadastrado. Escolha outro nome.");
    let raw;
    if (command === "capture")
      raw = await store.auth(codexHome);
    else {
      staging = join3(store.root, `login-${crypto.randomUUID()}`);
      await mkdir3(staging, { mode: 448 });
      const p = Bun.spawn([binary, "-c", 'cli_auth_credentials_store="file"', "login", ...flag ? ["--device-auth"] : []], {
        env: { ...process.env, CODEX_HOME: staging, CODEX_SQLITE_HOME: staging },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      });
      if (await p.exited !== 0)
        throw new Error("Login n\xE3o conclu\xEDdo.");
      raw = await store.auth(staging);
    }
    identity(raw);
    await store.saveAuth(home, raw);
    console.log(`Conta ${name} cadastrada.`);
  } finally {
    if (staging)
      await rm2(staging, { recursive: true, force: true });
    await unlock();
  }
}
if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : "Opera\xE7\xE3o n\xE3o conclu\xEDda.");
    process.exitCode = 1;
  });
