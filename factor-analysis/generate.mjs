import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const modules = ['portfolio', 'csv', 'calculator'].map((name) =>
  readFileSync(new URL('./src/' + name + '.js', import.meta.url), 'utf8'));
const { Portfolio, Calculator } = vm.runInNewContext(
  modules.join('\n') + '\n({ Portfolio, Calculator })',
);

function snapshotDates(lastDate, count) {
  const last = new Date(lastDate + 'T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    if (index === count - 1) return lastDate;
    const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - count + index + 2, 0));
    while (end.getUTCDay() === 0 || end.getUTCDay() === 6) end.setUTCDate(end.getUTCDate() - 1);
    return end.toISOString().slice(0, 10);
  });
}

try {
  const settings = JSON.parse(readFileSync(0, 'utf8'));
  const { periods, monthly, valuationDate, liabilityShare = 0 } = settings;
  if (!Number.isInteger(periods) || periods < 4 || periods > 12 ||
      !Number.isInteger(monthly) || monthly < 0 || monthly > 250 ||
      !Portfolio.isDate(valuationDate) || valuationDate < '2020-01-01') {
    throw new Error('Укажите конец истории, от 4 до 12 периодов и от 0 до 250 новых сделок в месяц.');
  }
  if (!Number.isFinite(liabilityShare) || liabilityShare < 0 || liabilityShare > 100) {
    throw new Error('Доля обязательств должна быть от 0 до 100%.');
  }
  const validated = Portfolio.validate({ ...Portfolio.defaults, ...settings });
  if (!validated.valid) throw new Error(Object.values(validated.errors).join(' '));
  const base = validated.settings;
  if (base.count < 20 || base.count + (periods - 1) * monthly > 1500) {
    throw new Error('Начните минимум с 20 сделок. Новый и исходный портфели вместе могут содержать до 1 500 сделок.');
  }
  let ordinal = 0;
  const batches = snapshotDates(valuationDate, periods).map((date, index) => {
    const count = index === 0 ? base.count : monthly;
    const deals = count ? Portfolio.generate({
      ...base, count, valuationDate: date, seed: index === 0 ? base.seed : base.seed.slice(0, 53) + '-' + date,
    }).deals : [];
    for (const deal of deals) {
      deal.id = 'SYN-' + String(++ordinal).padStart(5, '0');
      // Independent deterministic split keeps the same unsigned contracts when changing sides.
      const draw = (Math.imul(ordinal, 2654435761) >>> 0) / (2 ** 32);
      deal.side = draw * 100 < liabilityShare ? 'LIABILITY' : 'ASSET';
    }
    return { date, newDeals: Calculator.exportInput(deals) };
  });
  process.stdout.write(JSON.stringify({ batches, uniqueDeals: ordinal, settings: { ...base, liabilityShare } }));
} catch (cause) {
  process.stderr.write(cause.message);
  process.exitCode = 1;
}
