# Eventos de log

Os `event`s que o kernel emite ([ADR 0118](../../../docs/adr/0118-contrato-de-log-estruturado.md)).
O nome é o contrato: filtro e alerta se escrevem sobre ele. Evento novo é minor; renomear ou
remover quebra. A mensagem é para quem lê e pode mudar de redação sem quebrar nada. Os campos de
cada linha seguem o [dicionário do logger](logger.md#campos).

```logql
{service="lumabot"} | json | event=~"connection\..*"
```

## Core

| Evento | Nível | Mensagem |
| --- | --- | --- |
| `bot.pseudonym.ephemeral` | `info` | sem BRIDGER_SECRET_KEY: os pseudônimos dos logs mudam a cada restart |
| `bot.storage.missing` | `warn` | sem storage configurado: usando memória, os dados somem ao reiniciar |
| `bot.stop.failed` | `error` | falha ao parar o bot |
| `bot.start.cleanup-failed` | `error` | falha ao encerrar após erro no start |
| `bot.plugins.load-failed` | `error` | falha ao carregar os plugins; encerrando |
| `bot.http.open-failed` | `error` | falha ao abrir a porta HTTP; encerrando |
| `bot.failed.disconnect-failed` | `error` | falha ao desconectar o transport no estado failed |
| `session.lease.lost` | `error` | outro processo assumiu a trava da sessão; parando o bot |
| `session.lease.waiting` | `warn` | sessão travada por outro processo; esperando a trava vencer |
| `session.lease.renew-failed` | `warn` | falha ao renovar a trava da sessão; tentando no próximo intervalo |
| `audit.flush.failed` | `error` | falha ao gravar a auditoria; a fila fica retida e tenta de novo |
| `audit.dropped` | `error` | eventos de auditoria descartados |
| `audit.unkeyed` | `warn` | sem BRIDGER_SECRET_KEY: a cadeia de auditoria usa chave pública e só detecta edição ingênua |
| `connection.opened` | `info` | conexão aberta |
| `connection.connecting` | `debug` | conectando |
| `connection.closed` | `warn` | conexão fechada: reconectando |
| `connection.reconnect.failed` | `error` | reconexão falhou |
| `connection.replaced` | `error` | conexão encerrada: outra conexão assumiu esta sessão (o mesmo número rodando em outro processo?); o bot passa a failed em vez de derrubá-la |
| `connection.fatal` | `fatal` | conexão encerrada por erro fatal do transport (token sem permissão, intents, porta?); reconectar não resolve: corrija a configuração. O bot passa a failed (plugins e HTTP seguem no ar) |
| `connection.auth-failed` | `fatal` | conexão encerrada: credenciais rejeitadas, e o transport não pareia de novo (token inválido?); limpar a sessão não resolve. O bot passa a failed (plugins e HTTP seguem no ar) |
| `connection.session-lost` | `error` | conexão encerrada: a sessão precisa ser pareada de novo e não há clearSession configurado; o bot passa a failed |
| `connection.qr.received` | `info` | QR de pareamento recebido; exiba-o pelo evento connection.qr |
| `connection.qr.value` | `debug` | valor do QR de pareamento |
| `connection.pairing-code.received` | `info` | código de pareamento recebido; exiba-o pelo evento connection.pairing-code |
| `connection.pairing-code.value` | `debug` | valor do código de pareamento |
| `transport.handler.failed` | `error` | handler de evento do transport falhou |
| `transport.commands-listener.failed` | `error` | listener de commands.onChange do transport falhou |
| `transport.route.failed` | `error` | rota do transport falhou |
| `transport.unsafe.undeclared` | `warn` | plugin acessou o objeto nativo do transport sem declarar transports no manifesto; ele fica preso a este transport (declare transports no manifesto) |
| `transport.unsafe.accessed` | `warn` | plugin acessou o objeto nativo do transport |
| `message.failed` | `error` | falha ao processar mensagem |
| `message.dropped` | `warn` | mensagem descartada pela fila de entrada |
| `message.rate-limited` | `debug` | mensagem barrada pelo rate limit |
| `middleware.late-rejection` | `error` | middleware rejeitou depois do prazo |
| `message.react.skipped` | `debug` | react ignorado: o transport não tem a capability "reactions" |
| `outbound.typing.failed` | `debug` | falha ao enviar "digitando" |
| `context.expired` | `warn` | operação recusada: o contexto já expirou; `context` diz qual (`command`, `step`, `expire`, `listener`, `plugin`) |
| `command.timeout` | `error` | comando rejeitou depois do prazo |
| `command.background.failed` | `error` | falha ao concluir o comando em segundo plano |
| `command.refusal.failed` | `warn` | falha ao enviar a recusa do comando |
| `command.role.unknown` | `error` | comando exige um papel que nenhum plugin carregado define: declare dependsOn no plugin dono do papel |
| `command.unregistered.capability` | `warn` | comando não registrado: capability ausente no transport |
| `command.unregistered.service` | `warn` | comando não registrado: serviço não provido |
| `command.native.gone` | `debug` | comando nativo que não existe mais; descartado |
| `command.button.gone` | `debug` | botão de comando que não existe mais; descartado |
| `action.button.unknown` | `debug` | clique em botão vencido ou desconhecido; descartado |
| `role.timeout` | `error` | papel rejeitou depois do prazo |
| `role.check.failed` | `warn` | consulta do papel falhou: comando fora da lista |
| `role.group-admin.timeout` | `warn` | consulta de admin do grupo falhou depois do prazo |
| `conversation.step.timeout` | `error` | passo rejeitou depois do prazo |
| `conversation.expire.timeout` | `error` | onExpire do passo rejeitou depois do prazo |
| `conversation.button.gone` | `debug` | botão de passo que não existe mais; descartado |
| `conversation.expire.dropped` | `warn` | expiração de espera descartada pela fila de entrada; onExpire não roda |
| `conversation.waits.read-failed` | `error` | falha ao ler as esperas persistidas; seguem fora da memória |
| `conversation.wait.write-failed` | `warn` | falha ao gravar espera no storage |
| `conversation.wait.orphan` | `warn` | espera descartada: o plugin não tem o passo (desligado, removido ou passo renomeado) |
| `scheduler.storage.failed` | `error` | falha no storage do scheduler |
| `plugin.failed` | `error` | plugin falhou |
| `plugin.lifecycle.failed` | `error` | falha no ciclo de vida do plugin |
| `plugin.boot.report` | `info` | plugins carregados |
| `plugin.boot.review` | `warn` | plugins carregados, com plugin ignorado ou comando de fora: revise a configuração |
| `plugin.reloaded` | `info` | plugin recarregado |
| `plugin.disabled` | `info` | plugin desligado |
| `plugin.enabled` | `info` | plugin ligado |
| `plugin.dependency.exact-range` | `warn` | faixa de dependência aceita só uma versão exata; para acompanhar o 0.x da dependência, use "0.x" ou ">=0.0.0 <1.0.0" |
| `plugin.dependency.optional-mismatch` | `warn` | optionalDependsOn não aceita a versão carregada (campo `loaded`); o plugin sobe e o serviço dela segue visível |
| `plugin.disabled.unknown` | `warn` | disabledPlugins cita um plugin que não existe |
| `plugin.admin.unknown` | `warn` | adminPlugins cita um plugin que não existe |
| `config.plugin.unknown` | `warn` | pluginConfig cita um plugin que não existe |
| `config.override.secret-ignored` | `warn` | override tem campo secreto, ignorado; defina pela env ou pelo arquivo |
| `config.secret.too-short` | `warn` | campo secreto curto demais para a censura do log: sai como texto comum |
| `config.override.shadowed` | `warn` | override sem efeito: outra camada vale nesses campos |
| `config.secret.saved` | `info` | segredo do plugin salvo |
| `config.secret.removed` | `info` | segredo do plugin removido |
| `config.secret.migrate-failed` | `warn` | segredo com a chave anterior não decifra; não migrado |
| `config.key.rotated` | `info` | rotação da chave mestra concluída |
| `http.listen.failed` | `error` | falha ao abrir a porta HTTP |
| `http.server.error` | `error` | erro no servidor HTTP |
| `http.unhandled` | `error` | erro HTTP fora de um handler |
| `message.received` | `info` | mensagem recebida |
| `message.handled` | `info` | mensagem tratada |
| `outbound.sent` | `info` | envio concluído |
| `step.entered` | `info` | passo de conversa aguardando resposta |
| `step.expired` | `info` | passo de conversa expirou |
| `job.run` | `info` | job executado |
| `http.request` | `info` | requisição HTTP atendida |

Os sete últimos são a [trilha de eventos](logger.md#trace-e-trilha) (ADR 0120): saem em `debug`
com `trail: 'debug'` e somem com `trail: 'off'`.

## Transports

Evento que todo transport tem usa a área `transport` e o mesmo nome do core; o binding `transport`
diz qual foi.

### `@usebridger/transport-baileys`

| Evento | Nível | Mensagem |
| --- | --- | --- |
| `transport.handler.failed` | `error` | handler de evento do transport falhou |
| `baileys.creds.save-failed` | `error` | falha ao gravar as credenciais da sessão |
| `baileys.message.normalize-failed` | `error` | falha ao normalizar mensagem do Baileys; descartada |
| `baileys.contacts.learn-failed` | `error` | falha ao aprender nomes de contatos do Baileys; descartados |
| `baileys.reaction.convert-failed` | `error` | falha ao converter reação do Baileys; descartada |
| `baileys.edit.convert-failed` | `error` | falha ao converter edição do Baileys; descartada |
| `baileys.delete.convert-failed` | `error` | falha ao converter apagamento do Baileys; descartado |
| `baileys.group.joined-failed` | `error` | falha ao repassar grupo novo |
| `baileys.group.updated-failed` | `error` | falha ao repassar alteração de grupo |
| `baileys.participants.convert-failed` | `error` | falha ao converter alteração de participantes do Baileys; descartada |
| `baileys.poll.vote-unknown` | `debug` | voto de enquete desconhecida; descartado |
| `baileys.socket.end-failed` | `warn` | falha ao encerrar o socket do Baileys |
| `baileys.lid.resolve-failed` | `warn` | falha ao resolver o telefone de um LID |
| `baileys.pairing-code.failed` | `error` | falha ao pedir o código de pareamento |
| `baileys.contact-names.save-failed` | `warn` | falha ao gravar os nomes de contatos; tenta de novo na próxima gravação |
| `baileys.contact-names.read-failed` | `warn` | falha ao ler os nomes de contatos do auth state; segue sem nome |
| `baileys.version.fetch-failed` | `warn` | não deu para buscar a versão do WhatsApp Web; usando a do Baileys |

### `@usebridger/transport-web`

| Evento | Nível | Mensagem |
| --- | --- | --- |
| `transport.handler.failed` | `error` | handler de evento do transport falhou |
| `web.tenant.missing` | `debug` | conexão recusada sem o claim de tenant |
| `web.token.rejected` | `debug` | token recusado |
| `web.token.verify-failed` | `warn` | não deu para verificar o token |
| `web.upload.verify-failed` | `warn` | não deu para verificar o token do upload |

## Plugins oficiais

As linhas saem com `plugin=dashboard` ou `plugin=metrics`.

### `@usebridger/plugin-dashboard`

| Evento | Nível | Mensagem |
| --- | --- | --- |
| `dashboard.config.failed` | `error` | falha na config do plugin |
| `dashboard.admin.missing` | `warn` | controle de plugins indisponível: ponha "dashboard" em adminPlugins no createBot |
| `dashboard.plugin-action.failed` | `error` | falha na ação sobre o plugin |
| `dashboard.tab.ignored` | `warn` | aba ignorada |
| `dashboard.tabs.manifest-failed` | `error` | falha ao montar o manifesto de abas |
| `dashboard.widget.failed` | `error` | falha no widget da aba |
| `dashboard.widget.invalid-items` | `warn` | widget devolveu itens fora do contrato; descartados |
| `dashboard.widget.truncated` | `warn` | widget devolveu itens demais; cortado no limite |

### `@usebridger/plugin-metrics`

| Evento | Nível | Mensagem |
| --- | --- | --- |
| `metrics.http.missing` | `info` | sem http no bot: GET /metrics desligado |
| `metrics.scrape.open` | `warn` | GET /metrics sem scrapeToken: a rota fica aberta a quem alcança o HTTP |
| `metrics.series.overflow` | `warn` | métrica passou do limite de séries; amostras de séries novas descartadas |
| `metrics.flush.failed` | `error` | flush de métricas falhou |
| `metrics.write.failed` | `error` | falha ao gravar métrica; delta mantido para o próximo flush |
| `metrics.purge.failed` | `error` | falha ao apagar métricas antigas |
| `metrics.catalog.write-failed` | `error` | falha ao gravar o descritor da métrica no catálogo |
| `metrics.sample.failed` | `error` | falha ao amostrar as filas para o histórico |
| `metrics.exporter.failed` | `error` | exportador de métricas falhou |
| `metrics.exporters.list-failed` | `error` | falha ao listar exportadores de métricas |
| `metrics.runtime.config-ignored` | `warn` | config do runtime diferente da de quem criou a registry; vale a dela enquanto viver |
| `metrics.runtime.sample-failed` | `error` | falha ao amostrar o runtime do Node para o histórico |
| `metrics.runtime.scrape-failed` | `error` | falha ao ler a registry do runtime no scrape; o resto do /metrics segue |
