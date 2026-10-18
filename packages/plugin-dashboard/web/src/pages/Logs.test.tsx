// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialLive, type LiveState } from '#web/lib/live.ts';
import { Logs } from './Logs.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entry = (level: string, message: string) => ({ level, time: 1_700_000_000_000, message });
const live = (logs: LiveState['logs']): LiveState => ({ ...initialLive, connected: true, logs });
const LOGS = [entry('debug', 'detalhe'), entry('info', 'subiu'), entry('error', 'caiu')];
const log = () => screen.getByRole('log', { name: 'Logs do bot' });

describe('Logs', () => {
  it('lista as linhas a partir do nível mínimo padrão (info)', () => {
    render(<Logs live={live(LOGS)} />);
    expect(within(log()).getByText(/\[info\] subiu/)).toBeTruthy();
    expect(within(log()).getByText(/\[error\] caiu/)).toBeTruthy();
    expect(within(log()).queryByText(/detalhe/)).toBeNull();
  });

  it('filtra pelo nível mínimo e avisa quando nada sobra', async () => {
    const user = userEvent.setup();
    render(<Logs live={live(LOGS)} />);
    await user.selectOptions(screen.getByLabelText('Nível mínimo'), 'debug');
    expect(within(log()).getByText(/detalhe/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Nível mínimo'), 'fatal');
    expect(within(log()).queryByText(/caiu/)).toBeNull();
    expect(within(log()).getByText('Nenhuma linha neste nível.')).toBeTruthy();
  });

  it('não repete o selo "Ao vivo" do cabeçalho do app', () => {
    render(<Logs live={live(LOGS)} />);
    expect(screen.queryByText(/Ao vivo/)).toBeNull();
  });

  it('Pausar congela a lista; Retomar mostra as linhas novas', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Logs live={live(LOGS)} />);
    await user.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(screen.getByText(/^Pausado/)).toBeTruthy();
    rerender(<Logs live={live([...LOGS, entry('warn', 'nova linha')])} />);
    expect(within(log()).queryByText(/nova linha/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retomar' }));
    expect(within(log()).getByText(/\[warn\] nova linha/)).toBeTruthy();
  });
});
