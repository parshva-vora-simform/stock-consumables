import { queryKeys } from '../../api/queryKeys.js';
import { API, APP_ROUTE, ROLE } from '@stock/shared';
import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ItemSortField, ItemWithBalances, Paged, UnitOfMeasure } from '@stock/shared';
import { get } from '../../api/client.js';
import { useCurrentUser } from '../../auth/AuthProvider.js';
import {
  Input,
  Select,
  Control,
  Button,
  Badge,
  StockLevelBar,
  PageHeader,
  ErrorBanner,
  TableSkeleton,
  InfoNote,
  IconButton,
} from '../../components/ui.js';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  PowerOffIcon,
  RotateIcon,
  SearchIcon,
} from '../../components/icons.js';
import { Modal, ConfirmDialog } from '../../components/Modal.js';
import { ItemForm } from './ItemForm.js';
import { del, patch, ApiRequestError } from '../../api/client.js';
import {
  SortableHeader,
  TableShell,
  TableHead,
  Th,
  Tr,
  Td,
  Pagination,
  EmptyRow,
  FilterBar,
  useDebounced,
  type SortState,
} from '../../components/table.js';

const UNITS: UnitOfMeasure[] = ['EACH', 'KG', 'LITRE', 'METRE', 'BOX', 'PACK'];

/**
 * Every control on this page is a query parameter. Nothing is sorted or
 * filtered in the browser — with more than one page loaded, doing so would
 * quietly reorder a subset and present it as the answer.
 */
