import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUpIcon,
  ArrowDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from './icons.js';

/**
 * Table furniture shared by every list in the app.
 *
 * All of it drives SERVER-side behaviour: a sortable header changes a query
 * parameter, it never reorders rows already on screen. Sorting a page you have
 * is not sorting the data — it silently answers a different question, and the
 * answer is wrong the moment there is more than one page.
 */

export type SortState<F extends string> = { sortBy: F; sortOrder: 'asc' | 'desc' };

export function SortableHeader<F extends string>({
  field,
  sort,
  onSort,
  align = 'left',
  children,
}: {
  field: F;
  sort: SortState<F>;
  onSort: (next: SortState<F>) => void;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  const active = sort.sortBy === field;

  return (
    <th
      className={`whitespace-nowrap px-4 py-2.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
      aria-sort={active ? (sort.sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() =>
          onSort({
            sortBy: field,
            // Clicking the active column flips it; a new column starts ascending.
            sortOrder: active && sort.sortOrder === 'asc' ? 'desc' : 'asc',
          })
        }
        className={`group inline-flex items-center gap-1 rounded transition-colors hover:text-slate-900 ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${active ? 'text-slate-900' : 'text-slate-500'}`}
      >
        {children}
        {/* The inactive arrow stays in the layout rather than disappearing, so
            the column does not shift by a few pixels when it becomes sorted. */}
        <span
          className={`transition-opacity ${
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
          }`}
        >
          {active && sort.sortOrder === 'desc' ? (
            <ArrowDownIcon size={12} />
          ) : (
            <ArrowUpIcon size={12} />
          )}
        </span>
      </button>
    </th>
  );
}

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
      {/* A min-width plus horizontal scroll, rather than letting columns crush
          each other. Below this width, names and SKUs start wrapping to three
          lines each and row heights go everywhere — a table you have to swipe
          reads better than one that has collapsed into itself. */}
      <table className="w-full min-w-[880px] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-slate-50/95 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500 backdrop-blur">
      <tr className="border-b border-slate-200">{children}</tr>
    </thead>
  );
}

/** A non-sortable header cell, matching the sortable ones' metrics. */
export function Th({
  align = 'left',
  children,
}: {
  align?: 'left' | 'right';
  children?: ReactNode;
}) {
  return (
    <th
      className={`whitespace-nowrap px-4 py-2.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  );
}

/** Standard row: hover affordance, and a muted treatment for inactive rows. */
export function Tr({
  muted,
  children,
}: {
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <tr className={`transition-colors ${muted ? 'bg-slate-50/60 text-slate-400' : 'hover:bg-slate-50'}`}>
      {children}
    </tr>
  );
}

export function Td({
  align = 'left',
  numeric,
  className = '',
  children,
}: {
  align?: 'left' | 'right';
  numeric?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <td
      className={`px-4 py-3 ${align === 'right' ? 'text-right' : ''} ${numeric ? 'tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * Numbered pages, with Prev/Next and a windowed strip.
 *
 * The window matters: a table with 400 pages must not render 400 buttons. It
 * shows the first page, the last, and a few either side of the current one,
 * with ellipses across the gaps — so the strip is a fixed width whatever the
 * total is.
 *
 * `totalIsExact` is false once the result set passes the server's count cap.
 * The total then reads "1,000+" and the last-page button is withheld, because
 * we genuinely do not know where the end is — claiming a page number we have
 * not counted to would be a guess presented as a fact.
 */
export function Pagination({
  page,
  totalPages,
  total,
  totalIsExact,
  pageSize,
  rowsOnPage,
  hasNext,
  isLoading,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  totalIsExact: boolean;
  pageSize: number;
  rowsOnPage: number;
  /** The server's answer, from its `limit + 1` probe row. */
  hasNext: boolean;
  isLoading: boolean;
  onPage: (page: number) => void;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = (page - 1) * pageSize + rowsOnPage;
  // Taken from the response, not re-derived here. `rowsOnPage === pageSize` is
  // the same guess the server used to make, and it is wrong for exactly the
  // same reason: a final page that happens to be full.
  const canGoNext = hasNext;

  return (
    <nav
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
      aria-label="Pagination"
    >
      <p className="text-xs text-slate-500">
        {total === 0 ? (
          'No rows'
        ) : (
          <>
            Showing <strong className="text-slate-700">{first}</strong>–
            <strong className="text-slate-700">{last}</strong> of{' '}
            <strong className="text-slate-700">
              {total.toLocaleString()}
              {totalIsExact ? '' : '+'}
            </strong>
          </>
        )}
      </p>

      <div className="flex items-center gap-1">
        <PageButton
          disabled={page <= 1 || isLoading}
          onClick={() => onPage(page - 1)}
          label="Previous page"
        >
          <ChevronLeftIcon size={14} />
        </PageButton>

        {pageWindow(page, totalPages).map((entry, index) =>
          entry === 'gap' ? (
            <span key={`gap-${index}`} className="px-1.5 text-xs text-slate-400">
              …
            </span>
          ) : (
            <PageButton
              key={entry}
              active={entry === page}
              disabled={isLoading}
              onClick={() => onPage(entry)}
            >
              {entry}
            </PageButton>
          ),
        )}

        {!totalIsExact && <span className="px-1.5 text-xs text-slate-400">…</span>}

        <PageButton
          disabled={!canGoNext || isLoading}
          onClick={() => onPage(page + 1)}
          label="Next page"
        >
          <ChevronRightIcon size={14} />
        </PageButton>
      </div>
    </nav>
  );
}

function PageButton({
  children,
  active,
  disabled,
  onClick,
  label,
}: {
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** Required for the arrow buttons, whose glyph carries no text. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-md px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-slate-900 text-white'
          : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The page numbers to render: always the first and last, always a couple either
 * side of the current page, ellipses for the rest.
 */
function pageWindow(page: number, totalPages: number): (number | 'gap')[] {
  const SPREAD = 1;
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set<number>([1, totalPages, page]);
  for (let i = 1; i <= SPREAD; i++) {
    if (page - i > 1) pages.add(page - i);
    if (page + i < totalPages) pages.add(page + i);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];

  sorted.forEach((n, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && n - prev > 1) out.push('gap');
    out.push(n);
  });

  return out;
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-14 text-center text-sm text-slate-500">
        {children}
      </td>
    </tr>
  );
}

/**
 * A filter bar. Wraps on narrow screens rather than overflowing, and keeps
 * every control on one baseline.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-card">
      {children}
    </div>
  );
}

/**
 * Debounces a search box, so each keystroke is not its own round trip. The
 * search itself still runs on the server — this only controls how often it is
 * asked.
 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
