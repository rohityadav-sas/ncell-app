import { NcellError } from './core/index.js';

export interface PlanOptions {
  category?: number;
  keyword?: string;
  /** Ordered fields: price or validity, optionally followed by :asc or :desc. */
  sort?: string;
}

export function parseSort(
  value = 'price',
): Array<{ field: 'price' | 'validity'; descending: boolean }> {
  return value.split(',').map((part) => {
    const [field, direction = 'asc', extra] = part.split(':');
    if (
      (field !== 'price' && field !== 'validity') ||
      !['asc', 'desc'].includes(direction) ||
      extra !== undefined
    ) {
      throw new NcellError(
        'Sort fields must be price or validity, optionally followed by :asc or :desc',
      );
    }
    return { field, descending: direction === 'desc' };
  });
}

/** Stable sorting without changing the response or its original packages array. */
export function sortPlans(
  response: Record<string, unknown>,
  sort = 'price',
): Record<string, unknown> {
  const fields = parseSort(sort);
  if (!Array.isArray(response.availablePackages))
    throw new NcellError('Ncell returned invalid plans', { code: 'INVALID_RESPONSE' });
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const number = (value: unknown): number => {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return Infinity;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Infinity;
  };
  const key = (plan: unknown, field: string): number => {
    const value = record(plan);
    if (field === 'price') return number(record(value.productOfferingPrice).price);
    const tech = record(value.techInfo);
    const multiplier: Record<string, number> = { MINUTE: 1, HOUR: 60, DAY: 1440, WEEK: 10080 };
    return number(tech.validity) * (multiplier[String(tech.validityUom)] ?? Infinity);
  };
  return {
    ...response,
    availablePackages: [...response.availablePackages].sort((a, b) => {
      for (const { field, descending } of fields) {
        const av = key(a, field),
          bv = key(b, field);
        if (av !== bv) return (av < bv ? -1 : 1) * (descending ? -1 : 1);
      }
      return 0;
    }),
  };
}
