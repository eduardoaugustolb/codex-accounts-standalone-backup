import { expect, test } from "bun:test";
import { interruptedTurns, continueTurns } from "../src/auto-continue";

function fixture() {
  const threads: Record<string, any> = {
    quota: { status: { type: "idle" }, turns: [{ id: "failed", status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } }] },
    completed: { status: { type: "idle" }, turns: [{ id: "ok", status: "completed" }] },
    other: { status: { type: "idle" }, turns: [{ id: "network", status: "failed", error: { message: "network" } }] },
    active: { status: { type: "active" }, turns: [{ id: "busy", status: "failed", error: { message: "usage_limit_reached" } }] },
    ephemeral: { ephemeral: true, status: { type: "idle" }, turns: [] },
  };
  const starts: any[] = [];
  const client = { async call(method: string, params?: any): Promise<any> {
    if (method === "thread/loaded/list") return params.cursor ? { data: ["other", "active", "ephemeral"] } : { data: ["quota", "completed"], nextCursor: "page2" };
    if (method === "thread/read") return { thread: threads[params.threadId] };
    if (method === "thread/turns/list") { expect(params.threadId).not.toBe("ephemeral"); expect(params.limit).toBe(1); expect(params.sortDirection).toBe("desc"); return { data: threads[params.threadId].turns.slice(-1) }; }
    starts.push(params);
    threads[params.threadId].status.type = "active";
    return {};
  } };
  return { client, threads, starts };
}

test("continues only quota failures in the same conversation, once", async () => {
  const { client, starts } = fixture();
  const interrupted = await interruptedTurns(client);
  expect(interrupted).toEqual([{ threadId: "quota", turnId: "failed" }]);
  expect(await continueTurns(client, interrupted)).toBe(1);
  expect(await continueTurns(client, interrupted)).toBe(0);
  expect(starts).toEqual([{ threadId: "quota", input: [{ type: "text", text: "continue" }] }]);
});

test("skips changed conversations and disabled preferences", async () => {
  const { client, threads, starts } = fixture();
  const interrupted = await interruptedTurns(client);
  expect(await continueTurns(client, interrupted, () => false)).toBe(0);
  threads.quota.turns.push({ id: "user-turn", status: "completed" });
  expect(await continueTurns(client, interrupted)).toBe(0);
  expect(starts).toEqual([]);
});

test("does not retry uncertain turn submissions", async () => {
  const { client } = fixture();
  const interrupted = await interruptedTurns(client);
  let submitted = 0;
  const failing = { async call(method: string, params?: any) {
    if (method === "turn/start") { submitted++; throw new Error("timeout"); }
    return client.call(method, params);
  } };
  await expect(continueTurns(failing, interrupted)).rejects.toThrow("timeout");
  expect(submitted).toBe(1);
});
