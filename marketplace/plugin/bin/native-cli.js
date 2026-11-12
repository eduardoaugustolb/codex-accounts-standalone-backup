#!/usr/bin/env bun
// @bun

// src/native-cli.ts
import { mkdir as mkdir3, rm as rm2 } from "fs/promises";
import { join as join3, resolve as resolve3 } from "path";

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
  const [command, name, flag] = process.argv.slice(2);
  const help = `Contas para o Codex oficial:
  add NOME [--device]
  capture NOME
  remove NOME
  list
  install
  start
  restart
  panel
  status
  stop
  logout`;
  if (!command || ["--help", "-h", "help"].includes(command)) {
    console.log(help);
    return;
  }
  const store = new Store;
  await store.init();
  if (command === "remove") {
    if (!name || flag)
      throw new Error("Use: remove NOME");
    store.account(name);
  }
  if (["status", "panel", "stop", "start", "restart", "logout", "remove"].includes(command)) {
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
