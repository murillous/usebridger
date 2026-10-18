---
"@usebridger/plugin-dashboard": minor
---

Tela de plugins conforme o canvas (M5-4.8): nome e versão numa coluna, estado carregado/falhou/pulado/desligado, toggle de ativo, busca, subtítulo do boot, painel com a causa real do erro de setup (`reason.causeMessage`, com secrets censurados) e, no mobile, filtros, card de problema e lista com toggle. Nova rota `GET /api/plugins/boot`. A tabela deixa de estourar a largura em 1080 px.
