// Tests the installed official Codex against a loopback-only fake model service.
// No actual account credentials or real model requests are used.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Rpc } from "../src/rpc";
import { fakeAuth } from "./fixtures/fake-auth";

const home = await mkdtemp(join(tmpdir(), "codex-auth-hook-case-"));
const binary = process.env.CODEX_ACCOUNTS_CODEX ?? "codex";
const seen: { account: string | null; input: unknown }[] = [];
const events: any[] = [];
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/responses")) {
    seen.push({ account: req.headers.get("chatgpt-account-id"), input: await req.json() });
    const responseId = `resp_${seen.length}`;
    const items = [{ type: "response.created", response: { id: responseId } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `msg_${seen.length}`, content: [{ type: "output_text", text: "MOCK_OK" }] } },
      { type: "response.completed", response: { id: responseId, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(items.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
  if (path.endsWith("/models")) return Response.json({ models: [] });
  return Response.json({});
} });
let rpc: Rpc | undefined;
try {
  await mkdir(join(home, "project"));
  await Bun.write(join(home, "auth.json"), JSON.stringify(fakeAuth("account-A")));
  await Bun.write(join(home, "replacement.json"), JSON.stringify(fakeAuth("account-B")));
  const hook = join(home, "hook.ts");
  await Bun.write(hook, `import { appendFile, rename, copyFile } from 'node:fs/promises';
const m = JSON.parse(await Bun.stdin.text());
await appendFile(${JSON.stringify(join(home, "hook-events.jsonl"))}, JSON.stringify(m)+'\\n');
if (m.hook_event_name === 'PostModelRequest') {
 await copyFile(${JSON.stringify(join(home, "replacement.json"))}, ${JSON.stringify(join(home, "auth.next"))});
 await rename(${JSON.stringify(join(home, "auth.next"))}, ${JSON.stringify(join(home, "auth.json"))});
}
`);
  const url = `http://127.0.0.1:${model.port}`;
  await Bun.write(join(home, "config.toml"), `model = "gpt-5.4"
model_provider = "localtest"
cli_auth_credentials_store = "file"
chatgpt_base_url = "${url}"
check_for_update_on_startup = false
[model_providers.localtest]
name = "Local test"
base_url = "${url}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`);
  await Bun.write(join(home, "hooks.json"), JSON.stringify({ hooks: { PostModelRequest: [{ hooks: [{ type: "command", command: `${Bun.which("bun")} ${hook}`, timeout: 5 }] }] } }));
  rpc = new Rpc(binary, ["app-server"], {
    ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_ACCESS_TOKEN: "", CODEX_SQLITE_HOME: home,
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
  });
  rpc.onNotification = m => events.push(m);
  await rpc.initialize(true);
  const start = await rpc.call("thread/start", { cwd: join(home, "project"), approvalPolicy: "never", sandbox: "read-only", config: { bypass_hook_trust: true } });
  const threadId = start.thread.id;
  async function turn(text: string) {
    const from = events.length;
    await rpc!.call("turn/start", { threadId, input: [{ type: "text", text }] });
    const deadline = Date.now() + 15000;
    while (!events.slice(from).some(m => m.method === "turn/completed")) {
      if (Date.now() > deadline) throw new Error("Turn timed out: " + JSON.stringify(events.slice(from).map(m => ({ method:m.method, error:m.params?.error, turn:m.params?.turn }))));
      await Bun.sleep(25);
    }
    const end = events.slice(from).find(m => m.method === "turn/completed");
    if (end.params.turn.status !== "completed") throw new Error("Turn failed: " + JSON.stringify(end));
  }
  await turn("Remember the marker PERSIST_CONTEXT_42.");
  await turn("Repeat the marker.");
  if (seen[0]?.account !== "account-A" || seen[1]?.account !== "account-A" || (await Bun.file(join(home,"auth.json")).json()).tokens.account_id !== "account-B") throw new Error("Unexpected file reload behavior");
  if (!JSON.stringify(seen[1]?.input).includes("PERSIST_CONTEXT_42")) throw new Error("Second turn lost history");
  console.log(JSON.stringify({ case: "file-swap-in-PostModelRequest", requests: seen.map(s => s.account), diskAccount: (await Bun.file(join(home,"auth.json")).json()).tokens.account_id,
    hookEvents: (await Bun.file(join(home,"hook-events.jsonl")).text()).trim().split("\n").map(s => JSON.parse(s).hook_event_name),
    secondRequestHasHistory: JSON.stringify(seen[1]?.input).includes("PERSIST_CONTEXT_42") }, null, 2));
  await rpc.call("account/login/start", { type: "chatgptAuthTokens", accessToken: fakeAuth("account-B").tokens.access_token, chatgptAccountId: "account-B", chatgptPlanType: "plus" });
  await turn("Continue after the account change.");
  if (seen[2]?.account !== "account-B" || !JSON.stringify(seen[2]?.input).includes("PERSIST_CONTEXT_42")) throw new Error("RPC switch failed to preserve identity/history");
  console.log(JSON.stringify({ case: "RPC-switch-same-process-same-thread", requests: seen.map(s => s.account), thirdRequestHasHistory: JSON.stringify(seen[2]?.input).includes("PERSIST_CONTEXT_42") }, null, 2));
} finally {
  await rpc?.close(); model.stop(true);
  if (process.env.KEEP_CASE) console.log(`Artifacts: ${home}`); else await rm(home, { recursive: true, force: true });
}
