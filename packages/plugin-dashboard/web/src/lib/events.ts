import { createContext, useContext, useEffect, useRef } from 'react';
import { endpoints } from './endpoints.ts';

export type Listener = (data: unknown) => void;

/** O stream do app: um `EventSource` só, repartido entre as telas. */
export interface EventHub {
  /** Tipos que o stream pediu (os que a pessoa pode receber). */
  readonly types: readonly string[];
  on(type: string, listener: Listener): () => void;
}

/**
 * Abre `GET /events?types=...`. O `EventSource` autentica pelo cookie e reconecta
 * sozinho com `Last-Event-ID`, sem repetir evento. `onState` diz se o stream está no ar.
 */
export function openEvents(
  types: readonly string[],
  onState: (open: boolean) => void,
): {
  hub: EventHub;
  close(): void;
} {
  const listeners = new Map<string, Set<Listener>>();
  const hub: EventHub = {
    types,
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  if (types.length === 0) return { hub, close: () => undefined };
  const source = new EventSource(`${endpoints().api}/events?types=${types.join(',')}`);
  source.onopen = () => onState(true);
  source.onerror = () => onState(false);
  for (const type of types) {
    source.addEventListener(type, (event) => {
      let data: unknown;
      try {
        data = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        // Evento ilegível não derruba a tela: o próximo, ou a releitura da API, corrige.
        data = undefined;
      }
      if (data === undefined) return;
      for (const listener of listeners.get(type) ?? []) listener(data);
    });
  }
  return {
    hub,
    close() {
      source.close();
      onState(false);
    },
  };
}

export const EventsContext = createContext<EventHub>({ types: [], on: () => () => undefined });

/** Assina um tipo do stream enquanto a tela está montada. */
export function useEvent(type: string, listener: Listener): void {
  const hub = useContext(EventsContext);
  // O listener muda a cada render; a assinatura não.
  const current = useRef(listener);
  current.current = listener;
  useEffect(() => hub.on(type, (data) => current.current(data)), [hub, type]);
}
