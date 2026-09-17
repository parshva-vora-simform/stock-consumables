import { API } from '@stock/shared';
import { useActionState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router';
import { post, ApiRequestError } from '../../api/client.js';
import { Input, Field, SubmitButton, ErrorBanner } from '../../components/ui.js';
import { AuthShell } from './AuthShell.js';

type State = { kind: 'idle' } | { kind: 'done' } | { kind: 'error'; message: string };

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [state, submit] = useActionState<State, FormData>(async (_prev, formData) => {
    const password = String(formData.get('password') ?? '');
    const confirm = String(formData.get('confirm') ?? '');

    // Checked here rather than server-side: the server has no business knowing
    // the user typed it twice, and the feedback belongs next to the field.
    if (password !== confirm) {
      return { kind: 'error', message: 'Those two passwords do not match.' };
    }

    try {
      await post(API.auth.resetPassword(), { token, password });
      return { kind: 'done' };
    } catch (err) {
      return {
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Could not reset your password.',
      };
    }
  }, { kind: 'idle' });

  if (!token) {
    return (
      <AuthShell title="That link is incomplete">
        <ErrorBanner>
          This reset link is missing its token. Request a new one and use the whole link.
        </ErrorBanner>
        <Link to="/forgot-password" className="mt-6 block text-sm text-slate-600 underline">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  if (state.kind === 'done') {
    return (
      <AuthShell title="Password changed">
        <p className="text-sm text-slate-600">
          Your password has been changed. Anyone still signed in as you — on another device, or
          anyone who had the old password — has been signed out.
        </p>
        <button
          onClick={() => navigate('/')}
          className="mt-6 w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Sign in
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password">
      <form action={submit} className="space-y-4">
        {state.kind === 'error' && <ErrorBanner>{state.message}</ErrorBanner>}

        <Field label="New password">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            autoFocus
            placeholder="At least 10 characters"
          />
        </Field>

        <Field label="Confirm new password">
          <Input name="confirm" type="password" autoComplete="new-password" required />
        </Field>

        <SubmitButton className="w-full">Set new password</SubmitButton>
      </form>

      <p className="mt-6 text-xs text-slate-500">
        This link works once. Setting a new password signs out every existing session.
      </p>
    </AuthShell>
  );
}
