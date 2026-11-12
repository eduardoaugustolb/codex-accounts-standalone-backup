import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnixRpc } from "../src/rpc";

test("sidecar handles auth refresh without answering approvals owned by native CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-rpc-test-"));
  const path = join(home,"server.sock");
  const answers: any[] = [];
  const server = Bun.serve({ unix: path, fetch(req, server) {
    if (server.upgrade(req, {data:undefined})) return;
    return new Response("WebSocket required",{status:400});
  }, websocket: { data: undefined as undefined, message(ws, raw) {
    const m = JSON.parse(String(raw));
    if (m.method === "initialize") ws.send(JSON.stringify({id:m.id,result:{}}));
    else if (m.method === "initialized") {
      ws.send(JSON.stringify({id:900,method:"item/commandExecution/requestApproval",params:{}}));
      ws.send(JSON.stringify({id:901,method:"account/chatgptAuthTokens/refresh",params:{}}));
    } else if (m.id) answers.push(m);
  } } });
  const client = new UnixRpc(path);
  client.onRequest = async m => m.method === "account/chatgptAuthTokens/refresh" ? {marker:"fake-refresh"} : undefined;
  try {
    await client.initialize(true);
    const deadline = Date.now()+2000;
    while (!answers.length) { if (Date.now()>deadline) throw new Error("No auth refresh response"); await Bun.sleep(10); }
    expect(answers).toEqual([{id:901,result:{marker:"fake-refresh"}}]);
  } finally { await client.close(); server.stop(true); await rm(home,{recursive:true,force:true}); }
});
