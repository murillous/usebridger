// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialLive, type LiveState } from '#web/lib/live.ts';
import type { LogEntry, StatusView } from '#web/lib/types.ts';
import { LiveBadge } from './LiveBadge.tsx';
import { Overview } from './Overview.tsx';

const NOW = new Date('2026-05-10T12:00:00').getTime();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const status = (over: Partial<StatusView> = {}): StatusView => ({
  transport: 'whatsapp',
  name: 'Luma',
  session: 'principal',
  status: 'open',
  updatedAt: NOW,
  ...over,
});
const live = (over: Partial<LiveState> = {}): LiveState => ({
  ...initialLive,
  connected: true,
  lastUpdate: NOW,
  ...over,
});
const log = (message: string, over: Partial<LogEntry> = {}): LogEntry => ({
  level: 'info',
  time: NOW,
  message,
  ...over,
});
const hora = (ms: number) => new Date(ms).toLocaleTimeString();

describe('Overview: card do bot', () => {
  it('sem status mostra o aviso de espera', () => {
    render(<Overview live={live()} />);
    expect(screen.getByRole('heading', { name: 'Visão geral' })).toBeTruthy();
    expect(screen.getByText('Aguardando o status do bot…')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('bot conectado mostra nome, sessão, estado, no ar desde e reconexões', () => {
    const since = NOW - 3_600_000;
    render(
      <Overview live={live({ status: status({ connectedSince: since, reconnections: 2 }) })} />,
    );
    const card = screen.getByRole('article', { name: 'Bot Luma' });
    expect(within(card).getByRole('heading', { name: 'Luma' })).toBeTruthy();
    expect(within(card).getByText('principal')).toBeTruthy();
    expect(within(card).getByText('Conectado')).toBeTruthy();
    expect(within(card).getByText('Estado').nextElementSibling?.textContent).toBe('Em execução');
    expect(within(card).getByText('No ar desde').nextElementSibling?.textContent).toBe(hora(since));
    expect(within(card).getByText('Reconexões').nextElementSibling?.textContent).toBe('2');
    expect(within(card).getByText('Atualizado').nextElementSibling?.textContent).toBe(hora(NOW));
    expect(within(card).queryByText('Erro fatal')).toBeNull();
  });

  it('sem name cai no transport, sem reconexões mostra 0 e sem connectedSince omite "No ar desde"', () => {
    render(<Overview live={live({ status: status({ name: undefined }) })} />);
    const card = screen.getByRole('article', { name: 'Bot whatsapp' });
    expect(within(card).getByText('Reconexões').nextElementSibling?.textContent).toBe('0');
    expect(within(card).queryByText('No ar desde')).toBeNull();
  });

  it('conexão de outro dia mostra a data junto da hora', () => {
    const since = NOW - 3 * 86_400_000;
    render(<Overview live={live({ status: status({ connectedSince: since }) })} />);
    expect(screen.getByText('No ar desde').nextElementSibling?.textContent).toBe(
      new Date(since).toLocaleString(),
    );
  });

  it('closed não fatal vira "Reconectando" sem aviso de erro', () => {
    render(
      <Overview live={live({ status: status({ status: 'closed', reason: 'connection-lost' }) })} />,
    );
    const card = screen.getByRole('article', { name: 'Bot Luma' });
    expect(within(card).getAllByText('Reconectando')).toHaveLength(2);
    expect(screen.queryByText('Erro fatal')).toBeNull();
  });

  it('closed fatal mostra o motivo, a mensagem e o link para a config', () => {
    render(
      <Overview
        live={live({
          status: status({ status: 'closed', reason: 'replaced', message: 'outra sessão' }),
        })}
      />,
    );
    const aviso = screen.getByRole('status');
    expect(within(aviso).getByText('Erro fatal')).toBeTruthy();
    expect(within(aviso).getByText('replaced: outra sessão')).toBeTruthy();
    expect(within(aviso).getByRole('link', { name: 'Abrir config' }).getAttribute('href')).toBe(
      '#/config',
    );
    expect(screen.getByText('Estado').nextElementSibling?.textContent).toBe('Parado');
  });

  it('auth-failed sem pareamento é fatal e mostra o motivo', () => {
    render(
      <Overview live={live({ status: status({ status: 'closed', reason: 'auth-failed' }) })} />,
    );
    expect(screen.getByRole('status').textContent).toContain('auth-failed');
  });

  it('auth-failed durante o pareamento não é fatal', () => {
    render(
      <Overview
        live={live({ status: status({ status: 'closed', reason: 'auth-failed', pairing: true }) })}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Overview: pareamento', () => {
  it('connecting com QR mostra a imagem e a validade, que desce a cada segundo', async () => {
    render(
      <Overview
        live={live({
          status: status({ status: 'connecting', qr: '2@abc', qrExpiresAt: NOW + 65_000 }),
        })}
      />,
    );
    expect(screen.getByText('Aguardando pareamento')).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'QR code para parear o WhatsApp' })).toBeTruthy();
    expect(screen.getByText('Expira em').nextElementSibling?.textContent).toBe('1:05');
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByText('Expira em').nextElementSibling?.textContent).toBe('1:00');
  });

  it('QR vencido esconde "Expira em"', () => {
    render(
      <Overview
        live={live({ status: status({ status: 'connecting', qr: '2@abc', qrExpiresAt: NOW - 1 }) })}
      />,
    );
    expect(screen.queryByText('Expira em')).toBeNull();
  });

  it('connecting sem QR nem código é só "Conectando"', () => {
    render(<Overview live={live({ status: status({ status: 'connecting' }) })} />);
    expect(screen.getAllByText('Conectando')).toHaveLength(2);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copiar' })).toBeNull();
  });

  it('QR e código só aparecem em connecting', () => {
    render(<Overview live={live({ status: status({ qr: '2@abc', pairingCode: 'ABCD-1234' }) })} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('ABCD-1234')).toBeNull();
  });

  it('código de pareamento: Copiar grava na área de transferência e volta ao normal', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    // O `setup()` do user-event instala o clipboard; o espião entra depois dele.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(
      <Overview
        live={live({ status: status({ status: 'connecting', pairingCode: 'ABCD-1234' }) })}
      />,
    );
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copiar' }));
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(screen.getByRole('button', { name: 'Copiado' })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2100);
    expect(await screen.findByRole('button', { name: 'Copiar' })).toBeTruthy();
  });

  it('falha ao copiar avisa e o código segue visível', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('negado'));
    render(
      <Overview
        live={live({ status: status({ status: 'connecting', pairingCode: 'ABCD-1234' }) })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copiar' }));
    expect(screen.getByRole('button', { name: 'Não foi possível copiar' })).toBeTruthy();
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2100);
    expect(await screen.findByRole('button', { name: 'Copiar' })).toBeTruthy();
  });
});

