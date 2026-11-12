interface Client { call(method: string, params?: unknown): Promise<any> }
interface InterruptedTurn { threadId: string; turnId: string }

function quotaFailure(turn: any) {
  return turn?.status === "failed" && /usage.?limit|usage_limit_reached|quota.{0,30}exceed/i.test(JSON.stringify(turn.error ?? ""));
}

/** Capture only loaded conversations whose latest turn failed because of quota. */
export async function interruptedTurns(client: Client): Promise<InterruptedTurn[]> {
  const interrupted: InterruptedTurn[] = [];
  let cursor: string | undefined;
  do {
    const loaded = await client.call("thread/loaded/list", { cursor });
    for (const threadId of loaded.data) {
      const { thread } = await client.call("thread/read", { threadId });
      if (thread.ephemeral || thread.status.type === "active") continue;
      const turns = await client.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
      const last = turns.data?.[0];
      if (thread.status.type !== "active" && quotaFailure(last)) interrupted.push({ threadId, turnId: last.id });
    }
    cursor = loaded.nextCursor ?? undefined;
  } while (cursor);
  return interrupted;
}

export async function continueTurns(client: Client, interrupted: InterruptedTurn[], enabled = () => true) {
  let count = 0;
  for (const { threadId, turnId } of interrupted) {
    if (!enabled()) break;
    const { thread } = await client.call("thread/read", { threadId });
    if (thread.ephemeral || thread.status.type === "active") continue;
    const turns = await client.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
    const last = turns.data?.[0];
    // A user may have continued, cancelled, or started another turn during login.
    if (!enabled() || thread.status.type === "active" || last?.id !== turnId || !quotaFailure(last)) continue;
    // Do not retry this RPC on timeout: the server may already have accepted it.
    await client.call("turn/start", { threadId, input: [{ type: "text", text: "continue" }] });
    count++;
  }
  return count;
}
