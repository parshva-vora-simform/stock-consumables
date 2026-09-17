import { API } from '@stock/shared';
import { useActionState } from 'react';
import { Link } from 'react-router';
import type { ForgotPasswordResponse } from '@stock/shared';
import { post, ApiRequestError } from '../../api/client.js';
import { Input, Field, SubmitButton, ErrorBanner } from '../../components/ui.js';
import { AuthShell } from './AuthShell.js';

type State =
  | { kind: 'idle' }
  | { kind: 'sent'; message: string; devResetUrl?: string }
  | { kind: 'error'; message: string };

export function ForgotPasswordPage() {
  const [state, submit] = useActionState<State, FormData>(async (_prev, formData) => {
    try {
      const res = await post<ForgotPasswordResponse>(API.auth.forgotPassword(), {
        email: String(formData.get('email') ?? ''),
      });
      return { kind: 'sent', message: res.message, devResetUrl: res.devResetUrl };
    } catch (err) {
      return {
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Could not send a reset link.',
      };
    }
  }, { kind: 'idle' });

  if (state.kind === 'sent') {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm text-slate-600">{state.message}</p>

        {state.devResetUrl && (
          <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-medium text-amber-900">Development only</p>
            <p className="mt-1 text-xs text-amber-800">
              No mail provider is wired up, so the link is shown here instead of being sent. This
              never happens in production.
            </p>
            <a
              href={state.devResetUrl}
              className="mt-2 block break-all text-xs text-amber-900 underline"
            >
              {state.devResetUrl}
            </a>
          </div>
        )}

        <Link to="/" className="mt-6 block text-sm text-slate-600 underline">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password">
      <p className="mb-6 text-sm text-slate-600">
        Enter the email you sign in with and we&rsquo;ll send a link to set a new password. The
        link works once and expires in 30 minutes.
      </p>

      <form action={submit} className="space-y-4">
        {state.kind === 'error' && <ErrorBanner>{state.message}</ErrorBanner>}

        <Field label="Email">
          <Input name="email" type="email" autoComplete="username" required autoFocus />
        </Field>

        <SubmitButton className="w-full">Send reset link</SubmitButton>
      </form>

      <Link to="/" className="mt-6 block text-center text-sm text-slate-600 underline">
        Back to sign in
      </Link>

      <p className="mt-6 text-xs text-slate-500">
        No work email? Ask your manager to generate a link for you from the Team page.
      </p>
    </AuthShell>
  );
}


