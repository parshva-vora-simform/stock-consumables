import { API } from '@stock/shared';
import { useActionState, useState } from 'react';
import type { LocationSummary, TeamMember } from '@stock/shared';
import { api, ApiRequestError } from '../../api/client.js';
import { Field, Input, SubmitButton, ErrorBanner } from '../../components/ui.js';

/**
 * Sets a handler's whole location set at once.
 *
 * Sending the full set rather than a series of add/remove calls is what makes
 * "move this person from WH-A to SITE-1" a single atomic change — there is no
 * moment where they can reach both, or neither.
 */
export function AssignLocationsDialog({
  member,
  locations,
  onDone,
}: {
  member: TeamMember;
  locations: LocationSummary[];
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(member.locations.map((l) => l.id));

  const [error, submit] = useActionState<string | null, FormData>(async (_prev, formData) => {
    try {
      await api(API.users.locations(member.id), {
        method: 'PUT',
        body: JSON.stringify({
          locationIds: selected,
          reason: String(formData.get('reason') || '') || undefined,
        }),
      });
      onDone();
      return null;
    } catch (err) {
      return err instanceof ApiRequestError ? err.message : 'Could not save those locations.';
    }
  }, null);

  const before = new Set(member.locations.map((l) => l.id));
  const granted = selected.filter((id) => !before.has(id));
  const revoked = [...before].filter((id) => !selected.includes(id));
  const codeOf = (id: string) => locations.find((l) => l.id === id)?.code ?? id;

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  return (
    <form action={submit} className="space-y-4">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">
          Warehouses and sites {member.name} may record stock at
        </legend>
        <div className="space-y-1.5">
          {locations.map((l) => (
            <label
              key={l.id}
              className="flex cursor-pointer items-center gap-3 rounded border border-slate-200 px-3 py-2 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(l.id)}
                onChange={() => toggle(l.id)}
                className="h-4 w-4"
              />
              <span className="text-sm">
                <span className="font-medium text-slate-900">{l.code}</span>
                <span className="ml-2 text-slate-500">{l.name}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {(granted.length > 0 || revoked.length > 0) && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="font-medium text-slate-700">This will:</p>
          <ul className="mt-1 space-y-0.5 text-slate-600">
            {granted.map((id) => (
              <li key={id}>+ give access to {codeOf(id)}</li>
            ))}
            {revoked.map((id) => (
              <li key={id}>− remove access to {codeOf(id)}</li>
            ))}
          </ul>
          {revoked.length > 0 && member.movementCount > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Their {member.movementCount} existing movements stay in the ledger, still attributed
              to them. This only affects what they can record from now on.
            </p>
          )}
        </div>
      )}

      {selected.length === 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          With no locations, {member.name} can sign in but cannot record any movement anywhere.
        </div>
      )}

      <Field label="Reason (kept with the access history)">
        <Input name="reason" placeholder="Transferred to SITE-1" />
      </Field>

      <SubmitButton>Save locations</SubmitButton>
    </form>
  );
}
