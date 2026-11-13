#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runTui, type TuiState } from "./tui";
import { Store } from "./store";
import { binary, codexHome, endpointPath, identity, socketPath } from "./native-paths";

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
  if (!command || args.some(a => ["--help", "-h", "help"].includes(a))) {
    console.log(help); return;
  }
  const valid = ["tui", "add", "capture", "list", "usage", "switch", "resume-after-reset", "remove", "logout", "panel", "status", "start", "restart", "stop", "install"];
  if (!valid.includes(command)) throw new Error(`Unknown command: ${command}. Run --help.`);
  if (command === "usage" ? args.slice(1).filter(a => a !== "--json").length > 1 || args.slice(1).some(a => a.startsWith("--") && a !== "--json")
    : command === "resume-after-reset" ? !["on", "off"].includes(name ?? "") || args.length !== 2
    : ["switch", "remove", "capture"].includes(command) ? !name || args.length !== 2
    : command === "add" ? !name || args.length > 3 || Boolean(flag && flag !== "--device")
    : args.length !== (requestedCommand ? 1 : 0)) throw new Error("Invalid arguments. Run --help.");
  if (command === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("The TUI requires an interactive terminal. Use usage --json for scripts.");
  const store = new Store(); await store.init();
  if (command === "remove") {
    if (!name || flag) throw new Error("Use: remove NOME");
    store.account(name);
  }
  if (["status", "panel", "stop", "start", "restart", "logout", "remove", "usage", "switch", "resume-after-reset", "tui"].includes(command)) {
    async function state() {
      try {
        const response = await fetch("http://localhost/state", { unix: socketPath, signal: AbortSignal.timeout(1000) });
        if (!response.ok) return null;
        return await response.json() as { url: string };
      } catch { return null; }
    }
    async function stop() {
      if (!await state()) return;
      const result = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify({ action: "shutdown" }), signal: AbortSignal.timeout(3000) });
      if (!result.ok) throw new Error("Backend não confirmou o encerramento.");
      for (let i = 0; i < 60; i++) {
        if (!await Bun.file(endpointPath).exists() && !await state()) return;
        await Bun.sleep(50);
      }
      throw new Error("Backend ainda está encerrando. Tente novamente.");
    }
    if (command === "stop") {
      await stop();
      console.log("Backend parado. Use panel ou start para iniciar novamente.");
      return;
    }
    if (command === "restart") await stop();
    let endpoint = await state();
    if (!endpoint && command === "status") { console.log("Backend parado. Use bun run start panel para iniciar."); return; }
    if (!endpoint) {
      const script = join(import.meta.dir, `native-hook.${import.meta.path.endsWith(".ts") ? "ts" : "js"}`);
      const p = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
      p.stdin.write(JSON.stringify({ hook_event_name: "SessionStart" }));
      p.stdin.end();
      await p.exited;
      endpoint = await state();
      if (!endpoint) throw new Error("Não foi possível iniciar o backend local.");
    }
    if (command === "tui") {
      await runTui({
        async state() {
          const response = await fetch("http://localhost/state", { unix: socketPath, signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error("Backend unavailable. Restart it and reopen the TUI.");
          return await response.json() as TuiState;
        },
        async request(event) {
          const response = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify(event), signal: AbortSignal.timeout(120000) });
          const body = await response.json() as any;
          if (!response.ok) throw new Error(body.error ?? "Operation failed.");
          return body;
        },
        async register(action, account) {
          const child = Bun.spawn([process.execPath, import.meta.path, action, account, ...(action === "add" ? ["--device"] : [])], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
          if (await child.exited !== 0) throw new Error("Registration failed. Existing accounts were preserved.");
        },
      });
      return;
    }
    if (["usage", "switch", "resume-after-reset"].includes(command)) {
      const account = command === "usage" ? args.slice(1).find(a => a !== "--json") : name;
      const result = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify({ action: command, account, enabled: name === "on" }), signal: AbortSignal.timeout(120000) });
      const body = await result.json() as any;
      if (!result.ok) throw new Error(body.error ?? "Operation failed.");
      if (command !== "usage") console.log(body.message);
      else if (args.includes("--json")) console.log(JSON.stringify(body, null, 2));
      else for (const a of body.accounts) {
        const window = (w: any) => w ? `${w.remaining}% remaining; resets ${w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : "unknown"}` : "unknown";
        console.log(`${a.name}${a.current ? " (current)" : ""}\n  5h: ${window(a.usage?.fiveHour)}\n  Weekly: ${window(a.usage?.weekly)}${a.usage?.unavailable ? "\n  Quotas unavailable" : ""}`);
      }
      return;
    }
    if (command === "logout" || command === "remove") {
      const result = await fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify({ action: command, account: name }), signal: AbortSignal.timeout(20000) });
      const body = await result.json() as { message?: string; error?: string };
      if (!result.ok) throw new Error(body.error ?? "Operação não concluída.");
      console.log(body.message); return;
    }
    console.log(endpoint.url); if (command === "panel" && process.env.CODEX_ACCOUNTS_NO_BROWSER !== "1") {
      const p = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", endpoint.url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); await p.exited;
    }
    return;
  }
  if (command === "install") {
    const root = import.meta.path.endsWith(".ts") ? resolve(import.meta.dir, "../marketplace") : resolve(import.meta.dir, "../..");
    for (const args of [["plugin", "marketplace", "add", root], ["plugin", "add", "codex-accounts@codex-accounts-local"], ["app-server", "daemon", "start"]]) {
      const p = Bun.spawn([binary, ...args], { env: { ...process.env, CODEX_HOME: codexHome }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      if (await p.exited !== 0) throw new Error("Instalação não concluída.");
    }
    console.log("Plugin instalado. Abra codex e revise/confie nos quatro hooks em /hooks. Depois inicie uma nova conversa."); return;
  }
  if (command === "list") { console.log((await store.names()).join("\n") || "Nenhuma conta cadastrada."); return; }
  if (!["add", "capture"].includes(command) || !name || (flag && flag !== "--device")) {
    console.log(help); return;
  }
  const home = store.account(name); const unlock = await store.lock();
  let staging: string | undefined;
  try {
    if ((await store.names()).includes(name)) throw new Error("Nome já cadastrado. Escolha outro nome.");
    let raw: string;
    if (command === "capture") raw = await store.auth(codexHome);
    else {
      staging = join(store.root, `login-${crypto.randomUUID()}`); await mkdir(staging, { mode: 0o700 });
      const p = Bun.spawn([binary, "-c", 'cli_auth_credentials_store="file"', "login", ...(flag ? ["--device-auth"] : [])], {
        env: { ...process.env, CODEX_HOME: staging, CODEX_SQLITE_HOME: staging }, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
      if (await p.exited !== 0) throw new Error("Login não concluído.");
      raw = await store.auth(staging);
    }
    identity(raw); await store.saveAuth(home, raw); console.log(`Conta ${name} cadastrada.`);
  } finally { if (staging) await rm(staging, { recursive: true, force: true }); await unlock(); }
}
if (import.meta.main) main().catch(e => { console.error(e instanceof Error ? e.message : "Operação não concluída."); process.exitCode = 1; });
