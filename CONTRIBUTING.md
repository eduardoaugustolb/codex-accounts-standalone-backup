# Contribuindo

Use Bun como runtime e gerenciador de pacotes. O ambiente validado usa Linux, Bun 1.4.4 e Codex CLI 0.167.2.

```bash
bun install --frozen-lockfile
bun run test:all
```

A suíte executa checagem de tipos, testes unitários, build e integrações com o CLI oficial, incluindo troca manual e autoswitch com a continuação ativada e desativada. Precisa do binário `codex` no PATH, sockets locais, pseudoterminal e espaço para instalações temporárias do daemon. `CODEX_ACCOUNTS_CODEX` permite selecionar outro binário. `TMPDIR` permite selecionar um diretório temporário com espaço disponível; mantenha o caminho curto por causa dos sockets Unix.

Os cenários isolam `CODEX_HOME`, usam contas fictícias e encerram seus processos ao terminar. A suíte para na primeira etapa que falhar. Use `bun test` para o ciclo rápido de testes unitários. Os scripts individuais continuam disponíveis para diagnosticar uma etapa.

Abra uma issue com o comportamento esperado e passos reproduzíveis antes de mudanças grandes. Em pull requests, explique problema, alteração e validação. Mudanças no protocolo devem incluir um teste reproduzível e a versão do CLI utilizada. Atualize a documentação quando mudar uma preferência ou comportamento.

Não inclua credenciais, diretórios pessoais de configuração ou artefatos de teste. Siga [SECURITY.md](SECURITY.md) para vulnerabilidades.
