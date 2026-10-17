import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { LiveState } from '#web/lib/live.ts';
import { LiveBadge } from './LiveBadge.tsx';

const LABEL = { connecting: 'Conectando', open: 'Conectado', closed: 'Desconectado' } as const;
const TONE = { connecting: 'warn', open: 'ok', closed: 'danger' } as const;

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
  return src ? <img className="qr" src={src} alt="QR code para parear o WhatsApp" /> : null;
}

export function Overview({ live }: { live: LiveState }) {
  const { status } = live;
  const [copied, setCopied] = useState(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão de área de transferência: o código segue visível para copiar à mão.
      setCopied(false);
    }
  };

  return (
    <>
      <div className="row spread">
        <h1>Visão geral</h1>
        <LiveBadge live={live} />
      </div>
      {!status ? (
        <p className="muted">Aguardando o status do bot…</p>
      ) : (
        <section className="card" aria-labelledby="conn">
          <h2 id="conn">Conexão</h2>
          <p className="row">
            <span className={`chip ${TONE[status.status]}`}>{LABEL[status.status]}</span>
            <span className="muted">
              {status.transport} · sessão <span className="mono">{status.session}</span>
            </span>
          </p>
          {status.status === 'closed' && (status.reason || status.message) && (
            <p className="notice danger" role="status">
              {status.reason}
              {status.message ? `: ${status.message}` : ''}
            </p>
          )}
          {status.qr && (
            <div>
              <h2>Escaneie o QR</h2>
              <Qr value={status.qr} />
            </div>
          )}
          {status.pairingCode && (
            <div>
              <h2>Código de pareamento</h2>
              <p className="row">
                <span className="mono" style={{ fontSize: 20 }}>
                  {status.pairingCode}
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => copy(status.pairingCode ?? '')}
                >
                  {copied ? 'Copiado' : 'Copiar'}
                </button>
              </p>
            </div>
          )}
        </section>
      )}
    </>
  );
}
