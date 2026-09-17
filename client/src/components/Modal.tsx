import { useEffect, type ReactNode } from 'react';
import { XIcon } from './icons.js';

/**
 * How many dialogs currently want the page frozen.
 *
 * Counted rather than a boolean: if a confirmation opens over another dialog,
 * the first one to close would otherwise unlock the page while a dialog is
 * still on screen.
 */
let lockCount = 0;

function lockBodyScroll(): () => void {
  const { body } = document;

  if (lockCount === 0) {
    // Removing the scrollbar widens the viewport by its width, so the page
    // jumps sideways as the dialog opens. Padding by exactly that width holds
    // the layout still.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.dataset['prevOverflow'] = body.style.overflow;
    body.dataset['prevPadding'] = body.style.paddingRight;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
  }
  lockCount++;

  return () => {
    lockCount--;
    if (lockCount === 0) {
      body.style.overflow = body.dataset['prevOverflow'] ?? '';
      body.style.paddingRight = body.dataset['prevPadding'] ?? '';
      delete body.dataset['prevOverflow'];
      delete body.dataset['prevPadding'];
    }
  };
}

export function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Escape closes it. A dialog you can only leave with the mouse is a dialog
  // that traps anyone working from the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Freeze the page behind the dialog.
   *
   * Without this, scrolling with the dialog open moves the table underneath —
   * the dialog appears to float away from the content, and on a trackpad it is
   * easy to lose the row you opened it from.
   */
  useEffect(lockBodyScroll, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg animate-slide-up overflow-auto rounded-xl bg-white shadow-popover"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <XIcon />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Confirmation for an action that cannot simply be undone. */
export function ConfirmDialog({
  title,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  danger,
  busy,
  children,
}: {
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm text-slate-600">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`rounded-lg px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50 ${
            danger ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-900 hover:bg-slate-800'
          }`}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
