import WebSocket from "ws";

abstract class RpcPeer {
  private seq = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; method: string; timer: ReturnType<typeof setTimeout> }>();
  onNotification: (message: any) => void = () => {};
  // Requests are broadcast to multiple clients. Ignore requests owned by the
  // native TUI (especially approvals), instead of racing it with an error.
  onRequest: (message: any) => Promise<unknown> = async () => undefined;
  protected disconnected() {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Conexão com Codex encerrada.")); }
      this.pending.clear();
  }
  abstract send(message: unknown): void;
  call(method: string, params: unknown = {}, timeout = 15000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout RPC: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, method, timer });
      try { this.send({ id, method, params }); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("Conexão com Codex indisponível.")); }
    });
  }
  async initialize(experimental = false) {
    await this.call("initialize", { clientInfo: { name: "codex_accounts", version: "0.2.0" }, capabilities: { experimentalApi: experimental } });
    this.send({ method: "initialized", params: {} });
  }
  protected receive(msg: any) {
    if (msg.method && msg.id !== undefined) {
      void this.onRequest(msg).then(result => { if (result !== undefined) this.send({ id: msg.id, result }); }, () => this.send({ id: msg.id, error: { code: -32603, message: "Local account backend failed" } })).catch(() => {});
    } else if (msg.method) this.onNotification(msg);
    else {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`RPC rejeitada: ${p.method} (${msg.error.code}).`)); else p.resolve(msg.result);
    }
  }
}

/** Spawn a separate official app-server with JSONL stdio. */
export class Rpc extends RpcPeer {
  readonly proc;
  readonly done: Promise<void>;
  constructor(binary: string, args: string[], env: Record<string, string | undefined>) {
    super();
    this.proc = Bun.spawn([binary, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.done = this.read().catch(() => {}).finally(() => this.disconnected());
  }
  send(message: unknown) { this.proc.stdin.write(JSON.stringify(message) + "\n"); this.proc.stdin.flush(); }
  private async read() {
    let buffer = "";
    for await (const chunk of this.proc.stdout.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        this.receive(JSON.parse(line));
      }
    }
  }
  async close() {
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill("SIGKILL"), 2000);
    try { await this.proc.exited; await this.done; } finally { clearTimeout(timer); }
  }
}

/** Attach to the existing official daemon. Its Unix socket speaks WebSocket. */
export class UnixRpc extends RpcPeer {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  constructor(socketPath: string) {
    super();
    this.socket = new WebSocket(`ws+unix:${socketPath}:/`, { handshakeTimeout: 3000, perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () => reject(new Error("Daemon oficial indisponível. Inicie codex app-server daemon start e reabra o Codex.")));
    });
    // Consume eagerly; initialize also observes the same rejection.
    void this.ready.catch(() => {});
    this.socket.on("message", raw => { try { this.receive(JSON.parse(String(raw))); } catch { this.socket.terminate(); } });
    this.socket.on("close", () => this.disconnected());
  }
  get closed() { return this.socket.readyState === WebSocket.CLOSED; }
  send(message: unknown) { this.socket.send(JSON.stringify(message)); }
  async initialize(experimental = false) { await this.ready; await super.initialize(experimental); }
  async close() { this.socket.terminate(); this.disconnected(); }
}
