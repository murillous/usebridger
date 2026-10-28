---
'@usebridger/plugin-metrics': patch
---

O handle passa a recusar rótulo com cara de id pessoal pelo `isPersonalId` do core, no lugar do regex local: o log e as métricas usam a mesma regra. O comportamento não muda (`TypeError` no valor reconhecido).
