// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExchangeKeysConfig } from './ExchangeKeysConfig';
import { IpfsConfig } from './IpfsConfig';
import { JitoRegionsConfig } from './JitoRegionsConfig';
import { PriorityFeeConfig } from './PriorityFeeConfig';
import { RaydiumConfig } from './RaydiumConfig';
import { RetryConfig } from './RetryConfig';
import { TipStrategyConfig } from './TipStrategyConfig';
import { TradingConfig } from './TradingConfig';
import { DEFAULT_JITO_REGIONS } from './jito_regions';

afterEach(cleanup);

function handlers() {
  return {
    onSave: vi.fn(),
    onValidate: vi.fn<(patch: Record<string, unknown>) => Promise<{ ok: boolean; errors: string[] }>>(),
    busy: false,
  };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('JitoRegionsConfig', () => {
  it('переключает регион и сохраняет { jitoRegions }', () => {
    const h = handlers();
    render(<JitoRegionsConfig value={DEFAULT_JITO_REGIONS} {...h} />);

    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    expect(button('Применить').disabled).toBe(true); // нет изменений

    fireEvent.click(screen.getByRole('checkbox', { name: /tokyo/ }));
    fireEvent.click(button('Применить'));

    const { jitoRegions } = h.onSave.mock.calls[0][0] as { jitoRegions: typeof DEFAULT_JITO_REGIONS };
    expect(jitoRegions.find((r) => r.id === 'tokyo')?.enabled).toBe(true);
    expect(DEFAULT_JITO_REGIONS.find((r) => r.id === 'tokyo')?.enabled).toBe(false); // props не мутированы
  });

  it('нельзя выключить все регионы', () => {
    const h = handlers();
    render(<JitoRegionsConfig value={[{ id: 'a', url: 'a.test', enabled: true }]} {...h} />);

    fireEvent.click(screen.getByRole('checkbox'));

    expect(screen.getByRole('alert').textContent).toMatch(/хотя бы один/);
    expect(button('Применить').disabled).toBe(true);
  });
});

describe('TipStrategyConfig', () => {
  it('показывает поля по типу и сохраняет стратегию для calculateTip', () => {
    const h = handlers();
    render(<TipStrategyConfig value={{ type: 'manual', lamports: 50_000 }} {...h} />);

    expect(field('Чаевые, лампорты').value).toBe('50000');
    expect(screen.queryByLabelText('Перцентиль, %')).toBeNull();

    change(field('Стратегия'), 'percentile');
    change(field('Перцентиль, %'), '90');
    change(field('Минимум, лампорты'), '20000');
    fireEvent.click(button('Применить'));

    expect(h.onSave).toHaveBeenCalledWith({
      tipStrategy: { type: 'percentile', percentile: 90, minLamports: 20_000 },
    });
  });

  it('чаевые меньше 1000 лампортов → ошибка', () => {
    render(<TipStrategyConfig value={{ type: 'manual', lamports: 50_000 }} {...handlers()} />);

    change(field('Чаевые, лампорты'), '500');

    expect(screen.getByRole('alert').textContent).toMatch(/1000/);
    expect(button('Применить').disabled).toBe(true);
  });
});

describe('PriorityFeeConfig', () => {
  it('сохраняет { priorityFeeMicroLamports } числом', () => {
    const h = handlers();
    render(<PriorityFeeConfig value={100_000} {...h} />);

    change(field('Цена, µlamports за CU'), '250000');
    fireEvent.click(button('Применить'));

    expect(h.onSave).toHaveBeenCalledWith({ priorityFeeMicroLamports: 250_000 });
  });

  it('пустое и дробное значение не сохраняются', () => {
    render(<PriorityFeeConfig value={100_000} {...handlers()} />);

    change(field('Цена, µlamports за CU'), '');
    expect(button('Применить').disabled).toBe(true);
    change(field('Цена, µlamports за CU'), '1.5');
    expect(button('Применить').disabled).toBe(true);
  });
});

describe('RetryConfig', () => {
  it('числа и чекбоксы → { retry }', () => {
    const h = handlers();
    render(
      <RetryConfig
        value={{ maxRetries: 3, tipIncreasePercent: 20, blockhashRefresh: true, regionFallback: false }}
        {...h}
      />,
    );

    change(field('Всего попыток'), '2');
    fireEvent.click(screen.getByRole('checkbox', { name: /все регионы/ }));
    fireEvent.click(button('Применить'));

    expect(h.onSave).toHaveBeenCalledWith({
      retry: { maxRetries: 2, tipIncreasePercent: 20, blockhashRefresh: true, regionFallback: true },
    });
  });
});

describe('ExchangeKeysConfig', () => {
  const value = { exchange: 'binance', apiKey: 'k', secret: 's' };

  it('секреты — password; «Проверить» вызывает onValidate и показывает результат', async () => {
    const h = handlers();
    h.onValidate.mockResolvedValue({ ok: true, errors: [] });
    render(<ExchangeKeysConfig value={value} {...h} />);

    expect(field('API key').type).toBe('password');
    expect(field('Secret').type).toBe('password');

    change(field('Биржа'), 'bybit');
    fireEvent.click(button('Проверить'));

    expect(h.onValidate).toHaveBeenCalledWith({ exchangeKeys: { exchange: 'bybit', apiKey: 'k', secret: 's' } });
    expect((await screen.findByRole('status')).textContent).toMatch(/работает/);

    // Изменение формы сбрасывает результат проверки.
    change(field('Secret'), 's2');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ошибки проверки и исключение onValidate показываются', async () => {
    const h = handlers();
    h.onValidate.mockResolvedValueOnce({ ok: false, errors: ['Invalid API key'] });
    render(<ExchangeKeysConfig value={value} {...h} />);

    fireEvent.click(button('Проверить'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid API key/);

    h.onValidate.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(button('Проверить'));
    expect((await screen.findByText('network down')).tagName).toBe('LI');
  });

  it('«Сохранить» → onSave({ exchangeKeys })', () => {
    const h = handlers();
    render(<ExchangeKeysConfig value={value} {...h} />);

    change(field('API key'), 'new-key');
    fireEvent.click(button('Сохранить'));

    expect(h.onSave).toHaveBeenCalledWith({ exchangeKeys: { exchange: 'binance', apiKey: 'new-key', secret: 's' } });
  });
});

describe('IpfsConfig', () => {
  it('проверка и сохранение { ipfs }; arweave блокирует кнопки', async () => {
    const h = handlers();
    h.onValidate.mockResolvedValue({ ok: true, errors: [] });
    render(<IpfsConfig value={{ provider: 'pinata', apiKey: 'a', secret: 'b' }} {...h} />);

    expect(field('API secret').type).toBe('password');
    change(field('API key'), 'a2');
    fireEvent.click(button('Проверить'));
    expect(h.onValidate).toHaveBeenCalledWith({ ipfs: { provider: 'pinata', apiKey: 'a2', secret: 'b' } });
    await screen.findByRole('status');

    fireEvent.click(button('Сохранить'));
    expect(h.onSave).toHaveBeenCalledWith({ ipfs: { provider: 'pinata', apiKey: 'a2', secret: 'b' } });

    change(field('Провайдер'), 'arweave');
    expect(button('Проверить').disabled).toBe(true);
    expect(button('Сохранить').disabled).toBe(true);
  });
});

describe('RaydiumConfig', () => {
  it('сохраняет конфиг с bigint токенов и предупреждает о вечной блокировке', () => {
    const h = handlers();
    render(
      <RaydiumConfig
        value={{ poolType: 'amm', initialLiquiditySol: 10, initialLiquidityTokens: 1_000n, lockLp: false, lockPeriodDays: 0 }}
        {...h}
      />,
    );

    expect(field('Срок блокировки, дней').disabled).toBe(true);
    change(field('Тип пула'), 'clmm');
    change(field('Токены в пул'), '800000000000000');
    fireEvent.click(screen.getByRole('checkbox', { name: /Заблокировать/ }));
    expect(screen.getByRole('note').textContent).toMatch(/необратима/);
    fireEvent.click(button('Применить'));

    expect(h.onSave).toHaveBeenCalledWith({
      raydium: {
        poolType: 'clmm',
        initialLiquiditySol: 10,
        initialLiquidityTokens: 800_000_000_000_000n,
        lockLp: true,
        lockPeriodDays: 0,
      },
    });
  });

  it('токены не целое число → ошибка', () => {
    render(
      <RaydiumConfig
        value={{ poolType: 'amm', initialLiquiditySol: 10, initialLiquidityTokens: 1_000n, lockLp: false, lockPeriodDays: 0 }}
        {...handlers()}
      />,
    );

    change(field('Токены в пул'), '1.5');

    expect(button('Применить').disabled).toBe(true);
  });
});

describe('TradingConfig', () => {
  it('trailing → { trading } с процентом', () => {
    const h = handlers();
    render(<TradingConfig value={{ exitStrategy: 'manual' }} {...h} />);

    change(field('Стратегия'), 'trailing');
    change(field('Падение от пика, %'), '12');
    fireEvent.click(button('Применить'));

    expect(h.onSave).toHaveBeenCalledWith({ trading: { exitStrategy: 'trailing', trailingStopPercent: 12 } });
  });

  it('DCA: добавление/удаление шагов, секунды → мс', () => {
    const h = handlers();
    render(
      <TradingConfig
        value={{ exitStrategy: 'dca', dcaIntervals: [{ time: 10_000, percent: 50 }] }}
        {...h}
      />,
    );

    expect(screen.getByRole('note').textContent).toMatch(/останется/); // последний шаг не 100 %
    fireEvent.click(button('+ Шаг'));
    change(field('Пауза шага 2'), '20');
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(button('Применить'));

    expect(h.onSave).toHaveBeenCalledWith({
      trading: {
        exitStrategy: 'dca',
        dcaIntervals: [
          { time: 10_000, percent: 50 },
          { time: 20_000, percent: 100 },
        ],
      },
    });

    fireEvent.click(button('Удалить шаг 1'));
    expect(screen.queryByLabelText('Пауза шага 2')).toBeNull();
  });

  it('DCA: сумма пауз больше 5 мин → ошибка', () => {
    render(<TradingConfig value={{ exitStrategy: 'dca', dcaIntervals: [{ time: 10_000, percent: 100 }] }} {...handlers()} />);

    change(field('Пауза шага 1'), '301');

    expect(screen.getByRole('alert').textContent).toMatch(/больше лимита 300/);
    expect(button('Применить').disabled).toBe(true);
  });
});

describe('общее поведение', () => {
  it('busy блокирует поля и кнопки', () => {
    render(<PriorityFeeConfig value={1} {...handlers()} busy />);

    expect(field('Цена, µlamports за CU').disabled).toBe(true);
    expect(button('Сохранение…').disabled).toBe(true);
  });

  it('новое value с тем же содержимым не стирает ввод, другое — сбрасывает форму', () => {
    const h = handlers();
    const { rerender } = render(<RetryConfig value={{ maxRetries: 3, tipIncreasePercent: 20, blockhashRefresh: true, regionFallback: false }} {...h} />);

    change(field('Всего попыток'), '5');
    rerender(<RetryConfig value={{ maxRetries: 3, tipIncreasePercent: 20, blockhashRefresh: true, regionFallback: false }} {...h} />);
    expect(field('Всего попыток').value).toBe('5');

    rerender(<RetryConfig value={{ maxRetries: 4, tipIncreasePercent: 20, blockhashRefresh: true, regionFallback: false }} {...h} />);
    expect(field('Всего попыток').value).toBe('4');
    expect(button('Применить').disabled).toBe(true);
  });
});
