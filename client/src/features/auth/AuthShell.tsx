import type { ReactNode } from 'react';

/**
 * The frame every signed-out screen sits in.
 *
 * A single centred column rather than the usual split hero: there is no
 * marketing to put in the other half, and an empty half is worse than no half.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-lg font-semibold text-white">
            S
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">{children}</div>

        {footer && <div className="mt-4">{footer}</div>}
      </div>
    </div>
  );
}
