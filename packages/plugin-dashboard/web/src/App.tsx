import { useCallback, useEffect, useState } from 'react';
import { configPluginOf } from '#web/lib/schema.ts';
import { api, liveUrl, setUnauthorizedHandler } from './lib/api.ts';
import {
  createLiveClient,
  initialLive,
  type LiveState,
  reduceLive,
  type SocketLike,
} from './lib/live.ts';
import { applyTheme, loadTheme, resolveTheme, saveTheme, THEMES, type Theme } from './lib/theme.ts';
import type { TabView } from './lib/types.ts';
import { Config } from './pages/Config.tsx';
import { LiveBadge } from './pages/LiveBadge.tsx';
import { Login } from './pages/Login.tsx';
import { Logs } from './pages/Logs.tsx';
import { Metrics } from './pages/Metrics.tsx';
import { Overview } from './pages/Overview.tsx';
import { Plugins } from './pages/Plugins.tsx';
import { Tab } from './pages/Tab.tsx';

const THEME_LABEL: Record<Theme, string> = { auto: 'Sistema', light: 'Claro', dark: 'Escuro' };

function Chevron() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// Ícones simples (traço de 2 px); o texto da aba continua ao lado, o ícone é decorativo.
const ICONS: Record<string, string> = {
  inicio: 'M3 11l9-8 9 8M5 10v10h14V10',
  plugins: 'M9 3v4M15 3v4M6 7h12v5a6 6 0 0 1-12 0zM12 18v3',
  config: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
  metricas: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  pausa: 'M8 5v14M16 5v14',
  retomar: 'M7 4l13 8-13 8z',
  lua: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
  sol: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  mais: 'M5 12h.01M12 12h.01M19 12h.01',
};

