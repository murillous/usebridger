import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler } from './lib/client.ts';
import { endpoints } from './lib/endpoints.ts';
import { type EventHub, EventsContext, openEvents } from './lib/events.ts';
import { href, useRoute } from './lib/route.ts';
import { type OpenApiDocument, resourcesFromSpec } from './lib/spec.ts';
import { applyTheme, loadTheme, resolveTheme, saveTheme, type Theme } from './lib/theme.ts';
import { can, loadViewer, type Viewer, ViewerContext } from './lib/viewer.ts';
import { Account } from './pages/Account.tsx';
import { Audit } from './pages/Audit.tsx';
import { Connection, type PairingState } from './pages/Connection.tsx';
import { Keys } from './pages/Keys.tsx';
import { AcceptInvite, Login } from './pages/Login.tsx';
import { Logs } from './pages/Logs.tsx';
import { Metrics } from './pages/Metrics.tsx';
import { PluginConfig } from './pages/PluginConfig.tsx';
import { Plugins } from './pages/Plugins.tsx';
import { Resource } from './pages/Resource.tsx';
import { Users } from './pages/Users.tsx';

/** Raiz do app: cache de dados e a decisão entre login e painel. */
export function App({ client }: { client?: QueryClient }) {
  const [queries] = useState(
    () => client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={queries}>
      <Gate />
    </QueryClientProvider>
  );
}

