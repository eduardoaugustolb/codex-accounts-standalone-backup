# Instruções para agentes

## Runtime

Use sempre **Bun** como runtime e gerenciador de pacotes: `bun install`, `bun run <script>`, `bun <arquivo>` e `bunx --bun <pacote>`. Não use npm, npx ou Node para executar o projeto. Não crie `package-lock.json`; mantenha `bun.lock` atualizado quando mudar dependências.

## Mapa do projeto

- `src/native-backend.ts`: painel HTTP local, IPC Unix, monitor de limites e troca de conta.
- `src/auto-continue.ts`: identificação de turnos interrompidos por cota e continuação na mesma conversa.
- `src/native-cli.ts`: comandos, instalação e ciclo de vida do backend.
- `src/native-hook.ts`: encaminhamento dos quatro eventos de hook.
- `src/rpc.ts`: comunicação com App Server oficial e helpers isolados.
- `src/store.ts`: vault, permissões, locks e persistência de credenciais.
- `src/account-panel.ts`, `src/panel-live.ts`, `src/panel-navigation.ts`: interface local.
- `test/`: testes unitários com `bun:test`.
- `tools/test-suite.ts`: suíte completa e sequencial.
- `tools/*-case.ts`: integrações isoladas com o binário oficial e serviços fictícios.
- `marketplace/`: manifesto, hooks e executáveis compilados distribuídos pelo plugin.

## Desenvolvimento e validação

```bash
bun install --frozen-lockfile
bun run test:all
```

A suíte completa verifica tipos, testes unitários, build, autenticação, troca manual e autoswitch com e sem continuação. Execute-a antes de publicar mudanças em autenticação, hooks, RPC ou ciclo de vida. Para alterações pontuais, use inicialmente `bun test` e `bun run check`; antes de publicar, cumpra a validação compatível com o escopo. Não esconda testes falhos e não marque integrações como aprovadas sem executá-las.

Requisitos validados: Linux, Bun 1.4.4 e Codex CLI 0.167.2. Integrações precisam de sockets locais, pseudoterminal e espaço para o daemon temporário. Use `CODEX_ACCOUNTS_CODEX` para selecionar um binário. Se definir `TMPDIR`, escolha um caminho curto e com espaço suficiente. Não execute casos individualmente por rotina: prefira a suíte. Use casos isolados apenas para investigar falhas.

Ao alterar `src/`, regenere `marketplace/plugin/bin` com `bun run build` e inclua os artefatos atualizados. Não edite os bundles manualmente. Atualize README e documentação de validação quando mudar comportamento ou preferências.

## Autenticação e segurança

- Nunca leia ou exponha tokens reais para depuração. Não inclua `auth.json`, cookies, emails pessoais, conversas privadas ou URLs secretas do painel em commits, logs ou issues.
- Testes devem usar `CODEX_HOME` e vault temporários, identidades fictícias e endpoints locais. Não use uma conta real nem consuma cota externa para validar o plugin.
- Preserve diretórios `0700`, credenciais `0600`, escrita atômica e locks de mutações. Não enfraqueça validações de identidade, origem, CSRF ou paths.
- A troca afeta todas as conversas conectadas ao daemon. Aguarde todos os turnos ativos terminarem antes de trocar conta ou fazer logout.
- Preserve o binário oficial, o histórico e o processo do CLI. Não introduza wrappers, aliases, reinício forçado ou injeção de teclado como fallback de produção.
- O App Server é compartilhado. Não responda aprovações pertencentes ao cliente nativo; atenda somente às requisições de autenticação que o backend possui.
- A continuação automática é opt-in, aplica-se ao autoswitch e só continua falhas de cota. Ignore threads efêmeras e turnos ativos ou substituídos. Não repita `turn/start` após timeout sem saber se o servidor aceitou o envio.
- Falha de continuação após login não deve disparar uma segunda troca de conta. Informe o estado no painel.
- Consulte `SECURITY.md` para relatos de vulnerabilidade.

## Documentação externa e Git

Para dúvidas sobre bibliotecas, SDKs ou serviços, consulte documentação atual com Context7: primeiro `bunx --bun ctx7@latest library <nome> "<pergunta>"`, depois `bunx --bun ctx7@latest docs /org/projeto "<pergunta>"`. Nunca inclua segredos nas consultas.

Faça commits com mensagens claras, preferencialmente Conventional Commits. Não publique configurações pessoais, arquivos `.env`, `node_modules`, pastas temporárias ou artefatos de testes. Preserve mudanças existentes de outros colaboradores. Não faça force-push nem remova histórico sem autorização explícita.
