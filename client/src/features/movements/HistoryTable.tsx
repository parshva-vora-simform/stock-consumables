import { queryKeys } from '../../api/queryKeys.js';
import { API, DIRECTION, MOVEMENT_TYPE } from '@stock/shared';
import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { Movement, Paged } from '@stock/shared';
import { get, post, ApiRequestError } from '../../api/client.js';
import { useCurrentUser } from '../../auth/AuthProvider.js';
import {
  Badge,
  Select,
  Input,
  Control,
  DirectionChip,
  ErrorBanner,
  TableSkeleton,
  IconButton,
} from '../../components/ui.js';
import { UndoIcon, SearchIcon } from '../../components/icons.js';
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
import type { MovementSortField } from '@stock/shared';

type Filters = {
  locationId: string;
  direction: string;
  movementType: string;
  reference: string;
  from: string;
  to: string;
};

/**
 * UI-5. Cursor pagination throughout — the server returns `nextCursor` and
 * never a total, so this list costs the same at page 500 as at page 1.
 * Filters are pushed to the server, never applied to a fetched list.
 */
export function HistoryTable({ itemId }: { itemId: string }) {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>({
    locationId: '',
    direction: '',
    movementType: '',
    reference: '',
    from: '',
    to: '',
  });
  const [sort, setSort] = useState<SortState<MovementSortField>>({
    sortBy: 'occurredAt',
    sortOrder: 'desc',
  });
  const debouncedReference = useDebounced(filters.reference);
  const [page, setPage] = useState(1);
  const [reverseError, setReverseError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.movements.historyPage(itemId, { ...filters, reference: debouncedReference }, sort, page),
    queryFn: () => {
      // Every filter and the sort go to the server. At tens of thousands of
      // movements per item, narrowing in the browser would mean fetching them
      // all first — which is the failure mode FR-8.5 names explicitly.
      const params = new URLSearchParams({
        page: String(page),
        limit: '10',
        sortBy: sort.sortBy,
        sortOrder: sort.sortOrder,
      });
      if (filters.locationId) params.set('locationId', filters.locationId);
      if (filters.direction) params.set('direction', filters.direction);
      if (filters.movementType) params.set('movementType', filters.movementType);
      if (debouncedReference) params.set('reference', debouncedReference);
      if (filters.from) params.set('from', new Date(filters.from).toISOString());
      if (filters.to) params.set('to', new Date(filters.to).toISOString());
      return get<Paged<Movement>>(`${API.items.movements(itemId)}?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  async function reverse(movement: Movement) {
    const reason = window.prompt(
      `Reverse this ${movement.direction === DIRECTION.IN ? 'stock-in' : 'stock-out'} of ${movement.quantity}?\n\n` +
        'The original stays in the history — a reversing movement is appended.\n\nReason:',
    );
    if (!reason) return;

    setReverseError(null);
    try {
      await post(API.movements.reverse(movement.id), { reason });
      await queryClient.invalidateQueries({ queryKey: queryKeys.movements.history(itemId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.items.detail(itemId) });
    } catch (err) {
      setReverseError(
        err instanceof ApiRequestError ? err.message : 'Could not reverse that movement.',
      );
    }
  }

  const rows = query.data?.data ?? [];

  /** A new filter or sort means the old page number means nothing. */
  function reset<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  return (
    <div>
      <FilterBar>
        <div className="w-40">
          <Control label="Location">
            <Select
              value={filters.locationId}
              onChange={(e) => reset(setFilters)((f) => ({ ...f, locationId: e.target.value }))}
            >
              <option value="">All locations</option>
              {user.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code}
                </option>
              ))}
            </Select>
          </Control>
        </div>
        <div className="w-36">
          <Control label="Direction">
            <Select
              value={filters.direction}
              onChange={(e) => reset(setFilters)((f) => ({ ...f, direction: e.target.value }))}
            >
              <option value="">Both</option>
              <option value="IN">Stock in</option>
              <option value="OUT">Stock out</option>
            </Select>
          </Control>
        </div>
        <div className="w-40">
          <Control label="Type">
            <Select
              value={filters.movementType}
              onChange={(e) => reset(setFilters)((f) => ({ ...f, movementType: e.target.value }))}
            >
              <option value="">All types</option>
              <option value="NORMAL">Normal</option>
              <option value="REVERSAL">Reversals</option>
              <option value="STOCK_TAKE_ADJUSTMENT">Stock-take</option>
            </Select>
          </Control>
        </div>
        <div className="w-40">
          <Control label="Reference">
            <div className="relative">
              <SearchIcon
                size={15}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <Input
                placeholder="PO #4521"
                value={filters.reference}
                onChange={(e) => reset(setFilters)((f) => ({ ...f, reference: e.target.value }))}
                className="pl-8"
              />
            </div>
          </Control>
        </div>
        <div className="w-36">
          <Control label="From">
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => reset(setFilters)((f) => ({ ...f, from: e.target.value }))}
            />
          </Control>
        </div>
        <div className="w-36">
          <Control label="To">
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => reset(setFilters)((f) => ({ ...f, to: e.target.value }))}
            />
          </Control>
        </div>
      </FilterBar>

      {reverseError && (
        <div className="mb-4">
          <ErrorBanner>{reverseError}</ErrorBanner>
        </div>
      )}

      {query.isError && <ErrorBanner>{(query.error as Error).message}</ErrorBanner>}

      <TableShell>
            <TableHead>
              <SortableHeader field="occurredAt" sort={sort} onSort={reset(setSort)}>
                When
              </SortableHeader>
              <Th>Direction</Th>
              <SortableHeader field="quantity" sort={sort} onSort={reset(setSort)} align="right">
                Qty
              </SortableHeader>
              <Th>Location</Th>
              <Th>Recorded by</Th>
              <Th>Reference / note</Th>
              <Th />
            </TableHead>

            {query.isPending ? (
              <TableSkeleton rows={10} cols={7} />
            ) : (
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 && (
                <EmptyRow colSpan={7}>No movements match those filters.</EmptyRow>
              )}
              {rows.map((m) => {
                const isReversed = m.reversedByMovementId !== null;
                return (
                  <Tr key={m.id} muted={isReversed}>
                    <Td className="whitespace-nowrap">
                      <span className="tabular-nums">
                        {new Date(m.occurredAt).toLocaleDateString()}
                      </span>
                      <span className="ml-1.5 text-xs text-slate-400 tabular-nums">
                        {new Date(m.occurredAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </Td>
                    <Td>
                      <DirectionChip direction={m.direction} />
                      {m.movementType !== MOVEMENT_TYPE.NORMAL && (
                        <span className="ml-1.5 text-xs text-slate-500">
                          {m.movementType === MOVEMENT_TYPE.REVERSAL ? 'reversal' : 'stock-take'}
                        </span>
                      )}
                    </Td>
                    <Td
                      align="right"
                      numeric
                      className={
                        isReversed
                          ? 'line-through'
                          : m.signedQuantity > 0
                            ? 'font-semibold text-emerald-700'
                            : 'font-semibold text-amber-700'
                      }
                    >
                      {m.signedQuantity > 0 ? '+' : ''}
                      {m.signedQuantity.toLocaleString()}
                    </Td>
                    <Td>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
                        {m.locationCode}
                      </span>
                    </Td>
                    <Td className="text-slate-600">{m.recordedBy.name}</Td>
                    <Td className="max-w-[16rem]">
                      {m.reference && (
                        <span className="font-mono text-xs text-slate-700">{m.reference}</span>
                      )}
                      {m.note && (
                        <p className="truncate text-xs text-slate-500" title={m.note}>
                          {m.note}
                        </p>
                      )}
                      {isReversed && (
                        <Badge tone="danger">reversed</Badge>
                      )}
                    </Td>
                    <Td align="right">
                      {/* No edit, no delete: those routes do not exist and the
                          database refuses the write. Correction is a reversal. */}
                      {!isReversed && m.movementType === MOVEMENT_TYPE.NORMAL && (
                        <IconButton
                          label="Reverse this movement"
                          icon={<UndoIcon />}
                          onClick={() => reverse(m)}
                        />
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
            )}
      </TableShell>

      {!query.isPending && (
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
      )}
    </div>
  );
}
