---
'@usebridger/plugin-metrics': patch
---

Rastreio de usuários e grupos ativos mais barato por mensagem: a chave diária do HMAC vira
`KeyObject` uma vez por dia, em vez de ser convertida a cada `createHmac`. O hash e a garantia
de privacidade não mudam.
