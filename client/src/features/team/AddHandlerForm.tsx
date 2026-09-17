import { API, ROLE } from '@stock/shared';
import { useActionState, useState } from 'react';
import type { LocationSummary } from '@stock/shared';
import { post, ApiRequestError } from '../../api/client.js';
import { Field, Input, SubmitButton, ErrorBanner } from '../../components/ui.js';

export function AddHandlerForm({
  locations,
  onDone,
}: {
  locations: LocationSummary[];
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);

  const [error, submit] = useActionState<string | null, FormData>(async (_prev, formData) => {
    try {
      await post(API.users.create(), {
        email: String(formData.get('email')),
        name: String(formData.get('name')),
        role: ROLE.HANDLER,
        password: String(formData.get('password')),
        locationIds: selected,
      });
      onDone();
      return null;
    } catch (err) {
      return err instanceof ApiRequestError ? err.message : 'Could not create that account.';
    }
  }, null);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  return (
    <form action={submit} className="space-y-4">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Field label="Name">
        <Input name="name" required autoFocus placeholder="Raj Patel" />
      </Field>

      <Field label="Email">
        <Input name="email" type="email" required placeholder="raj@company.com" />
      </Field>

      <Field label="Initial password">
        <Input
          name="password"
          type="password"
          required
          minLength={10}
          placeholder="At least 10 characters"
        />
      </Field>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">
          Warehouses and sites they may record stock at
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
        {selected.length === 0 && (
          <p className="mt-2 text-xs text-amber-700">
            Pick at least one, or they will be able to sign in but not record anything.
          </p>
        )}
      </fieldset>

      <SubmitButton>Create handler</SubmitButton>
    </form>
  );
}
