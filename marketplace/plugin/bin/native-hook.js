// @bun
// src/native-hook.ts
import { join as join2 } from "path";
import { rm, mkdir as mkdir2, readFile } from "fs/promises";

// src/native-paths.ts
import { createHash } from "crypto";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { mkdir, lstat, chmod } from "fs/promises";
var codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
var binary = process.env.CODEX_ACCOUNTS_CODEX ?? "codex";
var serviceDir = join(tmpdir(), `codex-accounts-${process.getuid?.() ?? "user"}-${createHash("sha256").update(codexHome).digest("hex").slice(0, 12)}`);
var socketPath = join(serviceDir, "backend.sock");
var endpointPath = join(serviceDir, "endpoint.json");
async function privateServiceDir() {
  await mkdir(serviceDir, { recursive: true, mode: 448 });
  const s = await lstat(serviceDir);
  if (!s.isDirectory() || s.isSymbolicLink() || process.getuid && s.uid !== process.getuid())
    throw new Error("Diret\xF3rio IPC inseguro.");
  await chmod(serviceDir, 448);
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

// src/native-hook.ts
async function post(event) {
  return fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify(event), signal: AbortSignal.timeout(2500) });
}
async function main() {
  const input = await Bun.stdin.text();
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }
  if (!["SessionStart", "PostModelRequest", "Stop", "Interrupt"].includes(event.hook_event_name))
    return;
  await privateServiceDir();
  try {
    const response = await post(event);
    console.log(await response.text());
    return;
  } catch {}
  const lock = join2(serviceDir, "starting");
  let acquired = false;
  try {
    try {
      await mkdir2(lock, { mode: 448 });
      acquired = true;
    } catch {}
    if (acquired) {
      let alive = false;
      try {
        const data = JSON.parse(await readFile(endpointPath, "utf8"));
        process.kill(data.pid, 0);
        alive = true;
      } catch {}
      if (!alive) {
        await rm(socketPath, { force: true });
        const script = join2(import.meta.dir, `native-backend.${import.meta.path.endsWith(".ts") ? "ts" : "js"}`);
        const p = Bun.spawn([process.execPath, script], { env: process.env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        p.unref();
      }
    }
    for (let attempt = 0;attempt < 25; attempt++) {
      await Bun.sleep(40);
      try {
        const response = await post(event);
        console.log(await response.text());
        return;
      } catch {}
    }
  } finally {
    if (acquired)
      await rm(lock, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ systemMessage: "Codex Accounts: backend local indispon\xEDvel." }));
}
if (import.meta.main)
  main().catch(() => {
    console.log(JSON.stringify({ systemMessage: "Codex Accounts: hook n\xE3o conclu\xEDdo." }));
  });
