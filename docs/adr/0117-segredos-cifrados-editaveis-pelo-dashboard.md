# ADR 0117 — Segredos cifrados no storage, editáveis pelo dashboard

**Status:** Aceito (2026-10-18) · Substitui em parte **D28** ([ADR 0028](0028-camadas-da-config-de-plugin.md),
"segredo vem só de env ou do arquivo") · Complementa **D107** ([ADR 0107](0107-acesso-admin-para-plugins.md))

## Contexto

O canvas da Config tem o botão "Substituir" num campo secreto (no celular, em largura total). O
dashboard não o oferece: o `setOverrides` recusa campo `secret` porque o storage guarda o override
em texto puro (SQLite, Postgres, backups). Trocar uma chave exige mexer no env ou no arquivo e
recarregar o plugin. O ADR 0028 deixou para o M5, com ADR próprio, a cifra dos segredos no storage
(#180).

Duas forças pesam:

- **Vazamento.** Um segredo salvo pelo dashboard não pode ficar legível no banco, nos backups ou
  num dump.
- **Precedência.** A ordem é `env > arquivo > override > default`. Na maioria dos deploys o segredo
  vem do env. Um valor salvo abaixo dele seria ignorado: o dashboard diria "salvo" e o bot
  continuaria com a chave antiga.

Alternativas consideradas:

- **Arquivo local com `chmod 600`.** Simples, mas não funciona com Postgres, com várias instâncias
  nem em container sem volume.
- **Segredo do dashboard acima do env.** Inverte a precedência para um tipo de campo só e confunde
  quem faz o deploy, que deixa de saber qual valor vale.
- **Liberar segredo no `setOverrides`, cifrado.** Mistura a escrita de segredo com o override comum:
  `setOverrides({})` apagaria segredos junto, e a recusa do ADR 0028 para override legado deixaria
  de fazer sentido.
- **Cofre externo (Vault, KMS).** Fora do tamanho do projeto; pode entrar depois atrás da mesma API.

## Decisão

- **Camada `secret` no storage, cifrada.** O core guarda os segredos editados pelo dashboard em
  `kernelStorage(storage, 'secrets').kv`, chave = nome do plugin, valor = `{ [caminho]: envelope }`.
  É separado dos overrides: `setOverrides` segue recusando segredo, e o override legado com segredo
  continua ignorado na leitura.
- **Cifra: AES-256-GCM do `node:crypto`**, sem dependência nova. O envelope é
  `{ v: 1, kid, iv, tag, data }` em base64. O `kid` identifica a chave mestra (os primeiros bytes do
  SHA-256 de um rótulo fixo mais a chave), sem revelá-la. O AAD é `<plugin>:<caminho>`: um envelope
  copiado para outro campo ou plugin não decifra.
- **Chave mestra no env.** `BRIDGER_SECRET_KEY` traz 32 bytes em base64 (`openssl rand -base64 32`).
  É lida em `config/env.ts`, o único lugar que lê `process.env`, e é injetável em teste. Chave em
  formato inválido falha o boot com mensagem clara. **Sem a chave**, a escrita de segredo fica
  desligada: o dashboard mostra o motivo, e o resto funciona como hoje.
- **Precedência mantida:** `env > arquivo > segredo salvo > override > default`. Se o env ou o
  arquivo definem o campo, `setSecret` rejeita com `PluginConfigError` (`kind: 'shadowed'`), e o
  dashboard, que já recebe a fonte de cada folha em `sources`, nem oferece o botão. Para gerenciar
  um segredo pelo dashboard, o operador tira o campo do env ou do arquivo.
- **API separada no `bot.config` e no `ctx.admin.config`:**
  - `setSecret(plugin, path, value)`: valida a config resultante, cifra, salva e recarrega o
    plugin, como o `setOverrides`. Config inválida é rejeitada e nada muda.
  - `clearSecret(plugin, path)`: remove o valor salvo, e o campo volta à camada de baixo. Se a
    config ficar inválida (campo obrigatório), rejeita e nada muda.
  - `secretsWritable: boolean`: diz se há chave mestra.
  - A recusa sobre o próprio plugin do ADR 0107 vale para os dois métodos.
- **Só escrita.** O valor nunca volta ao cliente: a leitura segue mascarada (`SECRET_MASK`), a
  fonte do campo aparece como `secret` em `sources`, e o valor decifrado entra no `SecretSet` que o
  logger censura. Cada escrita ou remoção registra `info` com plugin, campo e fonte, nunca o valor.
- **Rotação da chave mestra.** `BRIDGER_SECRET_KEY_PREVIOUS` aceita a chave anterior. No boot, o
  core decifra com a anterior todo envelope com `kid` dela, cifra de novo com a atual, regrava e
  registra quantos migrou. Depois que o log confirma a migração, o operador remove a variável
  anterior. Uma chave só de cada vez em `PREVIOUS`: rotações seguidas exigem um boot entre elas.
- **Envelope ilegível** (`kid` desconhecido, chave errada ou dado adulterado) não expõe nada. A
  resolução lança `PluginConfigError` (`kind: 'undecryptable'`, fonte `secret`) com o plugin e o
  caminho, como a config inválida. Em runtime (reload) o bot segue de pé e o plugin cai em
  `setup-failed`; no boot vale o [ADR 0098](0098-plugin-falho-derruba-o-boot.md) e o `start()`
  aborta com `PluginBootError`. Recuperação: restaurar a chave, ou desligar o plugin
  (`disabledPlugins`), subir o bot e chamar `clearSecret`.

## Consequências

- O dashboard ganha "Substituir" e "Remover" nos campos secretos sem fonte em env ou arquivo,
  com rota própria (`PUT` e `DELETE /api/config/:plugin/secrets/:path`). O `PUT` da config segue
  recusando segredo no corpo.
- O JSON Schema troca `x-bridger-override: false` por uma marca que diga "editável só por
  `setSecret`" quando há chave mestra. O dashboard precisa ler as duas.
- `PluginConfigIssue.kind` ganha `'shadowed'` e `'undecryptable'`, e `ConfigSource` ganha
  `'secret'`. As uniões são API pública: valor novo é minor.
- `PluginConfigs` e `PluginAdmin.config` ganham métodos (minor). Mocks de contexto fora do core
  passam a exigi-los.
- Perder a chave mestra perde os segredos salvos pelo dashboard. O env e o arquivo não são
  afetados. A doc de deploy precisa dizer para guardar a chave fora do banco e do backup dele.
- A chave mestra protege contra vazamento do banco, não contra quem lê o env do processo. Quem
  tem o processo tem os segredos, como já acontecia antes.
