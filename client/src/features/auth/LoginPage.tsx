import { APP_ROUTE } from '@stock/shared';
import { useActionState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthProvider.js';
import { ApiRequestError } from '../../api/client.js';
import { Input, Field, SubmitButton, ErrorBanner } from '../../components/ui.js';
import { AuthShell } from './AuthShell.js';

/**
 * React 19 Actions: the form's submit handler IS the action, and its return
 * value is the error state. No isSubmitting flag, no separate error useState.
 */
export function LoginPage() {
  const { signIn } = useAuth();

  const [error, submit] = useActionState<string | null, FormData>(async (_prev, formData) => {
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    try {
      await signIn(email, password);
      return null;
    } catch (err) {
      return err instanceof ApiRequestError ? err.message : 'Could not sign in.';
    }
  }, null);

  return (
    <AuthShell
      title="Stock &amp; Consumables"
      subtitle="Sign in to record and view stock"
    >
      <form action={submit} className="space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}

        <Field label="Email">
          <Input name="email" type="email" autoComplete="username" required autoFocus />
        </Field>

        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>

        <SubmitButton className="w-full">Sign in</SubmitButton>

        <div className="text-center">
          <Link
            to={APP_ROUTE.forgotPassword}
            className="text-sm text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
          >
            Forgot your password?
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
