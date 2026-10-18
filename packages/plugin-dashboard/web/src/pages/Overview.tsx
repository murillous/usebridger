import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { LiveState } from '#web/lib/live.ts';
import { fmtInt, fmtMs, KERNEL, percentile, rowsOf, total } from '#web/lib/metrics.ts';
import { botChip, isFatal, logOrigin, recentLogs, stateLabel } from '#web/lib/overview.ts';
import type { StatusView } from '#web/lib/types.ts';
import { Stat } from './Stat.tsx';
import { useMetrics } from './useMetrics.ts';

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

function Kpis() {
  const { data } = useMetrics(1);
  // Sem o plugin de métricas (ou enquanto carrega) a seção some; a aba Métricas explica.
  if (!data?.available) return null;
  return (
    <section aria-labelledby="kpis-t">
      <div className="row spread">
        <h2 id="kpis-t">Hoje (UTC)</h2>
        <a href="#/metricas">Ver métricas</a>
      </div>
      <div className="kpis">
        <Stat label="Mensagens" value={fmtInt(total(rowsOf(data, KERNEL.handled)))} />
        <Stat label="Usuários ativos" value={fmtInt(total(rowsOf(data, KERNEL.users)))} />
        <Stat label="Grupos ativos" value={fmtInt(total(rowsOf(data, KERNEL.groups)))} />
        <Stat label="Latência p95" value={fmtMs(percentile(rowsOf(data, KERNEL.duration), 0.95))} />
      </div>
    </section>
  );
}

function RecentLogs({ live }: { live: LiveState }) {
  const rows = recentLogs(live.logs, 6);
  return (
    <section className="card" aria-labelledby="logs-t">
      <div className="row spread">
        <h2 id="logs-t">Logs recentes</h2>
        <a href="#/logs">Abrir logs</a>
      </div>
      {rows.length === 0 && <p className="muted">Nenhuma linha ainda.</p>}
      <ul className="ov-recent-logs">
        {rows.map((entry, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lista curta recalculada a cada log; sem estado por item.
          <li key={i}>
            <span className="mono muted">{new Date(entry.time).toLocaleTimeString()}</span>
            <span className={`mono lv-${entry.level}`}>{entry.level}</span>
            <span className="mono muted">{logOrigin(entry)}</span>
            <span className="msg">{entry.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BotCard({ status }: { status: StatusView }) {
  const [copied, setCopied] = useState<boolean | 'erro'>(false);
  const chip = botChip(status);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão de área de transferência: o código segue visível para copiar à mão.
      setCopied('erro');
    }
  };

  return (
    <article className="card ov-bot" aria-label={`Bot ${status.transport}`}>
      <div className="row spread">
        <div>
          <h3>{status.transport}</h3>
          <span className="muted">
            sessão <span className="mono">{status.session}</span>
          </span>
        </div>
        <span className={`chip ${chip.tone}`}>{chip.label}</span>
      </div>
      {/* O core só expõe o estado da conexão; "No ar desde", reconexões e fila de saída não saem dele. */}
      <dl className="ov-facts">
        <dt>Estado</dt>
        <dd>{stateLabel(status)}</dd>
        <dt>Atualizado</dt>
        <dd>{new Date(status.updatedAt).toLocaleTimeString()}</dd>
      </dl>
      {isFatal(status) && (
        <div className="notice danger" role="status">
          <strong>Erro fatal</strong>
          <p>
            {status.reason ?? 'conexão encerrada'}
            {status.message ? `: ${status.message}` : ''}
          </p>
          <a href="#/config">Abrir config</a>
        </div>
      )}
      {status.status === 'connecting' && status.qr && (
        <div className="bot-pair">
          <Qr value={status.qr} />
        </div>
      )}
      {status.status === 'connecting' && status.pairingCode && (
        <div className="bot-pair">
          <span className="bot-pair-code mono">{status.pairingCode}</span>
          <button type="button" className="btn" onClick={() => copy(status.pairingCode ?? '')}>
            {copied === 'erro' ? 'Não foi possível copiar' : copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      )}
    </article>
  );
}

export function Overview({ live }: { live: LiveState }) {
  const { status } = live;
  return (
    <>
      <h1>Visão geral</h1>
      <section aria-labelledby="bots-t">
        <h2 id="bots-t">Bots e transports</h2>
        {status ? (
          <BotCard status={status} />
        ) : (
          <p className="muted">Aguardando o status do bot…</p>
        )}
      </section>
      <Kpis />
      <RecentLogs live={live} />
    </>
  );
}
