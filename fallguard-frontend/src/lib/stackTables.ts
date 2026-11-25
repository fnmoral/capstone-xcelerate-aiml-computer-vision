import { useEffect } from 'react';

/**
 * Tables marked `table--stack` become one card per row on phones (ui.css): each cell shows its
 * column's name above its value. This copies the header names onto the cells (data-label), for
 * every such table on the page, also when rows are added or the page changes.
 */
export function useStackedTableLabels(): void {
  useEffect(() => {
    let frame = 0;
    const label = () => {
      frame = 0;
      for (const table of document.querySelectorAll<HTMLTableElement>('table.table--stack')) {
        const heads: string[] = [];
        for (const th of table.querySelectorAll<HTMLTableCellElement>('thead tr:first-child > th')) {
          for (let i = 0; i < (th.colSpan || 1); i++) heads.push(th.textContent?.trim() ?? '');
        }
        for (const row of table.querySelectorAll<HTMLTableRowElement>('tbody > tr')) {
          let col = 0;
          for (const cell of Array.from(row.cells)) {
            const name = cell.colSpan > 1 ? '' : heads[col] ?? '';
            if (name && cell.getAttribute('data-label') !== name) cell.setAttribute('data-label', name);
            if (!name && cell.hasAttribute('data-label')) cell.removeAttribute('data-label');
            col += cell.colSpan || 1;
          }
        }
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(label);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
}
