# Codex Accounts

[![Test suite](https://github.com/eduardoaugustolb/codex-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/eduardoaugustolb/codex-accounts/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Plugin experimental para trocar contas ChatGPT no **Codex CLI oficial**, com confirmação local ou troca automática opcional quando a cota termina. Abra normalmente com `codex`: não há wrapper, alias ou launcher substituindo o binário.

O plugin contém quatro hooks (`SessionStart`, `PostModelRequest`, `Stop` e `Interrupt`). Um backend local gerencia a confirmação e a autenticação pelo socket Unix do daemon oficial. Não há skill, MCP, instruções ou mensagens sobre o switcher enviadas ao modelo.

## Instalação

Requisitos testados: Linux, Bun 1.4.4 e Codex CLI 0.167.2. O fluxo usa uma RPC experimental de autenticação; outras versões precisam de nova verificação. No macOS, a abertura do navegador está implementada, mas não foi testada. Windows não é suportado neste protótipo.

O protótipo requer autenticação em arquivo. Em `~/.codex/config.toml`:

```toml
cli_auth_credentials_store = "file"
```

Se você usava o keyring, faça login oficial novamente nesse modo antes de usar o plugin. O instalador não altera essa configuração nem extrai credenciais do keyring.

Na pasta deste projeto:

```bash
bun install
bun run setup
```

O setup compila o pacote em `marketplace/plugin/bin`, registra o marketplace local, instala o plugin pelo comando oficial e inicia o daemon oficial. Não modifica o binário nem configura aliases.

Abra `codex`, entre em `/hooks`, revise e confie nos **quatro hooks do Codex Accounts**. Inicie uma nova conversa depois. A confiança é vinculada ao conteúdo do plugin; uma atualização pode exigir nova revisão. Não use `--dangerously-bypass-hook-trust`: essa opção desativa a reutilização do daemon no Codex 0.167.2.

## Cadastrar contas

Salvar o login ChatGPT atual em arquivo:

```bash
bun run start capture pessoal
```

Adicionar outra conta por login oficial, em diretório temporário isolado:

```bash
bun run start add trabalho
# Alternativa com código de dispositivo:
bun run start add secundaria --device
bun run start list
```

O cadastro não troca a conta da sessão atual. Selecione a conta desejada no navegador durante cada login. Os nomes aceitam letras, números, `_` e `-`, até 64 caracteres.

Depois, entre em qualquer projeto e execute o binário oficial:

```bash
codex
```

## Remover uma conta

O painel mostra a foto quando ela está disponível no login. Como o App Server não fornece um endpoint de foto de perfil, use **Adicionar foto / Alterar foto** para salvar uma foto local (PNG, JPEG ou WebP, até 2 MB) quando necessário. A foto local é apagada junto com a conta.

Em cada conta, **Atualizar limites** consulta a RPC oficial `account/rateLimits/read` sem trocar a sessão compartilhada. O painel exibe as janelas de **5 horas** e **semanal**, com percentual restante, renovação em horário de Brasília e horário da última consulta. Janelas ausentes ou consultas que falharem aparecem como indisponíveis. Os valores ficam em memória até a próxima consulta ou reinício do backend. Não são limites gerais do ChatGPT: são os limites do Codex retornados pelo serviço para aquela conta.

Para remover uma conta salva individualmente:

```bash
bun run remove secundaria
# Equivalente:
bun run start remove secundaria
```

No painel, abra **Remover NOME** e clique em **Confirmar remoção**. Isso apaga as credenciais locais daquela conta; para voltar a usá-la, cadastre-a novamente. A conta em uso fica protegida: faça logout ou troque para outra antes de removê-la. As outras contas e o histórico das conversas são preservados.

## Quando a cota termina

1. O hook recebe a falha da requisição e avisa o backend sem consultar o modelo.
2. O navegador abre um painel local perguntando se deseja trocar. Com troca automática desativada, a troca exige clicar na conta escolhida.
3. O backend verifica se todos os turnos conectados ao daemon já pararam, preserva as credenciais atuais e aplica a conta escolhida por RPC.
4. Volte ao mesmo terminal e envie `continue` quando desejar. Se ativar **Continuar automaticamente ao trocar de conta** nas preferências, o autoswitch envia `continue` na mesma conversa após trocar a conta.

A troca afeta todas as conversas conectadas ao mesmo App Server. O histórico permanece no `CODEX_HOME` original; as próximas requisições usam a identidade e as políticas da conta escolhida. A janela do CLI e a conversa não precisam ser reiniciadas no cenário testado.

Para abrir o painel manualmente, sem envolver o modelo:

```bash
bun run start panel
```

O comando pode ser executado em outro terminal e inicia o backend automaticamente, mesmo depois de `stop`. Não precisa cadastrar novamente as contas existentes. `bun run start status` mostra o endereço local ou informa que o backend está parado. Não foi registrado um slash command `/accounts`: a integração funciona pelos hooks, sem prompts de skill.

```bash
bun run panel     # Inicia o backend se necessário e abre o painel
bun run status
bun run restart   # Reinicia apenas o backend do plugin e mostra o novo endereço
bun run stop
bun run logout    # Sai da sessão do Codex compartilhada, mantendo as contas salvas
```

Também estão disponíveis `bun run start start`, `bun run start restart` e `bun run start logout`. O painel tem um botão de confirmação de logout. Logout e troca exigem que todos os turnos do daemon estejam parados. Depois do logout, selecione uma conta salva no painel para entrar novamente. O logout usa a RPC oficial [`account/logout`](https://learn.chatgpt.com/docs/app-server#5-logout).

## Troca automática e painel ao vivo

Ative **Trocar de conta automaticamente** e clique em **Salvar preferência** no painel. A opção começa desativada e fica salva em `settings.json` no vault. Ao esgotar o limite de 5 horas ou semanal, ou receber uma falha de cota pelo hook, o backend aguarda todos os turnos pararem e consulta as outras contas em ordem alfabética. Troca para a primeira identidade diferente com saldo confirmado nos dois limites. Não abre o navegador no modo automático. Se nenhuma estiver disponível, mantém a sessão e informa o motivo no painel. A troca afeta todas as conversas. A preferência **Continuar automaticamente ao trocar de conta** começa desativada e também fica salva em `settings.json`. Quando ativada junto com o autoswitch, envia `continue` nas conversas carregadas cujo último turno falhou por limite, preservando o histórico. Verifica novamente o turno após o login e não envia se a conversa já mudou ou estiver ativa. Trocas manuais e trocas preventivas sem falha de cota não iniciam turnos. Se a confirmação do envio falhar, informa no painel e não repete o envio automaticamente.

`SessionStart` inicia o backend sem abrir o navegador. Os hooks precisam estar instalados, habilitados e confiados em `/hooks`. `PostModelRequest`, `Stop` e `Interrupt`, junto às notificações do App Server, sinalizam mudanças e verificam a cota. O navegador abre por `bun run panel` ou, no modo manual, quando um hook detecta cota esgotada.

Com a aba visível e em foco, o painel recebe eventos por SSE e confere o estado local a cada 3 segundos. As cotas externas de todas as contas são consultadas ao recuperar foco, após eventos relevantes e no máximo a cada 30 segundos sem eventos. São dados atualizados conforme o serviço os disponibiliza, não uma garantia de atualização instantânea de fontes externas. Ao perder foco, o navegador fecha o SSE, cancela a consulta e para os timers; ao voltar, reconecta e pede dados novos. Uma consulta externa já em andamento pode terminar no servidor. Confirmações abertas e arquivos selecionados são preservados. O monitoramento pelos hooks e a renovação da autenticação continuam funcionando sem o painel.

Para atualizar uma instalação existente, execute `bun run setup`, revise os quatro hooks em `/hooks` e inicie uma nova conversa. Depois use `bun run restart` e `bun run panel` para carregar o backend novo. Um reinício do backend gera um endereço novo; abas no endereço antigo devem ser reabertas por `bun run panel`.

## Armazenamento e limites

- Vault: `~/.local/share/codex-accounts/accounts/NOME/auth.json`, ou `CODEX_ACCOUNTS_HOME`. Credenciais ficam em arquivos `0600`, dentro de diretórios `0700`.
- O backend mantém a conexão que atende renovações de tokens externos. Usa um App Server oficial separado para renovar o login da conta cadastrada e guarda o refresh token atualizado.
- O painel escuta somente em `127.0.0.1`, com endereço aleatório por execução, proteção de origem e formulário com token CSRF. O IPC usa socket Unix em diretório privado de `/tmp`.
- O backend permanece em segundo plano. `bun run stop` o encerra; `bun run panel` o inicia novamente. Parar o backend enquanto a autenticação externa está ativa interrompe o atendimento das renovações; depois de reiniciar o backend, selecione novamente a conta no painel para restabelecer esse atendimento. Reiniciar o daemon/CLI devolve a autenticação gerenciada ao Codex.
- A conexão exige o daemon compartilhado do Codex. `--no-daemon`, `--strict-config`, certas opções `-c` e execuções remotas podem selecionar outro servidor e não são suportadas pelo protótipo. Se necessário, use `codex app-server daemon start` antes de abrir o CLI.
- Não há reinício automático como fallback para versões incompatíveis: a operação falha e mantém/restaura o cache anterior. Este protótipo não usa sinais ou injeção de teclado para reiniciar seu terminal.
- Detecta falhas descritas como limite de uso pelo hook; não troca por avisos percentuais nem por um 429 genérico. Como `PostModelRequest` fornece texto de erro, mudanças nesse texto podem exigir ajuste.
- A troca em serviço é experimental. Autenticação de duas assinaturas reais e consumo de cota real ainda não foram testados. O teste usa o Codex real, duas identidades fictícias e um servidor de inferência local.

## Verificação reproduzível

```bash
bun run test:all
```

Um único comando executa sete etapas: tipos, testes unitários, build, autenticação, CLI com troca manual, autoswitch sem continuação e autoswitch com continuação. A suíte para na primeira falha e roda também no GitHub Actions em pushes para `main` e pull requests. Para o ciclo rápido, use `bun test`. Os scripts individuais ficam disponíveis para diagnóstico.

Os casos de integração abrem sockets e pseudoterminal, instalam o plugin em um `CODEX_HOME` temporário e encerram somente os próprios processos. Não autenticam contas reais nem chamam modelos externos. Precisam de permissão para sockets locais. `KEEP_CASE=1` preserva os artefatos temporários para inspeção.

O teste nativo verifica abertura pelo binário oficial sem `--remote`, falha de cota, confirmação, troca na mesma janela e conversa, contexto preservado e ausência do switcher no conteúdo enviado ao modelo. O diagnóstico separado demonstra por que trocar somente o `auth.json` não atualiza a autenticação em memória.

Fontes: [hooks](https://learn.chatgpt.com/docs/hooks), [App Server](https://developers.openai.com/codex/app-server/), [plugins](https://developers.openai.com/plugins/build/plugins). Referência comparada: [SrDarf/claude-accounts](https://github.com/SrDarf/claude-accounts). Os mecanismos de recarga de credenciais são diferentes entre os produtos.

## Contribuição e segurança

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para desenvolvimento e [SECURITY.md](SECURITY.md) para relatar vulnerabilidades em privado. Licença [MIT](LICENSE). Este projeto é independente e não é um produto oficial da OpenAI.
