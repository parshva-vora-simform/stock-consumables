import { DIRECTION, type Direction } from '@stock/shared';
import type { ComponentProps, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { StockInIcon, StockOutIcon } from './icons.js';

/**
 * UI primitives.
 *
 * React 19: `ref` is an ordinary prop, so none of these need forwardRef —
 * React Hook Form's register() spreads its ref straight onto them.
 */

// --- Form controls ---------------------------------------------------------

const FIELD_BASE =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 transition-colors hover:border-slate-400 ' +
  'focus:border-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`${FIELD_BASE} ${className}`} />;
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return <select {...props} className={`${FIELD_BASE} pr-8 ${className}`} />;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-medium text-red-700">{error}</span>}
    </label>
  );
}

/** A compact labelled control for filter bars, where `Field` is too tall. */
export function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

// --- Buttons ---------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Dark slate, matching the active navigation chip. One accent for "this is
  // the action", not two — a blue button beside a slate active state reads as
  // two competing primaries on the same screen.
  primary: 'bg-slate-900 text-white shadow-sm hover:bg-slate-800 active:bg-slate-950',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 active:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  const sizing = size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm';
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
    />
  );
}

/**
 * Submits a `<form action={...}>` and disables itself while that action runs —
 * React 19's useFormStatus, no per-form useState.
 *
 * Blocking the second click is not cosmetic here: it is the client-side face of
 * the same double-issue problem the ledger guards against on the server.
 */
export function SubmitButton({ children, className = '', ...props }: ComponentProps<'button'>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} className={className} {...props}>
      {pending && <Spinner.Inline />}
      {pending ? 'Working…' : children}
    </Button>
  );
}

/**
 * An icon-only button.
 *
 * `label` is required, and not by accident: an icon alone is meaningless to a
 * screen reader and ambiguous to anyone who has not learned that particular
 * glyph. It becomes both the accessible name and the tooltip, so the meaning is
 * one hover — or one screen reader — away.
 */
export function IconButton({
  label,
  icon,
  tone = 'default',
  className = '',
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & {
  label: string;
  icon: ReactNode;
  tone?: 'default' | 'danger';
}) {
  const tones = {
    default: 'text-slate-400 hover:bg-slate-100 hover:text-slate-900',
    danger: 'text-slate-400 hover:bg-red-50 hover:text-red-700',
  };

  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {icon}
    </button>
  );
}

// --- Status ----------------------------------------------------------------

type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-red-50 text-red-800 ring-red-200',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Stock in or out, at a glance.
 *
 * Direction is the single most scanned column in the history table, so it gets
 * both a colour and a glyph — colour alone would be invisible to a colour-blind
 * reader, and this is the field they most need to be sure of.
 */
export function DirectionChip({ direction }: { direction: Direction }) {
  return direction === DIRECTION.IN ? (
    <Badge tone="ok">
      <StockInIcon size={12} /> in
    </Badge>
  ) : (
    <Badge tone="warn">
      <StockOutIcon size={12} /> out
    </Badge>
  );
}

/**
 * Quantity against its threshold, as a bar.
 *
 * A number alone makes you do arithmetic on every row — "is 70 of 300 bad?".
 * The bar answers it before you read the digits, and the colour states the
 * verdict: at or below threshold is red, within a quarter of it is amber.
 */
export function StockLevelBar({
  quantity,
  threshold,
}: {
  quantity: number;
  threshold: number;
}) {
  // Full bar = twice the threshold, so "comfortably stocked" has somewhere to
  // sit rather than pinning at 100% the moment it clears the line.
  const ceiling = Math.max(threshold * 2, quantity, 1);
  const pct = Math.min(100, Math.round((quantity / ceiling) * 100));
  const markerPct = threshold > 0 ? Math.min(100, (threshold / ceiling) * 100) : null;

  const tone =
    quantity <= threshold
      ? 'bg-red-500'
      : quantity <= threshold * 1.25
        ? 'bg-amber-500'
        : 'bg-emerald-500';

  return (
    <div
      className="relative h-1.5 w-full min-w-[3rem] overflow-hidden rounded-full bg-slate-200"
      role="img"
      aria-label={`${quantity} on hand, threshold ${threshold}`}
    >
      <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
      {markerPct !== null && (
        // Where the threshold sits, so the bar is readable without the numbers.
        <span
          className="absolute top-0 h-full w-px bg-slate-500/60"
          style={{ left: `${markerPct}%` }}
        />
      )}
    </div>
  );
}

// --- Containers ------------------------------------------------------------

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white shadow-card ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** A headline figure. Used sparingly — three of these, not nine. */
export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'danger' ? 'text-red-700' : 'text-slate-900'
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

// --- Feedback --------------------------------------------------------------

export function ErrorBanner({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div
      role="alert"
      className="animate-fade-in rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? 'mt-0.5' : ''}>{children}</div>
    </div>
  );
}

export function SuccessBanner({ children }: { children: ReactNode }) {
  return (
    <div className="animate-fade-in rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
      {children}
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-xs leading-relaxed text-slate-500">{children}</p>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Skeletons rather than a spinner for tables.
 *
 * A spinner discards the layout and then slams it back; a skeleton of the right
 * shape means the page does not jump when the data lands, and the wait reads as
 * shorter even when it is not.
 */
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
      <Spinner.Inline />
      {label}
    </div>
  );
}

Spinner.Inline = function InlineSpinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60"
    />
  );
};

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <tbody className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-3.5">
              <div className="skeleton h-3" style={{ width: c === 0 ? '70%' : '40%' }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
