import { expect, test } from "bun:test";
import { renderAccountPanel } from "../src/account-panel";

test("account labels and emails remain text and all actions retain CSRF protection", () => {
  const html = renderAccountPanel([{ name: "pessoal", email: '<script>alert("email")</script>', current: true }, { name: "secundaria", email: null, current: false }], "token", "csrf-token", "<error>", false);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('<script>');
  expect(html).toContain("Email não disponível");
  expect(html).toContain("Conta atual");
  expect(html).toContain("&lt;error&gt;");
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g)!;
  expect(forms.length).toBeGreaterThan(0);
  for (const form of forms) expect(form).toContain('name="csrf" value="csrf-token"');
});

test("plan limits render remaining amounts and reset times in separate windows", () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const html = renderAccountPanel([{ name: "pessoal", email: "test@example.invalid", current: false, usage: {
    fiveHour: { remaining: 31, resetsAt: reset }, weekly: { remaining: 89, resetsAt: reset + 6 * 86400 }, updatedAt: Date.now(),
  } }], "token", "csrf", "", false);
  expect(html).toContain("Limites do plano");
  expect(html).toContain("Limite a cada 5 horas");
  expect(html).toContain("Limite semanal");
  expect(html).toContain("31% restante");
  expect(html).toContain("89% restante");
  expect(html).toContain("Reinicia em");
  expect(html).toContain('value="31"');
});

test("automatic continuation is opt-in and reflects the saved preference", () => {
  expect(renderAccountPanel([], "token", "csrf", "", false)).toContain('name="autoContinue" >');
  const enabled = renderAccountPanel([], "token", "csrf", "", false, true, true);
  expect(enabled).toContain('name="autoContinue" checked');
  expect(enabled).toContain('Continuar automaticamente ao trocar de conta');
});

test("quota reset continuation is an independent opt-in preference", () => {
  expect(renderAccountPanel([], "token", "csrf", "", false)).toContain('name="resumeAfterReset" >');
  const enabled = renderAccountPanel([], "token", "csrf", "", false, false, false, true);
  expect(enabled).toContain('name="resumeAfterReset" checked');
  expect(enabled).toContain('name="autoSwitch" >');
  expect(enabled).toContain('name="autoContinue" >');
});
