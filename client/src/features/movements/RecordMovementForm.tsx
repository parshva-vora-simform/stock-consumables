import { queryKeys } from '../../api/queryKeys.js';
import { API, DIRECTION, type Direction } from '@stock/shared';
import { useActionState, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CreateMovementResponse, ItemWithBalances } from '@stock/shared';
import { post, ApiRequestError } from '../../api/client.js';
import { useCurrentUser } from '../../auth/AuthProvider.js';
import {
  Input,
  Select,
  Field,
  SubmitButton,
  ErrorBanner,
  SuccessBanner,
} from '../../components/ui.js';
import { StockInIcon, StockOutIcon } from '../../components/icons.js';

type Result =
  | { kind: 'idle' }
  | { kind: 'ok'; balanceAfter: number; direction: string; quantity: number; locationCode: string }
  | { kind: 'error'; message: string; available: number | null };

/**
 * UI-4. Two decisions here are deliberate and worth defending:
 *
 * 1. NO optimistic update. React 19 makes `useOptimistic` easy, and using it
 *    for a stock-out would be wrong: it would tell the operator they got the
 *    last unit before the database has decided whether they did. That is the
 *    human version of the race the whole system exists to prevent.
 *
 * 2. One idempotency key per INTENT, not per submit (FR-2.4). See below.
 */
export function RecordMovementForm({ item }: { item: ItemWithBalances }) {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<Direction>(DIRECTION.IN);
  const [locationId, setLocationId] = useState(user.locations[0]?.id ?? '');

  /**
   * The key identifies "this movement the operator means to record", and so it
   * has to outlive a single submit.
   *
   * Generating it inside the action — `idempotencyKey: crypto.randomUUID()` at
   * the point of the request — looks equivalent and is not: every attempt then
   * carries a DIFFERENT key, the server's unique index can never match, and a
   * resubmit after a timeout records a second movement. That is precisely the
   * double-issue FR-2.4 exists to prevent, reintroduced by the client.
   *
   * So it is minted once, survives every retry of the same intent, and is
   * replaced only after a movement is actually recorded — at which point the
   * next submit is a genuinely new intent and deserves a new key.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  // What is actually on the shelf at the selected location, so a stock-out can
  // show the ceiling before the operator hits it rather than after.
  const onHand = item.balances.find((b) => b.locationId === locationId)?.quantity ?? 0;

  const [result, submit] = useActionState<Result, FormData>(
    async (_prev, formData) => {
      const location = String(formData.get('locationId'));
      const dir = String(formData.get('direction')) as Direction;
      const quantity = Number(formData.get('quantity'));

      try {
        const res = await post<CreateMovementResponse>(API.movements.create(), {
          itemId: item.id,
          locationId: location,
          direction: dir,
          quantity,
          reference: String(formData.get('reference') || '') || undefined,
          note: String(formData.get('note') || '') || undefined,
          idempotencyKey,
        });

        // Recorded. The next submit is a new intent, so it gets a new key —
        // without this, a second deliberate stock-out of the same item would
        // replay the first instead of recording anything.
        setIdempotencyKey(crypto.randomUUID());

        await queryClient.invalidateQueries({ queryKey: queryKeys.items.detail(item.id) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.movements.history(item.id) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.lowStock.all });
        await queryClient.invalidateQueries({ queryKey: queryKeys.items.all });

        return {
          kind: 'ok',
          balanceAfter: res.balanceAfter,
          direction: dir,
          quantity,
          locationCode: res.movement.locationCode,
        };
      } catch (err) {
        if (err instanceof ApiRequestError) {
          return { kind: 'error', message: err.message, available: err.available };
        }
        return { kind: 'error', message: 'Could not record the movement.', available: null };
      }
    },
    { kind: 'idle' },
  );

  return (
    <form action={submit} className="space-y-4">
      {result.kind === 'error' && (
        <ErrorBanner title="Nothing was recorded">
          {result.message}
          {result.available !== null && (
            <p className="mt-1">
              There {result.available === 1 ? 'is' : 'are'}{' '}
              <strong className="tabular-nums">{result.available}</strong> on hand at that
              location.
            </p>
          )}
        </ErrorBanner>
      )}

      {result.kind === 'ok' && (
        <SuccessBanner>
          Recorded {result.direction === DIRECTION.IN ? 'stock in' : 'stock out'} of{' '}
          <strong className="tabular-nums">{result.quantity}</strong> at {result.locationCode}.
          Balance there is now <strong className="tabular-nums">{result.balanceAfter}</strong>.
        </SuccessBanner>
      )}

      {/* Direction as a segmented control rather than a dropdown: it is the one
          choice on this form that changes what the action means, and it should
          be visible without opening anything. */}
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">Direction</legend>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
          {([DIRECTION.IN, DIRECTION.OUT] as const).map((d) => (
            <label
              key={d}
              className={`cursor-pointer rounded-md px-3 py-1.5 text-center text-sm font-medium transition-colors ${
                direction === d
                  ? d === DIRECTION.IN
                    ? 'bg-white text-emerald-700 shadow-sm'
                    : 'bg-white text-amber-700 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <input
                type="radio"
                name="direction"
                value={d}
                checked={direction === d}
                onChange={() => setDirection(d)}
                className="sr-only"
              />
              <span className="inline-flex items-center justify-center gap-1.5">
                {d === DIRECTION.IN ? <StockInIcon size={14} /> : <StockOutIcon size={14} />}
                {d === DIRECTION.IN ? 'Stock in' : 'Stock out'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        label="Location"
        hint={
          direction === DIRECTION.OUT
            ? `${onHand} on hand here`
            : undefined
        }
      >
        {/* Only locations this user may act on. The server checks again
            regardless — this list is a convenience, not the control. */}
        <Select
          name="locationId"
          required
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          {user.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} — {l.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={`Quantity (${item.unitOfMeasure.toLowerCase()})`}>
        <Input name="quantity" type="number" min={1} step={1} defaultValue={1} required />
      </Field>

      <Field label="Reference" hint="Optional — e.g. a purchase order">
        <Input name="reference" placeholder="PO #4521" />
      </Field>

      <Field label="Note" hint="Optional — where it went, or why">
        <Input name="note" placeholder="Issued to site A" />
      </Field>

      <SubmitButton className="w-full">
        {direction === DIRECTION.IN ? 'Record stock in' : 'Record stock out'}
      </SubmitButton>

      {direction === DIRECTION.OUT && onHand === 0 && (
        <p className="text-xs text-amber-700">
          Nothing on hand here. A stock-out will be refused — stock at another location cannot
          satisfy it.
        </p>
      )}
    </form>
  );
}
