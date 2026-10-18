import type { LiveState } from '#web/lib/live.ts';

/** "Ao vivo" só quando o WS está aberto; senão mostra desde quando os dados estão parados. */
export function LiveBadge({ live, paused }: { live: LiveState; paused?: boolean }) {
  const time = live.lastUpdate ? new Date(live.lastUpdate).toLocaleTimeString() : '—';
  if (paused) return <span className="chip warn">Pausado · última atualização {time}</span>;
  if (!live.connected) {
    return (
      <span className="chip danger" role="status">
        Desatualizado · reconectando · última atualização {time}
      </span>
    );
  }
  return <span className="chip ok">Ao vivo · {time}</span>;
}
