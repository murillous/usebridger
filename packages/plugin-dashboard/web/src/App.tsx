import { useCallback, useEffect, useState } from 'react';
import { api, liveUrl, setUnauthorizedHandler } from './lib/api.ts';
import {
  createLiveClient,
  initialLive,
  type LiveState,
  reduceLive,
  type SocketLike,
} from './lib/live.ts';
import { applyTheme, loadTheme, saveTheme, THEMES, type Theme } from './lib/theme.ts';
import type { TabView } from './lib/types.ts';
import { Config } from './pages/Config.tsx';
import { Login } from './pages/Login.tsx';
import { Logs } from './pages/Logs.tsx';
import { Metrics } from './pages/Metrics.tsx';
import { Overview } from './pages/Overview.tsx';
import { Plugins } from './pages/Plugins.tsx';
import { Tab } from './pages/Tab.tsx';

const THEME_LABEL: Record<Theme, string> = { auto: 'Automático', light: 'Claro', dark: 'Escuro' };

function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="field">
      <label htmlFor="theme">Tema</label>
      <select
        id="theme"
        className="input"
        value={theme}
        onChange={(e) => onChange(e.target.value as Theme)}
      >
        {THEMES.map((t) => (
          <option key={t} value={t}>
            {THEME_LABEL[t]}
          </option>
        ))}
      </select>
    </div>
  );
}

// Ícones simples (traço de 2 px); o texto da aba continua ao lado, o ícone é decorativo.
const ICONS: Record<string, string> = {
  inicio: 'M3 11l9-8 9 8M5 10v10h14V10',
  plugins: 'M9 3v4M15 3v4M6 7h12v5a6 6 0 0 1-12 0zM12 18v3',
  config: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
  metricas: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  mais: 'M5 12h.01M12 12h.01M19 12h.01',
};

function Icon({ id }: { id: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[id]} />
    </svg>
  );
}

// Roteamento por hash: o servidor só conhece `/` e os estáticos, e o app funciona em qualquer basePath.
const ROUTES = [
  { id: 'inicio', label: 'Início', group: 'Bot' },
  { id: 'metricas', label: 'Métricas', group: 'Bot' },
  { id: 'logs', label: 'Logs', group: 'Bot' },
  { id: 'plugins', label: 'Plugins', group: 'Administração' },
  { id: 'config', label: 'Config', group: 'Administração' },
] as const;

// TabBar do celular (design.md): Logs e a conta ficam em "Mais".
const TABS = [
  { id: 'inicio', label: 'Início', match: ['inicio'] },
  { id: 'metricas', label: 'Métricas', match: ['metricas'] },
  { id: 'plugins', label: 'Plugins', match: ['plugins'] },
  { id: 'config', label: 'Config', match: ['config'] },
  { id: 'mais', label: 'Mais', match: ['mais', 'logs'] },
];
const KNOWN = ['inicio', 'metricas', 'logs', 'plugins', 'config', 'mais'];

const EXT = 'ext/';
const current = (): string => location.hash.replace(/^#\/?/, '') || 'inicio';

function useLive(enabled: boolean): LiveState {
  const [state, setState] = useState<LiveState>(initialLive);
  useEffect(() => {
    if (!enabled) {
      // Deslogado: nenhum dado da sessão anterior sobra na memória.
      setState(initialLive);
      return;
    }
    const client = createLiveClient({
      // A WebSocket do navegador cumpre o subconjunto que o cliente usa.
      open: () => new WebSocket(liveUrl()) as unknown as SocketLike,
      onMessage: (message) => setState((s) => reduceLive(s, message, Date.now())),
      onConnection: (connected) => {
        setState((s) => ({ ...s, connected }));
        // O navegador não expõe o 401 do upgrade do WS: ao cair, uma chamada simples descobre se a
        // sessão acabou (o 401 aciona o portão); outras falhas são só rede fora e o backoff segue.
        if (!connected) api('status').catch(() => undefined);
      },
    });
    return () => client.close();
  }, [enabled]);
  return state;
}

/** Abas de plugins (ADR 0108): o manifesto é lido de novo a cada navegação e a cada reconexão do WS. */
function useTabs(enabled: boolean, route: string, connected: boolean) {
  const [tabs, setTabs] = useState<TabView[]>();
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: route, connected e tick só disparam a releitura.
  useEffect(() => {
    if (!enabled) {
      setTabs(undefined);
      return;
    }
    // Falha de rede ou de uma aba não derruba o app: sem manifesto, o grupo Extensões some.
    api<TabView[]>('tabs').then(setTabs, () => setTabs([]));
  }, [enabled, route, connected, tick]);
  return { tabs, refresh: useCallback(() => setTick((n) => n + 1), []) };
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [route, setRoute] = useState(current);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const chooseTheme = (next: Theme) => {
    saveTheme(next);
    setTheme(next);
  };
  const live = useLive(authed === true);
  const { tabs, refresh } = useTabs(authed === true, route, live.connected);

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
        {tabs && tabs.length > 0 && (
          <>
            <div className="group">Extensões</div>
            {tabs.map((t) => (
              <a
                key={t.key}
                className="nav"
                href={`#/${EXT}${t.key}`}
                aria-current={route === `${EXT}${t.key}` ? 'page' : undefined}
              >
                {t.title}
              </a>
            ))}
          </>
        )}
        <div style={{ marginTop: 'auto' }}>
          <ThemeSwitch theme={theme} onChange={chooseTheme} />
          <button type="button" className="btn" onClick={logout}>
            Sair
          </button>
        </div>
      </nav>
      <main className="main">
        {route === 'logs' ? (
          <Logs live={live} />
        ) : route === 'metricas' ? (
          <Metrics />
        ) : route === 'plugins' ? (
          <Plugins />
        ) : route === 'config' ? (
          <Config />
        ) : route.startsWith(EXT) ? (
          <Tab tabs={tabs} tabKey={route.slice(EXT.length)} refresh={refresh} />
        ) : route === 'mais' ? (
          <section aria-labelledby="mais-t">
            <h1 id="mais-t">Mais</h1>
            <div className="card">
              <p>
                <a className="nav" href="#/logs">
                  Logs
                </a>
              </p>
              {tabs && tabs.length > 0 && (
                <>
                  <h2>Extensões</h2>
                  {tabs.map((t) => (
                    <p key={t.key}>
                      <a className="nav" href={`#/${EXT}${t.key}`}>
                        {t.title}
                      </a>
                    </p>
                  ))}
                </>
              )}
              <ThemeSwitch theme={theme} onChange={chooseTheme} />
              <button type="button" className="btn" onClick={logout}>
                Sair
              </button>
            </div>
          </section>
        ) : (
          <Overview live={live} />
        )}
      </main>
      <nav className="tabbar" aria-label="Principal">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`#/${t.id}`}
            aria-current={
              t.match.includes(route) ||
              (t.id === 'mais' && route.startsWith(EXT)) ||
              (t.id === 'inicio' && !KNOWN.includes(route) && !route.startsWith(EXT))
                ? 'page'
                : undefined
            }
          >
            <Icon id={t.id} />
            {t.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