function Icon({ id, size = 22 }: { id: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
  { id: 'inicio', label: 'Visão geral', group: 'Bot' },
  { id: 'metricas', label: 'Métricas', group: 'Bot' },
  { id: 'logs', label: 'Logs', group: 'Bot' },
  { id: 'plugins', label: 'Plugins', group: 'Administração' },
  { id: 'config', label: 'Configuração', group: 'Administração' },
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

/** Preferência de cor do sistema, atualizada quando muda (o botão de tema depende dela no `auto`). */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return dark;
}

function useLive(enabled: boolean, paused: boolean): LiveState {
  const [state, setState] = useState<LiveState>(initialLive);
  useEffect(() => {
    if (!enabled) {
      // Deslogado: nenhum dado da sessão anterior sobra na memória.
      setState(initialLive);
      return;
    }
    // Pausado: sem WS, a tela congela no último estado (o selo avisa); retomar reconecta e recebe novo snapshot.
    if (paused) return;
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
  }, [enabled, paused]);
  return { ...state, paused };
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
  // `#/config/<plugin>` abre a Config já no plugin; para o resto do app é a página `config`.
  const page = route.startsWith('config/') ? 'config' : route;
  const configPlugin = configPluginOf(route);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const chooseTheme = (next: Theme) => {
    saveTheme(next);
    setTheme(next);
  };
  const [paused, setPaused] = useState(false);
  const live = useLive(authed === true, paused);
  const systemDark = useSystemDark();
  const dark = resolveTheme(theme, systemDark) === 'dark';
  const actions = (
    <>
      <button
        type="button"
        className="btn iconbtn"
        aria-pressed={paused}
        aria-label={paused ? 'Retomar atualização' : 'Pausar atualização'}
        onClick={() => setPaused((p) => !p)}
      >
        <Icon id={paused ? 'retomar' : 'pausa'} size={18} />
        <span className="label">{paused ? 'Retomar atualização' : 'Pausar atualização'}</span>
      </button>
      <button
        type="button"
        className="btn iconbtn"
        aria-label={dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'}
        onClick={() => chooseTheme(dark ? 'light' : 'dark')}
      >
        <Icon id={dark ? 'sol' : 'lua'} size={18} />
      </button>
    </>
  );
  const session = live.status?.session ?? 'default';
  const sessionSelect = (
    // A API expõe só a sessão deste plugin (ADR 0110); trocar de sessão é abrir o dashboard dela.
    <select className="input" aria-label="Sessão" defaultValue={session} key={session}>
      <option value={session}>{session}</option>
    </select>
  );
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
        <div className="brand">
          <span className="mark" aria-hidden="true">
            B
          </span>
          <span>
            Bridger
            <small>dashboard</small>
          </span>
        </div>
        <div className="group">Sessão</div>
        {sessionSelect}
        {groups.map((group) => (
          <div key={group} style={{ display: 'contents' }}>
            <div className="group">{group}</div>
            {ROUTES.filter((r) => r.group === group).map((r) => (
              <a
                key={r.id}
                className="nav"
                href={`#/${r.id}`}
                aria-current={page === r.id ? 'page' : undefined}
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
        <div className="side-foot">
          {live.status?.versions && (
            <p className="mono muted versions">
              core {live.status.versions.core} · dashboard {live.status.versions.dashboard}
            </p>
          )}
          <button type="button" className="btn" onClick={logout}>
            Sair
          </button>
        </div>
      </nav>
      <main className="main">
        <div className="topbar">
          <span className="mark" aria-hidden="true">
            B
          </span>
          {sessionSelect}
          <div className="row">{actions}</div>
        </div>
        <header className="head">
          <span className="muted">
            {live.status ? `${live.status.transport} · sessão ${live.status.session}` : '—'}
          </span>
          <div className="row">
            <LiveBadge live={live} />
            {actions}
          </div>
        </header>
        {page === 'logs' ? (
          <Logs live={live} />
        ) : page === 'metricas' ? (
          <Metrics />
        ) : page === 'plugins' ? (
          <Plugins />
        ) : page === 'config' ? (
          <Config selected={configPlugin} />
        ) : page.startsWith(EXT) ? (
          <Tab tabs={tabs} tabKey={page.slice(EXT.length)} refresh={refresh} />
        ) : page === 'mais' ? (
          <section aria-labelledby="mais-t" className="mais">
            <h1 id="mais-t">Mais</h1>
            <div className="group">Bot</div>
            <div className="card list-card">
              <a className="item" href="#/logs">
                Logs
                <Chevron />
              </a>
            </div>
            {tabs && tabs.length > 0 && (
              <>
                <div className="group spread-group">
                  <span>Extensões</span>
                  <span>de plugins</span>
                </div>
                <div className="card list-card">
                  {tabs.map((t) => (
                    <a key={t.key} className="item" href={`#/${EXT}${t.key}`}>
                      <span>
                        {t.title}
                        <span className="mono muted sub">{t.plugin}</span>
                      </span>
                      <Chevron />
                    </a>
                  ))}
                </div>
                <p className="muted note">
                  Cada plugin que contribui em dashboard.tabs ganha uma linha aqui. Sem limite de
                  quantidade, ao contrário da barra inferior.
                </p>
              </>
            )}
            <div className="group">Conta</div>
            <div className="card list-card">
              <label className="item" htmlFor="theme">
                Tema
                <select
                  id="theme"
                  className="plain"
                  value={theme}
                  onChange={(e) => chooseTheme(e.target.value as Theme)}
                >
                  {THEMES.map((t) => (
                    <option key={t} value={t}>
                      {THEME_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="item" onClick={logout}>
                Sair
              </button>
            </div>
            {live.status?.versions && (
              <p className="mono muted versions-line">
                core {live.status.versions.core} · dashboard {live.status.versions.dashboard}
              </p>
            )}
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
              t.match.includes(page) ||
              (t.id === 'mais' && page.startsWith(EXT)) ||
              (t.id === 'inicio' && !KNOWN.includes(page) && !page.startsWith(EXT))
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
