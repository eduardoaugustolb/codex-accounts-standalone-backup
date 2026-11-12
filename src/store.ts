import { mkdir, chmod, readFile, rename, writeFile, readdir, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export class Store {
  readonly root: string;
  constructor(root = process.env.CODEX_ACCOUNTS_HOME ?? join(homedir(), ".local/share/codex-accounts")) {
    this.root = resolve(root);
  }
  account(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Nome inválido: use letras, números, _ e - (até 64 caracteres).");
    return join(this.root, "accounts", name);
  }
  async init() {
    for (const path of [this.root, join(this.root, "accounts")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Diretório de dados não pode ser symlink.");
      await chmod(path, 0o700);
    }
  }
  async lock() {
    await this.init();
    const path = join(this.root, "lock");
    try { await mkdir(path, { mode: 0o700 }); }
    catch { throw new Error(`Outro codex-accounts está usando estes dados. Se houve uma queda, confirme que não está rodando antes de remover ${path}.`); }
    await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 });
    return async () => { await rm(path, { recursive: true }); };
  }
  async names() {
    const names = await readdir(join(this.root, "accounts"), { withFileTypes: true });
    const valid: string[] = [];
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      try { await this.auth(this.account(entry.name)); valid.push(entry.name); } catch {}
    }
    return valid.sort();
  }
  // Caller holds the vault lock, shared with login, switching and refresh.
  async remove(name: string) {
    const home = this.account(name);
    const entry = await lstat(home).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new Error(`Conta ${name} não cadastrada.`);
      throw e;
    });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Diretório de conta inválido.");
    await rm(home, { recursive: true });
  }
  async auth(home: string) {
    const path = join(home, "auth.json");
    if (!(await lstat(path)).isFile()) throw new Error("Cache de autenticação inválido.");
    const raw = await readFile(path, "utf8");
    let auth;
    try { auth = JSON.parse(raw); } catch { throw new Error("Cache de autenticação inválido."); }
    if (auth.auth_mode !== "chatgpt" || !auth.tokens?.refresh_token || !auth.tokens?.access_token) {
      throw new Error("É necessário um login ChatGPT válido, feito pelo fluxo oficial.");
    }
    return raw;
  }
  async saveAuth(home: string, raw: string) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const temp = join(home, `.auth-${crypto.randomUUID()}.tmp`);
    await writeFile(temp, raw, { mode: 0o600, flag: "wx" });
    await rename(temp, join(home, "auth.json"));
  }
}
