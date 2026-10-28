import { useMutation, useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { ErrorNotice, when } from '#web/components/ui.tsx';
import { api, unwrap } from '#web/lib/client.ts';
import { useCan } from '#web/lib/viewer.ts';

/** QR ou código que o stream mandou por último; some quando o status sai de `connecting`. */
export interface PairingState {
  qr?: string;
  qrExpiresAt?: number;
  code?: string;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  connecting: { label: 'Conectando', tone: 'warn' },
  open: { label: 'Conectado', tone: 'ok' },
  closed: { label: 'Desconectado', tone: 'danger' },
};

/** QR gerado no browser: o valor não sai para nenhum serviço. */
function Qr({ value }: { value: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { margin: 1, width: 400 }).then(
      (url) => alive && setSrc(url),
      () => alive && setSrc(undefined),
    );
    return () => {
      alive = false;
    };
  }, [value]);
  return src === undefined ? null : <img className="qr" src={src} alt="QR de pareamento" />;
}

/** Conexão: status, conta, QR ao vivo, código de pareamento e logout (ADR 0129). */
export function Connection({ pairing }: { pairing: PairingState }) {
  const can = useCan();
  const manage = can('connection.manage');
  const connection = useQuery({
    queryKey: ['connection'],
    queryFn: () => unwrap(api().GET('/api/connection')),
  });
  const [phone, setPhone] = useState('');
  const pair = useMutation({
    mutationFn: () =>
      unwrap(
        api().POST('/api/connection/pairing-code', { body: { phone: phone.replace(/\D/g, '') } }),
      ),
  });
  const logout = useMutation({
    mutationFn: () => unwrap(api().POST('/api/connection/logout')),
    onSuccess: () => connection.refetch(),
  });

  const data = connection.data;
  const status = data ? (STATUS[data.status] ?? { label: data.status, tone: '' }) : undefined;
  const code = pairing.code ?? pair.data?.code;

  return (
    <section aria-labelledby="conn-t">
      <div className="page-head">
        <h1 id="conn-t">Conexão</h1>
        {status && <span className={`chip ${status.tone}`}>{status.label}</span>}
      </div>
      <ErrorNotice error={connection.error} />
      {data && (
        <div className="card">
          <dl className="facts">
            <dt>Transport</dt>
            <dd className="mono">{data.transport}</dd>
            {data.reason && (
              <>
                <dt>Motivo</dt>
                <dd className="mono">{data.reason}</dd>
              </>
            )}
            <dt>Conta</dt>
            <dd>
              {data.account
                ? (data.account.name ??
                  data.account.phone ??
                  data.account.username ??
                  data.account.id)
                : '—'}
            </dd>
            <dt>Conectado desde</dt>
            <dd>{when(data.connectedSince)}</dd>
            <dt>Reconexões</dt>
            <dd>{data.reconnections}</dd>
          </dl>
          {manage && data.pairing && data.status === 'open' && (
            <button
              type="button"
              className="btn danger"
              disabled={logout.isPending}
              onClick={() => {
                if (
                  window.confirm('Desvincular este número? O bot vai pedir um pareamento novo.')
                ) {
                  logout.mutate();
                }
              }}
            >
              Desvincular número
            </button>
          )}
          <ErrorNotice error={logout.error} />
        </div>
      )}
      {manage && data?.pairing && data.status !== 'open' && (
        <div className="card">
          <h2>Parear</h2>
          {pairing.qr ? (
            <>
              <Qr value={pairing.qr} />
              <p className="muted">
                Escaneie no app do celular.
                {pairing.qrExpiresAt !== undefined && ` Vale até ${when(pairing.qrExpiresAt)}.`}
              </p>
            </>
          ) : (
            <p className="muted">Esperando o QR do transport…</p>
          )}
          <form
            className="row"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              pair.mutate();
            }}
          >
            <label htmlFor="phone" className="sr">
              Telefone com DDI e DDD
            </label>
            <input
              id="phone"
              className="input"
              inputMode="numeric"
              placeholder="5511999999999"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <button type="submit" className="btn" disabled={pair.isPending}>
              Parear por código
            </button>
          </form>
          {code && (
            <p>
              Código: <span className="code">{code}</span>
            </p>
          )}
          <ErrorNotice error={pair.error} />
        </div>
      )}
    </section>
  );
}
