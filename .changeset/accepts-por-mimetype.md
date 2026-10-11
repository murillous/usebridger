---
'@usebridger/core': minor
---

`accepts` restringe o mimetype na própria entrada: `'document:application/pdf'`, `'quoted:video:video/*'`. A comparação usa a essência do mimetype, sem diferenciar caixa, e a mídia de outro mimetype vai ao `onReject` como qualquer recusa. Entrada sem mimetype não muda.