function Gate() {
  const route = useRoute();
  const queries = useQueryClient();
  // `null` carregando; `undefined` precisa entrar.
  const [viewer, setViewer] = useState<Viewer | undefined | null>(null);
  const [failure, setFailure] = useState<string>();

  const reload = useCallback(() => {
    setFailure(undefined);
    loadViewer().then(setViewer, (error: Error) => setFailure(error.message));
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(() => {
      queries.clear();
      setViewer(undefined);
    });
    reload();
  }, [queries, reload]);

  if (failure !== undefined) {
    return (
      <div className="gate">
        <div className="card login">
          <p className="notice danger" role="alert">
            Não deu para falar com a API: {failure}
          </p>
          <button type="button" className="btn" onClick={reload}>
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }
  if (viewer === null) return <p className="main muted">Carregando…</p>;
  if (viewer === undefined) {
    return route[0] === 'convite' ? <AcceptInvite onDone={reload} /> : <Login onDone={reload} />;
  }
  return (
    <ViewerContext.Provider value={viewer}>
      <Shell
        viewer={viewer}
        route={route}
        onLogout={() => {
          queries.clear();
          setViewer(undefined);
        }}
      />
    </ViewerContext.Provider>
  );
}

interface NavItem {
  id: string;
  label: string;
  group: string;
  show: boolean;
}

function Shell({ viewer, route, onLogout }: { viewer: Viewer; route: string[]; onLogout(): void }) {
  const queries = useQueryClient();
  const allowed = (permission: string) => can(viewer, permission);
  const [menu, setMenu] = useState(false);
  const [live, setLive] = useState(false);
  const [pairing, setPairing] = useState<PairingState>({});
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const dark = resolveTheme(theme, matchMedia('(prefers-color-scheme: dark)').matches) === 'dark';

  const spec = useQuery({
    queryKey: ['spec'],
    queryFn: async () => {
      const response = await fetch(endpoints().spec, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`spec: HTTP ${response.status}`);
      return (await response.json()) as OpenApiDocument;
    },
  });
  const { apiPath } = endpoints();
  const resources = useMemo(
    () =>
      resourcesFromSpec(spec.data ?? {}, apiPath).filter((r) =>
        [r.list, r.get, r.create].some((op) => op !== undefined && can(viewer, op.permission)),
      ),
    [spec.data, apiPath, viewer],
  );
  const hasMetrics = spec.data?.paths?.[`${apiPath}/plugins/metrics/catalog`] !== undefined;

  // Um stream só, com os tipos que a pessoa pode receber. O `GET /events` pede `connection.read`:
  // sem ela o stream levaria 403 e o `EventSource` tentaria de novo para sempre.
  const types = allowed('connection.read')
    ? [
        'connection.status',
        'plugin.status',
        ...(allowed('connection.manage') ? ['connection.qr', 'connection.pairing-code'] : []),
        ...(allowed('logs.read') ? ['log'] : []),
      ].join(',')
    : '';
  const [hub, setHub] = useState<EventHub>();
  useEffect(() => {
    const events = openEvents(types === '' ? [] : types.split(','), setLive);
    events.hub.on('connection.qr', (data) => {
      const { qr, expiresAt } = data as { qr: string; expiresAt?: number };
      setPairing({ qr, ...(expiresAt !== undefined && { qrExpiresAt: expiresAt }) });
    });
    events.hub.on('connection.pairing-code', (data) => {
      setPairing({ code: (data as { code: string }).code });
    });
    events.hub.on('connection.status', (data) => {
      // QR e código só valem enquanto conecta; o status novo também muda o `GET /connection`.
      if ((data as { status: string }).status !== 'connecting') setPairing({});
      queries.invalidateQueries({ queryKey: ['connection'] });
    });
    events.hub.on('plugin.status', () => {
      // Plugin que sobe ou desce muda a lista e os recursos da spec.
      queries.invalidateQueries({ queryKey: ['plugins'] });
      queries.invalidateQueries({ queryKey: ['spec'] });
    });
    setHub(events.hub);
    return events.close;
  }, [types, queries]);

  const chooseTheme = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  };
  const logout = async () => {
    // Falha de rede no logout não prende a pessoa no painel: o cookie vence sozinho.
    await api()
      .POST('/api/auth/logout')
      .catch(() => undefined);
    onLogout();
  };

  const nav: NavItem[] = [
    { id: '', label: 'Conexão', group: 'Bot', show: allowed('connection.read') },
    { id: 'logs', label: 'Logs', group: 'Bot', show: allowed('logs.read') },
    { id: 'plugins', label: 'Plugins', group: 'Bot', show: allowed('plugins.read') },
    {
      id: 'metricas',
      label: 'Métricas',
      group: 'Bot',
      show: hasMetrics && allowed('metrics.read'),
    },
    { id: 'auditoria', label: 'Auditoria', group: 'Administração', show: allowed('audit.read') },
    {
      id: 'usuarios',
      label: 'Usuários',
      group: 'Administração',
      show: viewer.kind !== 'open' && allowed('users.manage'),
    },
    {
      id: 'chaves',
      label: 'API keys',
      group: 'Administração',
      show: viewer.kind !== 'open' && allowed('keys.manage'),
    },
    { id: 'conta', label: 'Minha conta', group: 'Conta', show: viewer.kind === 'user' },
  ];
  const visible = nav.filter((item) => item.show);
  const groups = [...new Set(visible.map((item) => item.group))];
  const page = route[0] ?? '';

  let content: React.ReactNode;
  if (page === 'logs' && allowed('logs.read')) content = <Logs />;
  else if (page === 'plugins' && route[1] !== undefined && allowed('config.read'))
    content = <PluginConfig key={route[1]} name={route[1]} />;
  else if (page === 'plugins' && allowed('plugins.read')) content = <Plugins />;
  else if (page === 'metricas' && hasMetrics) content = <Metrics />;
  else if (page === 'auditoria' && allowed('audit.read')) content = <Audit />;
  else if (page === 'usuarios' && viewer.kind !== 'open' && allowed('users.manage'))
    content = <Users />;
  else if (page === 'chaves' && viewer.kind !== 'open' && allowed('keys.manage'))
    content = <Keys />;
  else if (page === 'conta' && viewer.kind === 'user') content = <Account onLogout={onLogout} />;
  else if (page === 'recursos') {
    const view = resources.find((r) => r.key === `${route[1]}/${route[2]}`);
    content = view ? (
      <Resource view={view} itemId={route[3]} />
    ) : (
      <p className="muted">{spec.isPending ? 'Carregando…' : 'Recurso não encontrado.'}</p>
    );
  } else if (allowed('connection.read')) content = <Connection pairing={pairing} />;
  else content = <p className="muted">Nada para mostrar com as suas permissões.</p>;

  const themeButton = (
    <button
      type="button"
      className="btn iconbtn"
      aria-label={dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'}
      onClick={() => chooseTheme(dark ? 'light' : 'dark')}
    >
      {dark ? 'Claro' : 'Escuro'}
    </button>
  );

  return (
    <EventsContext.Provider value={hub ?? { types: [], on: () => () => undefined }}>
      <div className="shell">
        <nav className="side" aria-label="Principal" data-open={menu}>
          <div className="brand">
            <span className="mark" aria-hidden="true">
              B
            </span>
            <span>
              Bridger
              <small>dashboard</small>
            </span>
          </div>
          {groups.map((group) => (
            <div key={group} style={{ display: 'contents' }}>
              <div className="group">{group}</div>
              {visible
                .filter((item) => item.group === group)
                .map((item) => (
                  <a
                    key={item.id}
                    className="nav"
                    href={`#/${item.id}`}
                    onClick={() => setMenu(false)}
                    aria-current={page === item.id ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                ))}
            </div>
          ))}
          {resources.length > 0 && <div className="group">Recursos de plugins</div>}
          {resources.map((r) => (
            <a
              key={r.key}
              className="nav"
              href={href('recursos', r.plugin, r.resource)}
              onClick={() => setMenu(false)}
              aria-current={
                page === 'recursos' && `${route[1]}/${route[2]}` === r.key ? 'page' : undefined
              }
            >
              {r.resource}
              <span className="muted mono">&nbsp;{r.plugin}</span>
            </a>
          ))}
          <div className="side-foot">
            <p className="muted versions">
              {viewer.kind === 'open' ? 'API sem auth (loopback)' : viewer.name}
            </p>
            {viewer.kind !== 'open' && (
              <button type="button" className="btn" onClick={logout}>
                Sair
              </button>
            )}
          </div>
        </nav>
        <main className="main">
          <div className="topbar">
            <button
              type="button"
              className="btn"
              aria-expanded={menu}
              onClick={() => setMenu((open) => !open)}
            >
              Menu
            </button>
            <span className="brand">Bridger</span>
            {themeButton}
          </div>
          <header className="head">
            <span className={live ? 'chip ok' : 'chip'}>
              {types === '' ? 'sem tempo real' : live ? 'ao vivo' : 'reconectando'}
            </span>
            {themeButton}
          </header>
          {content}
        </main>
      </div>
    </EventsContext.Provider>
  );
}
