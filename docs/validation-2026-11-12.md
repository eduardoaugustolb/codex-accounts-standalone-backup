# Validação do Codex CLI oficial

Ambiente: Linux, Bun 1.4.4, `codex-cli 0.167.2`. Código-fonte consultado: tag `rust-v0.167.2`, commit `ce21072c90d32c40af7a55b60b2fb35c84a43a6a` do [openai/codex](https://github.com/openai/codex/tree/ce21072c90d32c40af7a55b60b2fb35c84a43a6a).

Todos os testes usaram identidades e tokens fictícios, `CODEX_HOME` e SQLite isolados em `/tmp`, inferência SSE local e um endpoint OAuth local. O teste nativo bloqueia tráfego externo por um proxy local indisponível e libera apenas localhost. Nenhuma assinatura real foi autenticada ou debitada.

## Trocar somente o cache não funciona

`bun run test:auth-case` inicia o App Server oficial e executa três turnos na mesma conversa. Um hook `PostModelRequest` troca atomicamente o arquivo da conta A pelo arquivo da conta B.

| Etapa | Conta no disco | Conta observada na requisição |
| --- | --- | --- |
| Primeiro turno | A → B pelo hook | A |
| Segundo turno no mesmo processo | B | A |
| Terceiro turno após atualização por RPC | B | B |

O segundo e o terceiro turnos continham o marcador do primeiro turno. Resultado: o arquivo não é um mecanismo de troca em serviço; a RPC muda a autenticação em memória sem descartar o contexto local.

O comportamento corresponde ao [AuthManager dessa versão](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/login/src/auth/manager.rs#L2195), que documenta o cache em memória e a necessidade de recarga explícita.

## Plugin + backend, abrindo pelo binário oficial

`bun run test:native-case` instala o pacote pelo marketplace local em um diretório temporário, confia somente nos dois hooks do teste, inicia o daemon oficial e abre:

```text
codex --no-alt-screen "Remember NATIVE_CONTEXT_42 and reply."
```

Não usa `--remote`, wrapper, alias, skill, MCP, alteração do executável ou injeção de instruções sobre o switcher.

O servidor local devolve 429 com `usage_limit_reached` para a conta A. O hook registra a oferta no backend. O teste confirma que a conta A permanece ativa até a confirmação, rejeita uma submissão com CSRF inválido, cancela uma oferta sem trocar a conta e depois confirma a conta B pelo mesmo formulário usado no navegador.

O primeiro acesso da conta B retorna 401. O backend atende a requisição de renovação, usa um App Server oficial separado em modo gerenciado para renovar o login e salva a nova geração do refresh token. O serviço local aceita a geração renovada e devolve a resposta SSE.

Verificações que passaram:

- Mesmo PID do CLI antes e depois da troca.
- Mesmo ID da conversa carregada no daemon.
- Cabeçalho `ChatGPT-Account-Id` mudou de A para B.
- A requisição da conta B contém o marcador do histórico anterior.
- O payload de inferência não contém identificação/instruções sobre o switcher.
- Não houve chamada ao modelo durante o formulário e a troca.
- Cancelamento manteve a conta A; confirmação inválida retornou 403.
- O 401 foi recuperado e o refresh token renovado foi preservado no vault e no cache ativo.
- A interface oficial recebeu a resposta da conta B no mesmo terminal.

O navegador não é aberto durante a automação (`CODEX_ACCOUNTS_NO_BROWSER=1`). O teste inspeciona a página e submete os formulários por HTTP local. A abertura real via `xdg-open`/`open` e duas assinaturas reais ainda precisam de validação manual.

## Particularidades confirmadas

- O socket de controle do daemon fala WebSocket, não JSONL. `codex app-server proxy` é um túnel de bytes; o backend se conecta diretamente por WebSocket sobre Unix.
- `--dangerously-bypass-hook-trust` exclui a reutilização do daemon nessa versão. A automação usa a gravação de confiança equivalente ao `/hooks`, exclusivamente na configuração temporária.
- Depois de falhar por cota, o estado da conversa pode ser `systemError`, não `idle`. A proteção de troca rejeita turnos `active`.
- Requisições de servidor podem ser transmitidas a vários clientes. O backend responde somente à renovação de autenticação e ignora aprovações destinadas ao CLI nativo.
- O formato compatível `.codex-plugin/plugin.json` foi o pacote verificado para um plugin somente de hooks, sem skills.

## Limites da conclusão

O mecanismo local foi demonstrado com o binário instalado. Isso não comprova elegibilidade, disponibilidade de modelos, políticas de workspace ou cobrança de contas reais. A RPC `chatgptAuthTokens` é experimental e precisa ser revalidada a cada versão. O protótipo exige `cli_auth_credentials_store = "file"`; não migra o keyring. Não há fallback de reinício automático.

Referências oficiais: [Hooks](https://learn.chatgpt.com/docs/hooks), [App Server](https://developers.openai.com/codex/app-server/), [empacotamento de plugins](https://developers.openai.com/plugins/build/plugins).

## Suíte unificada e continuação automática

Comando: `TMPDIR=/var/tmp bun run test:all` (o `/tmp` desta máquina estava sem espaço suficiente para o daemon).

Resultado: **7 etapas aprovadas em 27,8 s**, com Bun 1.4.4 e Codex CLI 0.167.2:

1. Checagem TypeScript.
2. 15 testes unitários aprovados, incluindo preferências, proteção de credenciais, RPC e continuação.
3. Build dos três executáveis do plugin.
4. Autenticação e histórico pelo App Server oficial.
5. Troca manual, CSRF e origem, renovação após 401, remoção, logout, reinício, SSE e persistência das duas preferências.
6. Autoswitch com continuação desativada: nenhuma requisição da conta B iniciada automaticamente.
7. Autoswitch com continuação ativada: resposta recebida no CLI oficial, mesmo processo e marcador do histórico preservado.

A continuação identifica falhas de cota no último turno de cada conversa carregada, ignora threads efêmeras e relê o turno depois da troca. Se o usuário já mudou a conversa, o envio é descartado. Um timeout de `turn/start` não causa reenvio nem outra troca de conta.

O teste integrado revelou que o daemon também lista threads internas efêmeras, que rejeitam leitura de turnos. A rotina ignora essas threads. Projetos temporários precisam ficar fora da árvore do repositório para não herdar seu `AGENTS.md`; caminhos curtos também evitam ultrapassar o limite de sockets Unix.
