import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, lstat, chmod } from "node:fs/promises";

export const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
export const binary = process.env.CODEX_ACCOUNTS_CODEX ?? "codex";
export const serviceDir = join(tmpdir(), `codex-accounts-${process.getuid?.() ?? "user"}-${createHash("sha256").update(codexHome).digest("hex").slice(0, 12)}`);
export const socketPath = join(serviceDir, "backend.sock");
export const endpointPath = join(serviceDir, "endpoint.json");
export async function privateServiceDir() {
  await mkdir(serviceDir, { recursive: true, mode: 0o700 });
  const s = await lstat(serviceDir);
  if (!s.isDirectory() || s.isSymbolicLink() || (process.getuid && s.uid !== process.getuid())) throw new Error("Diretório IPC inseguro.");
  await chmod(serviceDir, 0o700);
}
export function identity(raw: string): { accountId: string; accessToken: string; plan: string | null; expires: number } {
  try {
    const a = JSON.parse(raw);
    const t = a.tokens;
    const claims = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString());
    const access = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url").toString());
    const accountId = t.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error();
    return { accountId, accessToken: t.access_token, plan: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null, expires: Number(access.exp ?? 0) };
  } catch { throw new Error("Credenciais ChatGPT sem identidade válida."); }
}
