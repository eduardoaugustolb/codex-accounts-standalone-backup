#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Store } from "./store";
import { binary, codexHome, endpointPath, identity, socketPath } from "./native-paths";

async function main() {
  const [command, name, flag] = process.argv.slice(2);
  const help = "Contas para o Codex oficial:\n  add NOME [--device]\n  capture NOME\n  remove NOME\n  list\n  install\n  start\n  restart\n  panel\n  status\n  stop\n  logout";
  if (!command || ["--help", "-h", "help"].includes(command)) {
    console.log(help); return;
  }
  const store = new Store(); await store.init();
  if (command === "remove") {
    if (!name || flag) throw new Error("Use: remove NOME");
    store.account(name);
  }
  if (["status", "panel", "stop", "start", "restart", "logout", "remove"].includes(command)) {
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
