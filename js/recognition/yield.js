// yield.js - cooperative time slicing for CPU-heavy loops that must stay on the main thread (canvas pixels).
// A slicer hands the thread back to the browser every ~`budgetMs` so input, painting and the progress UI are never starved
// by one long task. Results of sliced code are identical to the unsliced versions (asserted by unit tests).

export const yieldToMain = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));

export function createSlicer(budgetMs = 10, { now = () => performance.now(), yielder = yieldToMain } = {}) {
  let start = now();
  let yields = 0;
  return {
    /** await between units of work; yields only when the budget is spent. */
    async tick() {
      if (now() - start >= budgetMs) { yields += 1; await yielder(); start = now(); }
    },
    get yields() { return yields; },
  };
}

/** A slicer that never yields (tests, and callers that already run off the main thread). */
export const noSlicer = { async tick() {}, yields: 0 };
