import { useEffect, useState } from 'react';
import { api, liveUrl, setUnauthorizedHandler } from './lib/api.ts';
import {
  createLiveClient,
  initialLive,
  type LiveState,
  reduceLive,
  type SocketLike,
} from './lib/live.ts';
import { Config } from './pages/Config.tsx';
import { Login } from './pages/Login.tsx';
import { Logs } from './pages/Logs.tsx';
import { Overview } from './pages/Overview.tsx';
import { Plugins } from './pages/Plugins.tsx';

// Roteamento por hash: o servidor só conhece `/` e os estáticos, e o app funciona em qualquer basePath.
const ROUTES = [
  { id: 'inicio', label: 'Início', group: 'Bot' },
  { id: 'logs', label: 'Logs', group: 'Bot' },
  { id: 'plugins', label: 'Plugins', group: 'Administração' },
  { id: 'config', label: 'Config', group: 'Administração' },
] as const;

const current = (): string => location.hash.replace(/^#\/?/, '') || 'inicio';

function useLive(enabled: boolean): LiveState {
  const [state, setState] = useState<LiveState>(initialLive);
  useEffect(() => {
    if (!enabled) return;
    const client = createLiveClient({
      // A WebSocket do navegador cumpre o subconjunto que o cliente usa.
      open: () => new WebSocket(liveUrl()) as unknown as SocketLike,
      onMessage: (message) => setState((s) => reduceLive(s, message, Date.now())),
      onConnection: (connected) => setState((s) => ({ ...s, connected })),
    });
    return () => client.close();
  }, [enabled]);
  return state;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [route, setRoute] = useState(current);
  const live = useLive(authed === true);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    api('status').then(
      () => setAuthed(true),
      () => setAuthed(false),
    );
    const onHash = () => setRoute(current());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (authed === null) return <p className="main muted">Carregando…</p>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const logout = async () => {
    await api('logout', { method: 'POST' }).catch(() => undefined);
    setAuthed(false);
  };
  const groups = [...new Set(ROUTES.map((r) => r.group))];

  return (
    <div className="shell">
      <nav className="side" aria-label="Principal">
        <div className="brand">Bridger</div>
        {groups.map((group) => (
          <div key={group} style={{ display: 'contents' }}>
            <div className="group">{group}</div>
            {ROUTES.filter((r) => r.group === group).map((r) => (
              <a
                key={r.id}
                className="nav"
                href={`#/${r.id}`}
                aria-current={route === r.id ? 'page' : undefined}
              >
                {r.label}
              </a>
            ))}
          </div>
        ))}
        <button type="button" className="btn" style={{ marginTop: 'auto' }} onClick={logout}>
          Sair
        </button>
      </nav>
      <main className="main">
        {route === 'logs' ? (
          <Logs live={live} />
        ) : route === 'plugins' ? (
          <Plugins />
        ) : route === 'config' ? (
          <Config />
        ) : (
          <Overview live={live} />
        )}
      </main>
      <nav className="tabbar" aria-label="Principal">
        {ROUTES.map((r) => (
          <a key={r.id} href={`#/${r.id}`} aria-current={route === r.id ? 'page' : undefined}>
            {r.label}
          </a>
        ))}
        <button type="button" className="btn" onClick={logout}>
          Sair
        </button>
      </nav>
    </div>
  );
}
