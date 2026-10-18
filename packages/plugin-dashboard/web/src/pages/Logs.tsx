import { useState } from 'react';
import type { LiveState } from '#web/lib/live.ts';
import type { LogEntry } from '#web/lib/types.ts';
import { LiveBadge } from './LiveBadge.tsx';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export function Logs({ live }: { live: LiveState }) {
  const [level, setLevel] = useState('info');
  // Pausar local: congela só a lista exibida; o WS segue acumulando e "Retomar" volta ao vivo.
  // Difere do pausar global do cabeçalho (App), que fecha o WS e para todas as telas.
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null);
  const source = frozen ?? live.logs;
  const min = LEVELS.indexOf(level);
  const shown = source.filter((entry) => LEVELS.indexOf(entry.level) >= min);

  return (
    <>
      <div className="row spread">
        <h1>Logs</h1>
        <LiveBadge live={live} paused={frozen !== null} />
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="level">Nível mínimo</label>
          <select
            id="level"
            className="input"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            {LEVELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </div>
        <button type="button" className="btn" onClick={() => setFrozen(frozen ? null : live.logs)}>
          {frozen ? 'Retomar' : 'Pausar'}
        </button>
      </div>
      <div className="logs" role="log" aria-label="Logs do bot">
        {shown.length === 0 && <span className="muted">Nenhuma linha neste nível.</span>}
        {shown.map((entry, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: linhas só são anexadas; não há reordenação.
          <div key={i} className={`lv-${entry.level}`}>
            {new Date(entry.time).toLocaleTimeString()} [{entry.level}] {entry.message}
          </div>
        ))}
      </div>
    </>
  );
}
