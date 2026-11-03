// In-memory stand-in for the db adapter in js/projects/db.js: same run(names, mode, fn) contract, transactions are
// atomic (changes are applied only if fn resolves) and a write budget can simulate a full disk.
import { STORES } from '../../js/projects/schema.js';
import { StorageFullError } from '../../js/projects/db.js';

export function createFakeDb({ budget = Infinity } = {}) {
  const state = Object.fromEntries(Object.values(STORES).map((s) => [s, new Map()]));
  let writes = 0;
  const keyOf = (s, v) => (s === STORES.projects ? v.id : v.key);
  const clone = (st) => Object.fromEntries(Object.entries(st).map(([k, m]) => [k, new Map(m)]));
  return {
    state,
    setBudget(n) { budget = n; writes = 0; },
    async run(names, mode, fn) {
      const work = clone(state);
      const api = {
        get: async (s, k) => work[s].get(k),
        put: async (s, v) => { if (mode !== 'readwrite') throw new Error('read-only'); writes += 1; if (writes > budget) throw new StorageFullError(); work[s].set(keyOf(s, v), v); },
        delete: async (s, k) => { work[s].delete(k); },
        getAll: async (s) => [...work[s].values()],
        getAllKeys: async (s) => [...work[s].keys()],
        getAllByIndex: async (s, idx, v) => [...work[s].values()].filter((x) => x[idx] === v),
        clear: async (s) => { work[s].clear(); },
      };
      const out = await fn(api);
      if (mode === 'readwrite') for (const s of Object.keys(state)) state[s] = work[s];
      return out;
    },
    close() {},
  };
}
