import { queryKeys } from '../../api/queryKeys.js';
import { API, APP_ROUTE } from '@stock/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'react-router';
import type { ItemWithBalances } from '@stock/shared';
import { get } from '../../api/client.js';
import {
  Badge,
  Card,
  StatTile,
  StockLevelBar,
  Spinner,
  ErrorBanner,
  EmptyState,
  InfoNote,
} from '../../components/ui.js';
import { RecordMovementForm } from '../movements/RecordMovementForm.js';
import { HistoryTable } from '../movements/HistoryTable.js';

export function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();

  const item = useQuery({
    queryKey: queryKeys.items.detail(id),
    queryFn: () => get<ItemWithBalances>(API.items.detail(id!)),
    enabled: Boolean(id),
  });

  if (item.isPending) return <Spinner />;
  if (item.isError) return <ErrorBanner>{(item.error as Error).message}</ErrorBanner>;

  const data = item.data;
  const lowCount = data.balances.filter((b) => b.belowThreshold).length;

  return (
    <div>
      <Link
        to={APP_ROUTE.items}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        ← All items
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{data.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <span className="font-mono text-xs">{data.sku}</span>
            <span aria-hidden>·</span>
            <span>measured in {data.unitOfMeasure.toLowerCase()}</span>
            {!data.isActive && <Badge tone="neutral">inactive</Badge>}
          </p>
        </div>
      </div>

      {/* Three figures, not nine. Anything more and none of them get read. */}
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="On hand"
          value={data.totalAcrossLocations.toLocaleString()}
          sub={`across ${data.balances.length} location${data.balances.length === 1 ? '' : 's'} you can see`}
        />
        <StatTile label="Alert threshold" value={data.minThreshold} sub="per location" />
        <StatTile
          label="Locations below"
          value={lowCount}
          tone={lowCount > 0 ? 'danger' : 'neutral'}
          sub={lowCount > 0 ? 'need restocking' : 'all above threshold'}
        />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_380px]">
        <Card title="Stock by location" description="The zero floor applies to each row separately.">
          {data.balances.length === 0 ? (
            <EmptyState
              title="No stock recorded"
              description="Nothing has been received at any location you can see. Record a stock-in to start the ledger."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.balances.map((b) => (
                <li key={b.locationId} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                      {b.locationCode}
                      {b.belowThreshold && <Badge tone="danger">below threshold</Badge>}
                    </p>
                    <p className="truncate text-xs text-slate-500">{b.locationName}</p>
                    <div className="mt-2 max-w-[14rem]">
                      <StockLevelBar quantity={b.quantity} threshold={data.minThreshold} />
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold tabular-nums text-slate-900">
                      {b.quantity.toLocaleString()}
                    </p>
                    <p className="text-xs text-slate-500">of {data.minThreshold} min</p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <InfoNote>
            {data.totalAcrossLocations.toLocaleString()} in total across these locations — an
            aggregate, not an issuable figure. A stock-out at one location is never satisfied by
            stock at another.
          </InfoNote>
        </Card>

        <Card title="Record a movement" description="Stock in or out. The server decides.">
          <RecordMovementForm item={data} />
        </Card>
      </div>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Movement history</h2>
        <HistoryTable itemId={data.id} />
      </div>
    </div>
  );
}
