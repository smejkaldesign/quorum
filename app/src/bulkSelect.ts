// The bulk bar's selection in Notifications and Memory health. The list shows a page of rows; picked holds the ids
// ticked on it. across is on after Select all: every row that matches the tab and filters counts as selected,
// including the rows not loaded yet, and total is how many that is
export type BulkSel = { picked: Set<string>; across: boolean };

export const NO_SELECTION: BulkSel = { picked: new Set(), across: false };

export type BulkView = {
  // the header checkbox is ticked
  pageOn: boolean;
  // how many items the bulk actions act on
  count: number;
  // the text left of the actions: "Select 50" with nothing picked, then "50 selected"
  text: string;
  // the header checkbox's label
  checkLabel: string;
  // Select all shows once the whole page is picked and more items match than the page holds
  offerAll: boolean;
  allLabel: string;
};

export function bulkView(pageIds: string[], sel: BulkSel, total: number): BulkView {
  const pageOn = sel.across || (pageIds.length > 0 && pageIds.every((id) => sel.picked.has(id)));
  const count = sel.across ? Math.max(total, pageIds.length) : pageIds.filter((id) => sel.picked.has(id)).length;
  return {
    pageOn,
    count,
    text: count ? `${count} selected` : `Select ${pageIds.length}`,
    checkLabel: `Select ${pageIds.length}`,
    offerAll: pageOn && total > pageIds.length,
    allLabel: `Select all ${total}`,
  };
}

// the header checkbox: picks every row on the page, or clears the selection when the page (or everything) is picked
export function togglePage(pageIds: string[], sel: BulkSel): BulkSel {
  const on = sel.across || (pageIds.length > 0 && pageIds.every((id) => sel.picked.has(id)));
  return on ? NO_SELECTION : { picked: new Set(pageIds), across: false };
}

// Select all: on, every matching item; pressed again, back to the rows on this page
export function toggleAcross(pageIds: string[], sel: BulkSel): BulkSel {
  return sel.across ? { picked: new Set(pageIds), across: false } : { picked: new Set(pageIds), across: true };
}

// one row's checkbox. Unticking a row while everything is selected drops back to the page, less that row
export function toggleOne(id: string, sel: BulkSel, pageIds: string[]): BulkSel {
  const picked = new Set(sel.across ? pageIds : sel.picked);
  if (picked.has(id)) picked.delete(id); else picked.add(id);
  return { picked, across: false };
}

// a reload keeps the picks still on the page; across stays on, since it covers rows whatever page they sit on
export function keepOnPage(sel: BulkSel, pageIds: string[]): BulkSel {
  const on = new Set(pageIds);
  const picked = new Set([...sel.picked].filter((id) => on.has(id)));
  return picked.size === sel.picked.size ? sel : { picked, across: sel.across };
}

// the ids the bulk actions act on: every matching id when across is on, else the picks on the page
export function selectedIds(sel: BulkSel, pageIds: string[], allIds: string[]): string[] {
  return sel.across ? allIds : pageIds.filter((id) => sel.picked.has(id));
}
