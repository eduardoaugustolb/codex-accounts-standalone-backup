import type { AccountUsage, UsageWindow } from "./account-details";

export interface TuiAccount { name: string; current: boolean; usage?: AccountUsage }
export interface TuiState {
  accounts: TuiAccount[];
  autoSwitch: boolean;
  autoContinue: boolean;
  resumeAfterReset: boolean;
  message?: string;
}
export interface TuiClient {
  state(): Promise<TuiState>;
  request(event: Record<string, unknown>): Promise<any>;
  register(command: "add" | "capture", name: string): Promise<void>;
}
type Modal = { type: "switch" | "remove" | "logout"; name?: string } | { type: "add" | "capture"; name: string };

// Service errors and terminal resize events must never inject terminal controls.
export function terminalText(value: string) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
export function usageText(window: UsageWindow | null | undefined, now = Date.now()) {
  if (!window) return "unknown";
  const filled = Math.round(window.remaining / 10);
  const bar = "#".repeat(filled) + "-".repeat(10 - filled);
  const minutes = window.resetsAt ? Math.max(0, Math.ceil((window.resetsAt * 1000 - now) / 60000)) : null;
  const reset = minutes === null ? "unknown" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  return `[${bar}] ${Math.round(window.remaining)}% left; reset ${reset}`;
}
export function moveSelection(index: number, direction: number, count: number) {
  return count ? (index + direction + count) % count : 0;
}
export function renderTui(state: TuiState, selected = 0, message = "", width = 100, height = 30, modal?: Modal) {
  width = Math.max(10, width);
  const on = (v: boolean) => v ? "ON" : "OFF";
  const rows = ["Codex Accounts", "", `Autoswitch ${on(state.autoSwitch)} | Continue on switch ${on(state.autoContinue)} | Continue after reset ${on(state.resumeAfterReset)}`, ""];
  const perAccount = width < 115 ? 3 : 1;
  const visible = Math.max(1, Math.floor((height - 12) / perAccount));
  const start = Math.max(0, selected - visible + 1);
  const accounts = state.accounts.slice(start, start + visible);
  if (!accounts.length) rows.push("No saved accounts. Press n to add one or s to capture the current login.");
  for (const [offset, account] of accounts.entries()) {
    const label = `${start + offset === selected ? ">" : " "} ${account.name}${account.current ? " * current" : ""}`;
    const five = account.usage?.unavailable ? "unavailable" : usageText(account.usage?.fiveHour);
    const week = account.usage?.unavailable ? "unavailable" : usageText(account.usage?.weekly);
    if (perAccount === 1) rows.push(`${label.padEnd(28)} 5h ${five} | Week ${week}`);
    else rows.push(label, `    5h   ${five}`, `    Week ${week}`);
  }
  if (state.accounts.length > visible) rows.push(`Accounts ${start + 1}-${start + accounts.length} of ${state.accounts.length}`);
  rows.push("", message || state.message || "Ready. Percentages show remaining capacity.", "");
  if (modal?.type === "add" || modal?.type === "capture") {
    rows.push(`${modal.type === "add" ? "Add (device login)" : "Capture current login"} - name: ${modal.name}_`, "Enter: save / start login | Esc: cancel");
  } else if (modal) {
    rows.push(`Confirm ${modal.type}${modal.name ? ` ${modal.name}` : ""}? This affects the shared session.`, "y: confirm | Any other key: cancel");
  } else {
    rows.push("Up/Down j/k: select | Enter: switch | r: refresh | q/Esc: quit", "a: autoswitch | c: continue on switch | w: continue after reset", "n: add | s: capture login | d: remove selected | l: logout");
  }
  return rows.slice(0, Math.max(1, height)).map((line, i) => {
    const text = terminalText(line).slice(0, width);
    return i === 0 ? `\x1b[1m${text}\x1b[0m` : text.startsWith("> ") ? `\x1b[7m${text}\x1b[0m` : i === 2 || text.startsWith("    ") ? `\x1b[2m${text}\x1b[0m` : text;
  }).join("\r\n");
}

