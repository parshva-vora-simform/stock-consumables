import { queryKeys } from '../../api/queryKeys.js';
import { API, APP_ROUTE } from '@stock/shared';
import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { LowStockRow, LowStockSortField, Paged } from '@stock/shared';
import { get } from '../../api/client.js';
import { useCurrentUser } from '../../auth/AuthProvider.js';
import {
  Input,
  Select,
  Control,
  Badge,
  StockLevelBar,
  PageHeader,
  ErrorBanner,
  TableSkeleton,
} from '../../components/ui.js';
import { SearchIcon } from '../../components/icons.js';
import {
  SortableHeader,
  TableShell,
  TableHead,
  Th,
  Tr,
  Td,
  FilterBar,
  Pagination,
  EmptyRow,
  useDebounced,
  type SortState,
} from '../../components/table.js';

/**
 * UI-7. The threshold comparison, the scoping, the search and the ordering all
 * happen in SQL against the balance table (FR-7.2) — a few hundred rows, never
 * the ledger. Nothing here filters a list of "all items".
 */
export function LowStockPage() {
  const user = useCurrentUser();
  const [locationId, setLocationId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState<LowStockSortField>>({
    sortBy: 'headroom',
    sortOrder: 'asc',
  });

  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounced(search);

  const query = useQuery({
    queryKey: queryKeys.lowStock.list({ locationId, debouncedSearch, ...sort }, page),
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: '10',
        sortBy: sort.sortBy,
        sortOrder: sort.sortOrder,
      });
      if (locationId) params.set('locationId', locationId);
      if (debouncedSearch) params.set('search', debouncedSearch);
      return get<Paged<LowStockRow>>(`${API.items.lowStock()}?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];

  /** Changing what is asked for invalidates which page you were on. */
  function reset<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  return (
    <div>
      <PageHeader
        title="Low stock"
        description="Every item at or below its minimum threshold, worst shortfall first."
      />

      <FilterBar>
        <div className="w-full sm:w-64">
          <Control label="Search">
            <div className="relative">
              <SearchIcon
                size={15}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <Input
                placeholder="Name or SKU…"
                value={search}
                onChange={(e) => reset(setSearch)(e.target.value)}
                className="pl-8"
              />
            </div>
          </Control>
        </div>
        <div className="w-52">
          <Control label="Location">
            <Select value={locationId} onChange={(e) => reset(setLocationId)(e.target.value)}>
              <option value="">All my locations</option>
              {user.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
            </Select>
          </Control>
        </div>
      </FilterBar>

      {query.isError && <ErrorBanner>{(query.error as Error).message}</ErrorBanner>}
      <TableShell>
            <TableHead>
              <SortableHeader field="name" sort={sort} onSort={reset(setSort)}>
                Item
              </SortableHeader>
              <SortableHeader field="locationCode" sort={sort} onSort={reset(setSort)}>
                Location
              </SortableHeader>
              <SortableHeader field="quantity" sort={sort} onSort={reset(setSort)} align="right">
                On hand
              </SortableHeader>
              <Th>Level</Th>
              <Th align="right">Threshold</Th>
              <SortableHeader field="headroom" sort={sort} onSort={reset(setSort)} align="right">
                Short by
              </SortableHeader>
            </TableHead>

            {query.isPending ? (
              <TableSkeleton rows={10} cols={6} />
            ) : (
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 && (
                <EmptyRow colSpan={6}>
                  Nothing is below its threshold right now.
                </EmptyRow>
              )}
              {rows.map((r) => (
                <Tr key={`${r.itemId}-${r.locationId}`}>
                  <Td className="min-w-[13rem]">
                    <Link
                      to={APP_ROUTE.itemDetail(r.itemId)}
                      className="font-medium text-slate-900 hover:text-slate-600 hover:underline"
                    >
                      {r.name}
                    </Link>
                    <p className="whitespace-nowrap font-mono text-xs text-slate-500">{r.sku}</p>
                  </Td>
                  <Td>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
                      {r.locationCode}
                    </span>
                  </Td>
                  <Td align="right" numeric className="font-semibold text-slate-900">
                    {r.quantity.toLocaleString()}
                  </Td>
                  <Td className="w-32">
                    <StockLevelBar quantity={r.quantity} threshold={r.minThreshold} />
                  </Td>
                  <Td align="right" numeric className="text-slate-500">
                    {r.minThreshold.toLocaleString()}
                  </Td>
                  <Td align="right">
                    <Badge tone={r.quantity === 0 ? 'danger' : 'warn'}>
                      {r.quantity === 0 ? 'out of stock' : `${Math.abs(r.headroom)} short`}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
            )}
      </TableShell>

          <Pagination
            page={query.data?.page ?? 1}
            totalPages={query.data?.totalPages ?? 1}
            total={query.data?.total ?? 0}
            totalIsExact={query.data?.totalIsExact ?? true}
            hasNext={query.data?.hasNext ?? false}
            pageSize={query.data?.pageSize ?? 10}
            rowsOnPage={rows.length}
            isLoading={query.isFetching}
            onPage={setPage}
          />
    </div>
  );
}
