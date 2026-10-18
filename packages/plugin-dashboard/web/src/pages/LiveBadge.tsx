import { useEffect, useState } from 'react';
import { type LiveState, relativeAgo } from '#web/lib/live.ts';

/** "Ao vivo" só quando o WS está aberto; senão mostra há quanto tempo os dados estão parados. */
export function LiveBadge({ live, paused }: { live: LiveState; paused?: boolean }) {
  // Relógio de 1 s só para o texto relativo avançar entre mensagens.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ago = live.lastUpdate ? relativeAgo(live.lastUpdate, now) : '—';
  if (paused) return <span className="chip warn">Pausado · última atualização {ago}</span>;
  if (!live.connected) {
    return (
      <span className="chip danger" role="status">
        Desatualizado · reconectando · última atualização {ago}
      </span>
    );
  }
  return <span className="chip ok">Ao vivo · atualizado {ago}</span>;
}
