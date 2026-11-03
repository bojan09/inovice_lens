// issues.js - "N items to review" banner with the full list. Clicking an issue goes to the value.
import { el, icon } from '../dom.js';
import { reviewCount } from '../../doc/validate.js';

const SEV = { error: 'Error', warning: 'Check', info: 'Note' };

export function createIssues({ actions }) {
  const text = el('span', { class: 'rv-text' });
  const toggle = el('button', { type: 'button', class: 'rv-toggle', 'aria-expanded': 'false', 'aria-controls': 'ed-issue-list' }, icon('alert', 'rv-icon'), text, icon('chevron-down', 'chev'));
  const review = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Review');
  const list = el('ul', { class: 'rv-list', id: 'ed-issue-list', hidden: true });
  const node = el('div', { class: 'review', 'data-level': 'none' }, el('div', { class: 'rv-bar' }, toggle, review), list);
  let issues = [];
  let cursor = -1;
  let sig = '';

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
  });
  review.addEventListener('click', () => {
    const actionable = issues.filter((i) => i.severity !== 'info');
    if (!actionable.length) return;
    cursor = (cursor + 1) % actionable.length;
    actions.goto(actionable[cursor].target);
  });

  return {
    node,
    update({ issues: next }) {
      issues = next;
      const n = reviewCount(next);
      const errors = next.filter((i) => i.severity === 'error').length;
      node.dataset.level = errors ? 'error' : n ? 'warning' : 'ok';
      text.textContent = n ? `${n} ${n === 1 ? 'item' : 'items'} to review${errors ? ` (${errors} ${errors === 1 ? 'error' : 'errors'})` : ''}`
        : next.length ? 'No problems found by the checks' : 'No problems found by the checks';
      review.hidden = n === 0;
      const s = next.map((i) => i.id + i.message).join('\n');
      if (s !== sig) {
        sig = s;
        cursor = -1;
        list.replaceChildren(...next.map((i) => el('li', {}, el('button', { type: 'button', class: `rv-item rv-${i.severity}`, onclick: () => actions.goto(i.target) },
          el('span', { class: 'rv-sev' }, SEV[i.severity]), el('span', {}, i.message)))));
        if (!next.length) list.replaceChildren(el('li', { class: 'rv-none' }, 'Totals, dates, currency and required fields were checked. This does not prove the values match the original: compare important numbers yourself.'));
      }
    },
  };
}
