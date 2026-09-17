import { queryKeys } from '../../api/queryKeys.js';
import { API } from '@stock/shared';
import { useActionState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ItemWithBalances, UnitOfMeasure } from '@stock/shared';
import { post, patch, ApiRequestError } from '../../api/client.js';
import { Input, Select, Field, SubmitButton, ErrorBanner } from '../../components/ui.js';

const UNITS: UnitOfMeasure[] = ['EACH', 'KG', 'LITRE', 'METRE', 'BOX', 'PACK'];

/**
 * Create or edit an item. One form for both — the fields are identical, and the
 * only real difference is whether the unit of measure can still be changed.
 */
export function ItemForm({
  item,
  hasMovements,
  onDone,
}: {
  /** Absent when creating. */
  item?: ItemWithBalances;
  /** Editing only: whether the ledger already has history for this item. */
  hasMovements?: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(item);
  const unitLocked = isEdit && hasMovements;

  const [error, submit] = useActionState<string | null, FormData>(async (_prev, formData) => {
    const body = {
      sku: String(formData.get('sku') ?? '').toUpperCase(),
      name: String(formData.get('name') ?? ''),
      unitOfMeasure: String(formData.get('unitOfMeasure') ?? 'EACH'),
      minThreshold: Number(formData.get('minThreshold') ?? 0),
    };

    try {
      if (item) {
        // Don't send a unit the server will refuse — the field is disabled in
        // that case and its value would be unchanged anyway.
        const { unitOfMeasure, ...rest } = body;
        await patch(API.items.update(item.id), unitLocked ? rest : body);
      } else {
        await post(API.items.create(), body);
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.items.all });
      if (item) await queryClient.invalidateQueries({ queryKey: queryKeys.items.detail(item.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.lowStock.all });

      onDone();
      return null;
    } catch (err) {
      return err instanceof ApiRequestError ? err.message : 'Could not save that item.';
    }
  }, null);

  return (
    <form action={submit} className="space-y-4">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Field label="Name">
        <Input
          name="name"
          required
          maxLength={120}
          autoFocus
          defaultValue={item?.name}
          placeholder="Nitrile gloves (medium)"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="SKU" hint="Capitals, digits and hyphens">
          <Input
            name="sku"
            required
            maxLength={40}
            pattern="[A-Za-z0-9\-]+"
            defaultValue={item?.sku}
            placeholder="GLV-NIT-M"
            className="font-mono"
          />
        </Field>

        <Field
          label="Unit of measure"
          hint={
            unitLocked
              ? 'Fixed — movements already recorded in this unit'
              : 'How quantities are counted'
          }
        >
          <Select
            name="unitOfMeasure"
            defaultValue={item?.unitOfMeasure ?? 'EACH'}
            disabled={unitLocked}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u.toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Low-stock threshold"
        hint="Per location. The item appears in Low stock at or below this figure."
      >
        <Input
          name="minThreshold"
          type="number"
          min={0}
          step={1}
          required
          defaultValue={item?.minThreshold ?? 0}
        />
      </Field>

      {unitLocked && (
        <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
          The unit cannot be changed once movements exist. Quantities in the ledger were recorded
          in {item?.unitOfMeasure.toLowerCase()} — relabelling the item now would silently
          reinterpret every one of them.
        </p>
      )}

      <SubmitButton className="w-full">{isEdit ? 'Save changes' : 'Create item'}</SubmitButton>

      {!isEdit && (
        <p className="text-xs text-slate-500">
          A new item starts with no stock anywhere. Record a stock-in to put something on the
          shelf — there is no way to type a starting quantity.
        </p>
      )}
    </form>
  );
}
