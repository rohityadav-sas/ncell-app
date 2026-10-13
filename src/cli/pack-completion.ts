import { stripVTControlCharacters } from 'node:util';
export const PACK_CACHE_TTL = 5 * 60_000;
export interface CatalogPack {
  id: string;
  description: string;
  categories: number[];
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const clean = (value: unknown): string =>
  stripVTControlCharacters(String(value ?? ''))
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();

/** Account-scoped in-memory catalog; failures never become a partial cached catalog. */
export class PackCatalog {
  items: CatalogPack[] | undefined;
  error: string | undefined;
  progress: { completed: number; total: number } | undefined;
  #expires = 0;
  #retryAfter = 0;
  #generation = 0;
  #pending: Promise<CatalogPack[]> | undefined;
  constructor(
    readonly categories: () => Promise<unknown>,
    readonly plans: (category: number) => Promise<unknown>,
    readonly changed: () => void,
    readonly now = Date.now,
  ) {}
  invalidate(): void {
    this.#generation++;
    this.items = undefined;
    this.error = undefined;
    this.progress = undefined;
    this.#pending = undefined;
    this.#expires = 0;
    this.#retryAfter = 0;
  }
  peek(): CatalogPack[] | undefined {
    if (this.items && this.now() >= this.#expires) {
      this.items = undefined;
      this.#expires = 0;
    }
    return this.items;
  }
  load(): Promise<CatalogPack[]> {
    const cached = this.peek();
    if (cached) return Promise.resolve(cached);
    if (this.#pending) return this.#pending;
    if (this.error && this.now() < this.#retryAfter) return Promise.reject(new Error(this.error));
    const generation = this.#generation;
    const pending = (async () => {
      const raw = object(await this.categories());
      if (!Array.isArray(raw.tags)) throw new Error('Invalid category response');
      const tags = raw.tags
        .map(object)
        .filter(
          (tag) =>
            Array.isArray(tag.categories) &&
            tag.categories.some((value) =>
              ['GSM_DATA', 'GSM_VOICE', 'GSM_SMS'].includes(String(object(value).name)),
            ),
        );
      const categories = tags.map((tag) => {
        const category = Number(tag.id);
        if (!Number.isSafeInteger(category) || category < 0) throw new Error('Invalid category ID');
        return category;
      });
      if (generation === this.#generation) {
        this.progress = { completed: 0, total: categories.length };
        this.changed();
      }
      let completed = 0;
      const results = await Promise.all(
        categories.map(async (category) => {
          const response = object(await this.plans(category));
          if (!Array.isArray(response.availablePackages)) throw new Error('Invalid plans response');
          completed++;
          if (generation === this.#generation && !this.error) {
            this.progress = { completed, total: categories.length };
            this.changed();
          }
          return { category, availablePackages: response.availablePackages };
        }),
      );
      if (generation !== this.#generation) throw new Error('Catalog changed');
      const packs = new Map<string, CatalogPack>();
      for (const { category, availablePackages } of results) {
        for (const value of availablePackages) {
          const pack = object(value),
            id = String(pack.id ?? '');
          if (!/^\d+$/.test(id)) throw new Error('Invalid pack ID');
          const existing = packs.get(id);
          if (existing) {
            if (!existing.categories.includes(category)) existing.categories.push(category);
            continue;
          }
          const name = clean(
            object(pack.displayInfo).displayName || pack.ncellName || pack.productName || 'Pack',
          );
          const price = clean(object(pack.productOfferingPrice).price).replace(/\.00$/, '');
          packs.set(id, {
            id,
            description: name + (price ? ` · Rs. ${price}` : ''),
            categories: [category],
          });
        }
      }
      const result = [...packs.values()].sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true }),
      );
      if (generation === this.#generation) {
        this.items = result;
        this.error = undefined;
        this.progress = undefined;
        this.#expires = this.now() + PACK_CACHE_TTL;
        this.changed();
      }
      return result;
    })()
      .catch(() => {
        const message = 'Could not load packs; press Ctrl+Space to retry';
        if (generation === this.#generation) {
          this.error = message;
          this.progress = undefined;
          this.#retryAfter = this.now() + 10_000;
          this.changed();
        }
        throw new Error(message);
      })
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined;
      });
    this.#pending = pending;
    return pending;
  }
}
