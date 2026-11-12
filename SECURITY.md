# Política de segurança

## Versões suportadas

Correções de segurança são aplicadas à versão mais recente da branch `main`. O projeto é experimental; valide a compatibilidade com a versão do Codex antes de atualizar.

## Relatar uma vulnerabilidade

Use [Report a vulnerability](https://github.com/eduardoaugustolb/codex-accounts/security/advisories/new) para enviar um relato privado. Não publique vulnerabilidades de autenticação ou credenciais em issues públicas. Se o formulário estiver indisponível, solicite um canal privado em uma issue sem incluir detalhes técnicos exploráveis.

Inclua versão do plugin, Bun e Codex, sistema operacional, passos reproduzíveis com dados fictícios, impacto e eventual correção sugerida. Remova tokens, cookies, emails, conteúdo de conversas, caminhos sensíveis e URLs privadas do painel. Não envie arquivos `auth.json`.

O projeto é mantido voluntariamente e não promete prazo de resposta ou recompensa.

## Modelo de segurança

- Credenciais são armazenadas localmente em arquivos `0600` e diretórios `0700`. Não há criptografia adicional em repouso: proteja a conta do sistema e seus backups.
- O painel HTTP fica em loopback, com URL aleatória por execução, verificação de origem e CSRF nos formulários. A URL contém um segredo de acesso; não a compartilhe.
- O IPC usa socket Unix em diretório privado. Um processo com os mesmos privilégios do usuário pode acessar suas credenciais e a sessão.
- A troca de conta afeta todas as conversas conectadas ao daemon. A continuação automática é opcional e inicia uma requisição de modelo na nova conta.
- O plugin usa o login oficial e uma RPC experimental. Não coleta credenciais em um serviço próprio e não elimina os limites ou políticas das contas.
- Testes usam identidades fictícias e serviços locais. Nenhum teste deve exigir contas ou tokens reais.
