---
'@usebridger/core': patch
---

O rate limit de login, aceite de convite e troca de senha da API agora fica no storage (coleção
`rateLimits` do namespace `auth`, ADR 0128): reiniciar o bot não zera as contagens e vários
processos que dividem o banco compartilham o limite.
