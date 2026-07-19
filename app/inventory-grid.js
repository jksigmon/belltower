// inventory-grid.js
// Shared checkout grid renderer used by both the staff "My Lists" view
// (app/staff.html) and the admin oversight view (app/admin.inventory.js) —
// one implementation so viewing/editing a list behaves identically no
// matter which context opened it.
import { esc } from './admin.shared.js';

export function keyOf(studentId, itemId) {
  return studentId + '::' + itemId;
}

export function buildAssignmentMap(assignments) {
  const map = {};
  (assignments || []).forEach(a => { map[keyOf(a.student_id, a.item_id)] = a; });
  return map;
}

const STATUS_CYCLE = ['not_assigned', 'checked_out', 'returned'];
const STATUS_LABEL = { not_assigned: 'Not Assigned', checked_out: 'Checked Out', returned: 'Returned' };
const STATUS_CLASS = { not_assigned: 'inv-status--none', checked_out: 'inv-status--out', returned: 'inv-status--returned' };

export function nextStatus(status) {
  const idx = STATUS_CYCLE.indexOf(status);
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
}

export function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

/**
 * Updates a single status button in place after a save succeeds, instead
 * of re-rendering the whole grid. Re-rendering the whole table on every
 * edit was destroying and recreating every input/button — which stole
 * focus out from under whatever the teacher clicked or typed next (the
 * "have to click twice" / "characters disappear" bug).
 */
export function updateCellStatus(container, studentId, itemId, status) {
  if (!container) return;
  const btn = container.querySelector(
    `.inv-status-btn[data-student="${studentId}"][data-item="${itemId}"]`
  );
  if (!btn) return;
  btn.className = `inv-status-btn ${STATUS_CLASS[status]}`;
  btn.dataset.status = status;
  btn.textContent = statusLabel(status);
}

/**
 * Renders the student x item checkout grid into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {Array}  opts.students        [{ id, first_name, last_name }]
 * @param {Array}  opts.items           [{ id, label }] in display order
 * @param {object} opts.assignmentMap   keyOf(studentId,itemId) -> assignment row
 * @param {boolean} opts.canEdit
 * @param {(studentId, itemId, value) => void} opts.onIdentifierChange
 * @param {(studentId, itemId, currentStatus) => void} opts.onStatusCycle
 * @param {(itemId, status) => void} opts.onBulkAction
 */
export function renderInventoryGrid(container, { students, items, assignmentMap, canEdit, onIdentifierChange, onStatusCycle, onBulkAction }) {
  if (!container) return;

  if (!students.length) {
    container.innerHTML = '<p class="muted" style="padding:16px 0;">No students on this list yet. Add students to get started.</p>';
    return;
  }
  if (!items.length) {
    container.innerHTML = '<p class="muted" style="padding:16px 0;">No items on this list yet. Add an item (e.g. "Skills Book") to start tracking checkouts.</p>';
    return;
  }

  const header = `
    <tr>
      <th style="text-align:left;min-width:150px;">Student</th>
      ${items.map(it => `
        <th style="min-width:150px;text-align:left;">
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
            <span>${esc(it.label)}</span>
            ${canEdit ? `
              <div style="display:flex;gap:4px;">
                <button type="button" class="btn btn-sm inv-bulk-out" data-item="${esc(it.id)}" title="Check out all">Out all</button>
                <button type="button" class="btn btn-sm inv-bulk-return" data-item="${esc(it.id)}" title="Mark all returned">Return all</button>
              </div>
            ` : ''}
          </div>
        </th>
      `).join('')}
    </tr>
  `;

  const rows = students.map(s => `
    <tr>
      <td style="font-weight:600;white-space:nowrap;text-align:left;">${esc(s.last_name)}, ${esc(s.first_name)}</td>
      ${items.map(it => {
        const a = assignmentMap[keyOf(s.id, it.id)];
        const status = a?.status || 'not_assigned';
        const identifier = a?.identifier || '';
        return `
          <td style="text-align:left;">
            <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
              <input class="form-input inv-identifier-input" data-student="${esc(s.id)}" data-item="${esc(it.id)}"
                     value="${esc(identifier)}" placeholder="ID / #" ${canEdit ? '' : 'disabled'}
                     style="text-align:left;padding:4px 6px;font-size:12px;width:100px;" />
              <button type="button" class="inv-status-btn ${STATUS_CLASS[status]}" data-student="${esc(s.id)}" data-item="${esc(it.id)}" data-status="${esc(status)}" ${canEdit ? '' : 'disabled'}>
                ${statusLabel(status)}
              </button>
            </div>
          </td>
        `;
      }).join('')}
    </tr>
  `).join('');

  container.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="admin-table inv-grid-table">
        <thead>${header}</thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  if (!canEdit) return;

  container.querySelectorAll('.inv-identifier-input').forEach(input => {
    input.addEventListener('change', () => {
      onIdentifierChange(input.dataset.student, input.dataset.item, input.value.trim());
    });
  });

  container.querySelectorAll('.inv-status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      onStatusCycle(btn.dataset.student, btn.dataset.item, btn.dataset.status);
    });
  });

  container.querySelectorAll('.inv-bulk-out').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Check out this item for every student on the list?')) onBulkAction(btn.dataset.item, 'checked_out');
    });
  });
  container.querySelectorAll('.inv-bulk-return').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Mark this item returned for every student on the list?')) onBulkAction(btn.dataset.item, 'returned');
    });
  });
}