describe('Overview: logs recentes', () => {
  it('sem logs mostra o vazio', () => {
    render(<Overview live={live()} />);
    expect(screen.getByText('Nenhuma linha ainda.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir logs' }).getAttribute('href')).toBe('#/logs');
  });

  it('mostra as 6 mais novas primeiro, com a origem do plugin ou core', () => {
    const logs = Array.from({ length: 8 }, (_, i) => log(`linha ${i}`));
    logs[7] = log('linha 7', { level: 'warn', fields: { plugin: 'reminders' } });
    render(<Overview live={live({ logs })} />);
    const itens = within(screen.getByRole('region', { name: 'Logs recentes' })).getAllByRole(
      'listitem',
    );
    expect(itens).toHaveLength(6);
    expect(itens[0]?.textContent).toContain('linha 7');
    expect(itens[0]?.textContent).toContain('warn');
    expect(itens[0]?.textContent).toContain('reminders');
    expect(itens[1]?.textContent).toContain('core');
    expect(itens[5]?.textContent).toContain('linha 2');
    expect(screen.queryByText('linha 1')).toBeNull();
  });
});

describe('LiveBadge', () => {
  it('conectado mostra "Ao vivo" e o tempo desde a última mensagem avança', async () => {
    render(<LiveBadge live={live({ lastUpdate: NOW - 2000 })} />);
    expect(screen.getByText('Ao vivo · atualizado há 2 s')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.getByText('Ao vivo · atualizado há 5 s')).toBeTruthy();
  });

  it('menos de 1 s diz "agora"', () => {
    render(<LiveBadge live={live({ lastUpdate: NOW })} />);
    expect(screen.getByText('Ao vivo · atualizado agora')).toBeTruthy();
  });

  it('WS caído vira "Desatualizado" com o tempo parado', () => {
    render(<LiveBadge live={live({ connected: false, lastUpdate: NOW - 90_000 })} />);
    expect(screen.getByRole('status').textContent).toBe(
      'Desatualizado · reconectando · última atualização há 1 min',
    );
  });

  it('sem nenhuma mensagem ainda mostra o travessão', () => {
    render(<LiveBadge live={live({ connected: false, lastUpdate: null })} />);
    expect(screen.getByRole('status').textContent).toContain('última atualização —');
  });

  it('pausa global mostra "Pausado", mesmo conectado', () => {
    render(<LiveBadge live={live({ paused: true, lastUpdate: NOW - 7_200_000 })} />);
    expect(screen.getByText('Pausado · última atualização há 2 h')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