/** Owns only this manager's terminal, never the official Codex terminal. */
export async function runTui(client: TuiClient) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The TUI requires an interactive terminal. Use usage --json for scripts.");
  let state: TuiState = { accounts: [], autoSwitch: false, autoContinue: false, resumeAfterReset: false };
  let selected = 0;
  let modal: Modal | undefined;
  let busy = false;
  let closed = false;
  let suspended = false;
  let message = "Loading saved accounts and quotas...";
  const previousRaw = process.stdin.isRaw;
  let finish: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const draw = () => {
    if (!closed && !suspended) process.stdout.write(`\x1b[H\x1b[2J${renderTui(state, selected, message, process.stdout.columns, process.stdout.rows, modal)}`);
  };
  const enter = () => {
    suspended = false;
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    process.stdin.setRawMode(true);
    process.stdin.resume();
  };
  const leave = () => {
    suspended = true;
    process.stdin.setRawMode(previousRaw ?? false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    process.stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", draw);
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
    if (!suspended) leave();
    process.stdin.pause();
    finish();
  };
  async function update(fresh: boolean) {
    const previousName = state.accounts[selected]?.name;
    state = await client.state();
    if (fresh) {
      const response = await client.request({ action: "usage" });
      state.accounts = response.accounts;
    }
    const index = state.accounts.findIndex(a => a.name === previousName);
    selected = index >= 0 ? index : Math.max(0, state.accounts.findIndex(a => a.current));
  }
  async function perform(work: () => Promise<void>) {
    if (busy || closed) return;
    busy = true;
    message = "Working...";
    draw();
    try { await work(); }
    catch (e) { message = e instanceof Error ? e.message : "Operation failed. Press r to retry."; }
    finally { busy = false; draw(); }
  }
  async function handle(key: string) {
    if (suspended || closed) return;
    if (key === "\x03" || key === "q" && !modal) { cleanup(); return; }
    if (busy) return;
    if (modal?.type === "add" || modal?.type === "capture") {
      if (key === "\x1b") { modal = undefined; draw(); return; }
      if (key === "\x7f" || key === "\b") modal.name = modal.name.slice(0, -1);
      else if (key === "\r" || key === "\n") {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(modal.name)) { message = "Use 1-64 letters, numbers, underscores or hyphens; start with a letter or number."; draw(); return; }
        const registration = modal;
        modal = undefined;
        await perform(async () => {
          leave();
          try { await client.register(registration.type as "add" | "capture", registration.name); }
          finally { if (!closed) enter(); }
          await update(true);
          message = `Account ${registration.name} saved.`;
        });
        return;
      } else if (/^[a-zA-Z0-9_-]+$/.test(key)) modal.name = (modal.name + key).slice(0, 64);
      draw(); return;
    }
    if (modal) {
      const action = modal;
      modal = undefined;
      if (key.toLowerCase() !== "y") { message = "Canceled."; draw(); return; }
      await perform(async () => {
        const result = await client.request({ action: action.type, account: action.name });
        await update(false);
        message = result.message ?? "Done.";
      });
      return;
    }
    if (key === "\x1b") { cleanup(); return; }
    if (key === "\x1b[A" || key === "k") selected = moveSelection(selected, -1, state.accounts.length);
    else if (key === "\x1b[B" || key === "j") selected = moveSelection(selected, 1, state.accounts.length);
    else if (key === "\r" || key === "\n" || key === "d") {
      const account = state.accounts[selected];
      if (account) modal = { type: key === "d" ? "remove" : "switch", name: account.name };
    } else if (key === "l") modal = { type: "logout" };
    else if (key === "n" || key === "s") modal = { type: key === "n" ? "add" : "capture", name: "" };
    else if (key === "r") { await perform(async () => { await update(true); message = "Quotas refreshed."; }); return; }
    else if (["a", "c", "w"].includes(key)) {
      const setting = key === "a" ? "autoSwitch" : key === "c" ? "autoContinue" : "resumeAfterReset";
      await perform(async () => {
        await client.request({ action: "settings", [setting]: !state[setting] });
        await update(false);
        message = `${setting}: ${state[setting] ? "ON" : "OFF"}.`;
      });
      return;
    }
    draw();
  }
  const onData = (data: Buffer) => { void handle(data.toString()).catch(e => { message = String(e); draw(); }); };
  const timer = setInterval(() => { if (!busy && !modal) void perform(async () => { await update(true); message = "Quotas refreshed."; }); }, 30000);
  process.stdin.on("data", onData);
  process.stdout.on("resize", draw);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  try {
    enter();
    draw();
    void perform(async () => { await update(true); message = "Ready. Quotas refreshed."; });
    await done;
  } finally { cleanup(); }
}
