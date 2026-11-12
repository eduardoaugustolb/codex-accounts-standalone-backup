import { join } from "node:path";
import { rm, mkdir, readFile } from "node:fs/promises";
import { endpointPath, privateServiceDir, serviceDir, socketPath } from "./native-paths";

async function post(event: unknown) {
  return fetch("http://localhost/event", { unix: socketPath, method: "POST", body: JSON.stringify(event), signal: AbortSignal.timeout(2500) });
}
async function main() {
  const input = await Bun.stdin.text();
  let event: any;
  try { event = JSON.parse(input); } catch { return; }
  if (!["SessionStart", "PostModelRequest", "Stop", "Interrupt"].includes(event.hook_event_name)) return;
  await privateServiceDir();
  try { const response = await post(event); console.log(await response.text()); return; } catch {}
  const lock = join(serviceDir, "starting");
  let acquired = false;
  try {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; } catch {}
    if (acquired) {
      let alive = false;
      try { const data = JSON.parse(await readFile(endpointPath, "utf8")); process.kill(data.pid, 0); alive = true; } catch {}
      if (!alive) {
        await rm(socketPath, { force: true });
        const script = join(import.meta.dir, `native-backend.${import.meta.path.endsWith(".ts") ? "ts" : "js"}`);
        const p = Bun.spawn([process.execPath, script], { env: process.env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); p.unref();
      }
    }
    for (let attempt = 0; attempt < 25; attempt++) {
      await Bun.sleep(40);
      try { const response = await post(event); console.log(await response.text()); return; } catch {}
    }
  } finally { if (acquired) await rm(lock, { recursive: true, force: true }); }
  console.log(JSON.stringify({ systemMessage: "Codex Accounts: backend local indisponível." }));
}
if (import.meta.main) main().catch(() => { console.log(JSON.stringify({ systemMessage: "Codex Accounts: hook não concluído." })); });
