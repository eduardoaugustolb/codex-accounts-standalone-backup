import { expect, test } from "bun:test";
import { moveSelection, renderTui, terminalText, usageText, type TuiState } from "../src/tui";

const state: TuiState = {
  accounts: [{ name: "personal", current: true, usage: { fiveHour: { remaining: 40, resetsAt: 3600 }, weekly: { remaining: 70, resetsAt: null }, updatedAt: 0 } }, { name: "work", current: false }],
  autoSwitch: false, autoContinue: false, resumeAfterReset: true,
};
test("terminal account list uses remaining quotas and independent preferences", () => {
  const screen = terminalText(renderTui(state, 0, "", 140, 30));
  expect(screen).toContain("personal * current");
  expect(screen).toContain("40% left");
  expect(screen).toContain("70% left");
  expect(screen).toContain("Autoswitch OFF");
  expect(screen).toContain("Continue after reset ON");
  expect(screen).toContain("unknown");
  expect(usageText({ remaining: 0, resetsAt: 3600 }, 0)).toContain("reset 1h0m");
});
test("navigation wraps safely and keeps selected accounts visible on small terminals", () => {
  expect(moveSelection(0, -1, 2)).toBe(1);
  expect(moveSelection(1, 1, 2)).toBe(0);
  expect(moveSelection(0, 1, 0)).toBe(0);
  const screen = terminalText(renderTui(state, 1, "", 45, 18));
  expect(screen).toContain("> work");
  for (const line of renderTui(state, 1, "", 45, 18).split("\r\n")) expect(terminalText(line).length).toBeLessThanOrEqual(45);
});
test("terminal theme inherits default colors and strips controls from service messages", () => {
  const screen = renderTui(state, 0, "failure\x1b[2J\x07\nmessage", 140, 30);
  expect(screen).toContain("\x1b[1mCodex Accounts");
  expect(screen).toContain("\x1b[7m> personal");
  expect(screen).not.toContain("\x1b[2J");
  expect(screen).not.toContain("\x07");
  expect(screen).not.toMatch(/\x1b\[(?:3[0-7]|4[0-7]|38;|48;)/);
});
