// states.js - recognition state machine. Illegal transitions throw, so UI/session bugs surface in tests.
//
//   queued -> preparing -> extracting -> recognized | review | failed
//   any non-terminal -> cancelled | failed
//   terminal (recognized, review, failed, cancelled) -> queued   (retry / rotate / re-run)

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  PREPARING: 'preparing',
  EXTRACTING: 'extracting',
  RECOGNIZED: 'recognized',
  REVIEW: 'review',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const NEXT = {
  queued: ['preparing', 'cancelled'],
  preparing: ['extracting', 'failed', 'cancelled'],
  extracting: ['recognized', 'review', 'failed', 'cancelled'],
  recognized: ['queued'],
  review: ['queued'],
  failed: ['queued'],
  cancelled: ['queued'],
};

export const TERMINAL = Object.freeze(['recognized', 'review', 'failed', 'cancelled']);
export const ACTIVE = Object.freeze(['preparing', 'extracting']);

export const isTerminal = (s) => TERMINAL.includes(s);
export const isActive = (s) => ACTIVE.includes(s);
export const canTransition = (from, to) => (NEXT[from] ?? []).includes(to);

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`Illegal recognition transition: ${from} -> ${to}`);
}
