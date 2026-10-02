/**
 * Canonical serialisation for exact regression hashing (D2): object keys sorted, values
 * retained exactly, undefined omitted. Derived routes/visual bounds are never part of
 * canonical documents, so no exclusion list is needed here.
 */
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`non-finite number in canonical value: ${value}`);
  return value;
}

/** Fast structural deep clone for plain JSON values. */
export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

const cache = new WeakMap<object, string>();
/** Memoised canonical form for committed (never-mutated) objects. */
export function canonicalOf(value: object): string {
  let s = cache.get(value);
  if (s === undefined) {
    s = canonicalSerialize(value);
    cache.set(value, s);
  }
  return s;
}
