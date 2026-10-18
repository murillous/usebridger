---
"@usebridger/plugin-dashboard": minor
---

Abas de plugin (`dashboard.tabs`): todo widget aceita `title?` (antes só `series`), desenhado sobre o widget e usado como rótulo da seção; `StatItem` ganha `tone?` (`ok`, `warn`, `danger`), que colore o valor do cartão; e o `form` ganha `submitLabel?` para o texto do botão de envio (padrão "Enviar"). Título ou rótulo que não é texto some do manifesto, e tom desconhecido some do item sem descartá-lo (ADR 0118).
