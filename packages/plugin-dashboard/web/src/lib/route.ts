import { useEffect, useState } from 'react';

/** Rota do app no hash (`#/plugins/ia/config`), em segmentos já decodificados. */
export function parseRoute(hash: string): string[] {
  const [path = ''] = hash.replace(/^#\/?/, '').split('?');
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        // `%` solto no hash digitado à mão: mostra o segmento como veio.
        return part;
      }
    });
}

/** Parâmetro do hash (`#/convite?token=...`): o token do convite não vai ao servidor nem ao log. */
export function hashParam(hash: string, name: string): string | undefined {
  const query = hash.split('?')[1];
  return query === undefined ? undefined : (new URLSearchParams(query).get(name) ?? undefined);
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export const href = (...parts: string[]): string =>
  `#/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
