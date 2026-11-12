import { join } from "node:path";

const root = join(import.meta.dir, "..");
const steps = [
  { name: "TypeScript", args: ["run", "check"] },
  { name: "Testes unitários", args: ["test"] },
  { name: "Build do plugin", args: ["run", "build"] },
  { name: "Autenticação e histórico", args: ["tools/auth-hook-case.ts"] },
  { name: "CLI: troca manual, segurança, preferências e ciclo de vida", args: ["tools/native-cli-case.ts"] },
  { name: "CLI: autoswitch sem continuação", args: ["tools/native-cli-case.ts"], env: { AUTO_SWITCH_CASE: "1" } },
  { name: "CLI: autoswitch com continuação", args: ["tools/native-cli-case.ts"], env: { AUTO_SWITCH_CASE: "1", AUTO_CONTINUE_CASE: "1" } },
];
const started = Date.now();
for (const [i, step] of steps.entries()) {
  console.log(`\n[${i + 1}/${steps.length}] ${step.name}`);
  const proc = Bun.spawn([process.execPath, ...step.args], {
    cwd: root,
    env: { ...process.env, AUTO_SWITCH_CASE: "0", AUTO_CONTINUE_CASE: "0", KEEP_CASE: "", ...step.env },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`\nSuíte interrompida: ${step.name} (código ${exitCode}).`);
    process.exit(exitCode || 1);
  }
}
console.log(`\nSuíte concluída: ${steps.length} etapas em ${((Date.now() - started) / 1000).toFixed(1)}s.`);
