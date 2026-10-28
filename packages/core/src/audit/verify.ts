// Verificação da cadeia de auditoria (ADR 0122): percorre por `seq` e aponta o primeiro elo
// quebrado. Aceita o prefixo apagado por uma expurgação registrada (`kernel.audit.purge`).

import type { Collection, JsonObject } from '#storage/types.ts';
import { chainHash, GENESIS_HASH } from './chain.ts';
import type { AuditEvent, AuditVerifyResult } from './types.ts';

export const PURGE_ACTION = 'kernel.audit.purge';
const VERIFY_BATCH = 500;

export const strip = (row: { readonly id: string } & JsonObject): AuditEvent => {
  const { id: _id, ...rest } = row;
  return rest as unknown as AuditEvent;
};

export async function verifyChain(
  col: Collection<JsonObject>,
  keys: { readonly current: Buffer; readonly previous?: Buffer },
): Promise<AuditVerifyResult> {
  const purges = (await col.find({ where: { action: PURGE_ACTION }, orderBy: 'seq' })).map(strip);
  // Prefixo apagado por uma expurgação legítima: o primeiro elo restante continua o `lastHash`.
  const explainedByPurge = (event: AuditEvent): boolean =>
    purges.some((purge) => {
      const details = purge.details;
      const toSeq = Number(details?.['toSeq']);
      if (purge.seq <= toSeq) return false;
      // Expurgação interrompida entre lotes: o início cai dentro do intervalo registrado, e o
      // encadeamento dali até `toSeq + 1` segue checado.
      if (event.seq >= Number(details?.['fromSeq']) && event.seq <= toSeq) return true;
      return details?.['lastHash'] === event.prevHash && event.seq === toSeq + 1;
    });
  let checked = 0;
  let previous: AuditEvent | undefined;
  // A chave anterior só vale até o primeiro elo assinado com a atual (rotação, ADR 0122): depois
  // disso um elo com a chave antiga seria forjado por quem a guardou.
  let signedWithCurrent = false;
  for (let cursor = 0; ; ) {
    const rows = await col.find({
      where: { seq: { gt: cursor } },
      orderBy: 'seq',
      limit: VERIFY_BATCH,
    });
    if (rows.length === 0) return { ok: true, checked };
    for (const row of rows) {
      const event = strip(row);
      const broken = (reason: string): AuditVerifyResult => ({
        ok: false,
        checked,
        brokenAt: { seq: event.seq, eventId: event.eventId, reason },
      });
      if (event.v !== 1) return broken('versão de formato desconhecida');
      if (previous === undefined) {
        const genesis = event.prevHash === GENESIS_HASH && event.seq === 1;
        if (!genesis && !explainedByPurge(event)) {
          return broken('início da cadeia sem origem (nem gênese nem expurgação registrada)');
        }
      } else if (event.seq !== previous.seq + 1) {
        return broken('seq descontínuo: evento removido');
      } else if (event.prevHash !== previous.hash) {
        return broken('prevHash não confere com o elo anterior');
      }
      const { hash, ...body } = event;
      if (chainHash(keys.current, event.prevHash, body) === hash) {
        signedWithCurrent = true;
      } else if (
        signedWithCurrent ||
        keys.previous === undefined ||
        chainHash(keys.previous, event.prevHash, body) !== hash
      ) {
        return broken('hash não confere: evento alterado');
      }
      previous = event;
      checked++;
      cursor = event.seq;
    }
  }
}