export function ItemsPage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const isManager = user.role === ROLE.MANAGER;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ItemWithBalances | null>(null);
  const [removing, setRemoving] = useState<ItemWithBalances | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [unit, setUnit] = useState('');
  const [locationId, setLocationId] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [sort, setSort] = useState<SortState<ItemSortField>>({
    sortBy: 'name',
    sortOrder: 'asc',
  });
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounced(search);
  const filters = { debouncedSearch, unit, locationId, lowStockOnly, ...sort };

  const query = useQuery({
    queryKey: queryKeys.items.list({ ...filters, isManager }, page),
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: '10',
        sortBy: sort.sortBy,
        sortOrder: sort.sortOrder,
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (unit) params.set('unitOfMeasure', unit);
      if (locationId) params.set('locationId', locationId);
      if (lowStockOnly) params.set('lowStockOnly', 'true');
      // Managers need to see deactivated items to reactivate them; handlers
      // have no use for something they cannot record against.
      if (isManager) params.set('includeInactive', 'true');
      return get<Paged<ItemWithBalances>>(`${API.items.list()}?${params}`);
    },
    // Keeps the previous page on screen while the next one loads, so the table
    // does not collapse to a spinner on every click.
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const activeFilters = [unit, locationId, debouncedSearch].filter(Boolean).length + (lowStockOnly ? 1 : 0);

  /** Any change to filters or sort invalidates the page number. */
  function reset<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  /**
   * Remove an item. The server deletes it only when no movement has ever
   * referenced it, and deactivates it otherwise — so the confirmation says
   * which will happen, and the result says which did.
   */
  async function confirmRemove() {
    if (!removing) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await del<{ deleted: boolean; movements: number }>(API.items.remove(removing.id));
      await queryClient.invalidateQueries({ queryKey: queryKeys.items.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.lowStock.all });
      setActionNote(
        res.deleted
          ? `${removing.name} was deleted.`
          : `${removing.name} has ${res.movements} movement${res.movements === 1 ? '' : 's'} in the ledger, so it was deactivated instead. Its history is intact.`,
      );
      setRemoving(null);
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err.message : 'Could not remove that item.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(item: ItemWithBalances) {
    setActionError(null);
    try {
      await patch(API.items.update(item.id), { isActive: !item.isActive });
      await queryClient.invalidateQueries({ queryKey: queryKeys.items.all });
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err.message : 'Could not change that item.',
      );
    }
  }

  function clearFilters() {
    setSearch('');
    setUnit('');
    setLocationId('');
    setLowStockOnly(false);
    setPage(1);
  }

  return (
    <div>
      <PageHeader
        title="Items"
        description="Stock is held per item per location. Open an item to record a movement."
        actions={
          isManager && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon size={15} /> Add item
            </Button>
          )
        }
      />

      {actionNote && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-card">
          {actionNote}
          <button
            onClick={() => setActionNote(null)}
            className="ml-2 text-xs text-slate-400 underline hover:text-slate-700"
          >
            dismiss
          </button>
        </div>
      )}

      {actionError && (
        <div className="mb-4">
          <ErrorBanner>{actionError}</ErrorBanner>
        </div>
      )}

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
        <div className="w-32">
          <Control label="Unit">
            <Select value={unit} onChange={(e) => reset(setUnit)(e.target.value)}>
              <option value="">Any</option>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Control>
        </div>
        <div className="w-44">
          <Control label="Location">
            <Select value={locationId} onChange={(e) => reset(setLocationId)(e.target.value)}>
              <option value="">All my locations</option>
              {user.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code}
                </option>
              ))}
            </Select>
          </Control>
        </div>
        <label className="flex cursor-pointer items-center gap-2 pb-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => reset(setLowStockOnly)(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-slate-900"
          />
          Low stock only
        </label>
        {activeFilters > 0 && (
          <button
            onClick={clearFilters}
            className="pb-2.5 text-xs font-medium text-slate-500 underline hover:text-slate-900"
          >
            Clear {activeFilters} filter{activeFilters > 1 ? 's' : ''}
          </button>
        )}
      </FilterBar>

      {query.isError && <ErrorBanner>{(query.error as Error).message}</ErrorBanner>}

      <TableShell>
        <TableHead>
          <SortableHeader field="name" sort={sort} onSort={reset(setSort)}>
            Item
          </SortableHeader>
          <SortableHeader field="sku" sort={sort} onSort={reset(setSort)}>
            SKU
          </SortableHeader>
          <Th>Unit</Th>
          <SortableHeader field="totalQuantity" sort={sort} onSort={reset(setSort)} align="right">
            On hand
          </SortableHeader>
          <Th>Level</Th>
          <SortableHeader field="minThreshold" sort={sort} onSort={reset(setSort)} align="right">
            Threshold
          </SortableHeader>
          <Th>Status</Th>
          {isManager && <Th align="right" />}
        </TableHead>

        {query.isPending ? (
          <TableSkeleton rows={10} cols={isManager ? 8 : 7} />
        ) : (
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <EmptyRow colSpan={isManager ? 8 : 7}>
                {activeFilters > 0
                  ? 'No items match those filters.'
                  : 'No items yet.'}
              </EmptyRow>
            )}
            {rows.map((item) => {
              const low = item.balances.filter((b) => b.belowThreshold);
              return (
                <Tr key={item.id} muted={!item.isActive}>
                  <Td className="min-w-[13rem]">
                    <Link
                      to={APP_ROUTE.itemDetail(item.id)}
                      className="font-medium text-slate-900 hover:text-slate-600 hover:underline"
                    >
                      {item.name}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-slate-500">
                    {item.sku}
                  </Td>
                  <Td className="whitespace-nowrap text-slate-600">
                    {item.unitOfMeasure.toLowerCase()}
                  </Td>
                  <Td align="right" numeric className="font-semibold text-slate-900">
                    {item.totalAcrossLocations.toLocaleString()}
                  </Td>
                  <Td className="w-32">
                    <StockLevelBar
                      quantity={item.totalAcrossLocations}
                      threshold={item.minThreshold * Math.max(1, item.balances.length)}
                    />
                  </Td>
                  <Td align="right" numeric className="text-slate-500">
                    {item.minThreshold}
                  </Td>
                  <Td>
                    {!item.isActive ? (
                      <Badge tone="neutral">inactive</Badge>
                    ) : low.length > 0 ? (
                      // A count rather than the list of codes. Spelling out
                      // four locations made this cell wrap to four lines and
                      // dragged the row height with it; the codes live in the
                      // tooltip, and on the item page where there is room.
                      <span title={`Below threshold at ${low.map((b) => b.locationCode).join(', ')}`}>
                        <Badge tone="danger">
                          {low.length} of {item.balances.length} low
                        </Badge>
                      </span>
                    ) : (
                      <Badge tone="ok">ok</Badge>
                    )}
                  </Td>
                  {isManager && (
                    <Td align="right" className="whitespace-nowrap">
                      <div className="flex justify-end gap-0.5">
                        <IconButton
                          label="Edit item"
                          icon={<PencilIcon />}
                          onClick={() => setEditing(item)}
                        />
                        <IconButton
                          label={item.isActive ? 'Deactivate item' : 'Reactivate item'}
                          icon={item.isActive ? <PowerOffIcon /> : <RotateIcon />}
                          onClick={() => toggleActive(item)}
                        />
                        <IconButton
                          label="Delete item"
                          tone="danger"
                          icon={<TrashIcon />}
                          onClick={() => setRemoving(item)}
                        />
                      </div>
                    </Td>
                  )}
                </Tr>
              );
            })}
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

      {creating && (
        <Modal
          title="Add an item"
          description="It starts with no stock. Put something on the shelf with a stock-in."
          onClose={() => setCreating(false)}
        >
          <ItemForm onDone={() => setCreating(false)} />
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ItemForm
            item={editing}
            // Any balance row at all means a movement created it, so the unit
            // is locked. It is a conservative test: an item can have movements
            // that net to nothing, and locking it then is the safe error.
            hasMovements={editing.balances.length > 0}
            onDone={() => setEditing(null)}
          />
        </Modal>
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel={removing.balances.length > 0 ? 'Deactivate' : 'Delete'}
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={confirmRemove}
        >
          {removing.balances.length > 0 ? (
            <>
              <p>
                This item has stock recorded against it, so it cannot be deleted — its movements
                are part of the ledger and deleting them would erase what happened.
              </p>
              <p className="mt-2">
                It will be <strong>deactivated</strong> instead: no new movements can be recorded
                against it, and its history stays readable. You can reactivate it later.
              </p>
            </>
          ) : (
            <p>
              No movement has ever referenced this item, so there is no history to preserve. It
              will be deleted permanently.
            </p>
          )}
        </ConfirmDialog>
      )}

      <InfoNote>
        “On hand” totals the locations you can see, and the bar compares it with the combined
        threshold for those locations. It is an aggregate, not an issuable figure — stock at one
        location can never satisfy a request at another.
      </InfoNote>
    </div>
  );
}
