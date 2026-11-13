import { join } from "node:path";

// A PTY and fake client exercise raw input and restoration without a real vault.
const modulePath = join(import.meta.dir, "../src/tui.ts");
const source = `
import { runTui } from ${JSON.stringify(modulePath)};
const state = { accounts: [{name:"one",current:true},{name:"two",current:false}],autoSwitch:false,autoContinue:false,resumeAfterReset:false };
await runTui({
  async state() { return structuredClone(state); },
  async request(event) {
    if (event.action === "usage") return {accounts:state.accounts};
    if (event.action === "settings") {
      for (const key of ["autoSwitch","autoContinue","resumeAfterReset"]) if (typeof event[key] === "boolean") state[key] = event[key];
      return {message:"Preferences saved."};
    }
    if (event.action === "switch") { state.accounts.forEach(a => a.current = a.name === event.account); return {message:"Switched to " + event.account}; }
    if (event.action === "remove") throw new Error("Fixture rejected removal");
    throw new Error("Unexpected operation");
  },
  async register() { throw new Error("Registration should be canceled"); }
});
console.log("TUI_RESTORED=" + !process.stdin.isRaw);
`;
let output = "";
const child = Bun.spawn([process.execPath, "-e", source], {
  cwd: join(import.meta.dir, ".."),
  terminal: { cols: 120, rows: 30, data(_terminal, bytes) { output += new TextDecoder().decode(bytes); } },
});
async function waitFor(text: string) {
  const deadline = Date.now() + 5000;
  while (!output.includes(text)) {
    if (Date.now() > deadline) throw new Error(`TUI did not render ${text}`);
    await Bun.sleep(20);
  }
}
async function press(key: string, expected: string) {
  output = "";
  child.terminal!.write(key);
  await waitFor(expected);
}
try {
  await waitFor("Ready. Quotas refreshed.");
  await press("\x1b[B", "> two");
  await press("\r", "Confirm switch two?");
  await press("n", "Canceled.");
  await press("\r", "Confirm switch two?");
  await press("y", "Switched to two");
  if (!output.includes("two * current")) throw new Error("TUI did not mark switched account");
  await press("w", "resumeAfterReset: ON");
  await press("a", "autoSwitch: ON");
  await press("c", "autoContinue: ON");
  await press("d", "Confirm remove two?");
  await press("y", "Fixture rejected removal");
  await press("n", "Add (device login) - name:");
  await press("\x1b", "Enter: switch");
  await press("q", "TUI_RESTORED=true");
  if (await child.exited !== 0) throw new Error("TUI exited unsuccessfully");
  if (!output.includes("\x1b[?25h") || !output.includes("\x1b[?1049l")) throw new Error("TUI left cursor or alternate screen active");
  console.log("TUI: navigation, confirmation/cancel, switching, independent preferences, error recovery and terminal restoration: OK");
} finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  child.terminal?.close();
}
