import { APP_ROUTE, ROLE } from '@stock/shared';
import type { ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthProvider.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage.js';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage.js';
import { ItemsPage } from './features/items/ItemsPage.js';
import { ItemDetailPage } from './features/items/ItemDetailPage.js';
import { LowStockPage } from './features/reports/LowStockPage.js';
import { TeamPage } from './features/team/TeamPage.js';
import { Button, Spinner, EmptyState } from './components/ui.js';
import { PackageIcon, AlertIcon, UsersIcon, LogOutIcon } from './components/icons.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  );
}

function Shell() {
  const { status } = useAuth();

  if (status === 'loading') return <Spinner label="Restoring session…" />;

  // Signed out, but still routed: a reset link has to open without a session,
  // which is the entire point of it.
  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path={APP_ROUTE.forgotPassword} element={<ForgotPasswordPage />} />
        <Route path={APP_ROUTE.resetPassword} element={<ResetPasswordPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar />
      {/* No max-width cap. This is a dense table application — capping the
          content at a comfortable reading measure made sense for prose and
          just wasted several hundred pixels of table on a wide screen, which
          is where the columns were being crushed instead. */}
      <main className="w-full px-4 py-8 sm:px-6 lg:px-8">
        <Routes>
          <Route path="/" element={<Navigate to={APP_ROUTE.items} replace />} />
          <Route path={APP_ROUTE.items} element={<ItemsPage />} />
          <Route path="/items/:id" element={<ItemDetailPage />} />
          <Route path={APP_ROUTE.lowStock} element={<LowStockPage />} />
          <Route
            path={APP_ROUTE.team}
            element={
              <ManagerOnly>
                <TeamPage />
              </ManagerOnly>
            }
          />
          {/* Someone already signed in who opens a reset link should still be
              able to use it — they may be resetting precisely because they
              think someone else has their password. */}
          <Route path={APP_ROUTE.resetPassword} element={<ResetPasswordPage />} />
          <Route path="*" element={<Navigate to={APP_ROUTE.items} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function TopBar() {
  const { user, signOut } = useAuth();

  const link = ({ isActive }: { isActive: boolean }) =>
    `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
    }`;

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold text-slate-900">Stock &amp; Consumables</span>
          <nav className="flex gap-1">
            {/* Icon plus label, not icon alone: navigation is where a
                mis-guessed glyph costs the most, and there is room for both. */}
            <NavLink to={APP_ROUTE.items} className={link}>
              <PackageIcon size={15} /> Items
            </NavLink>
            <NavLink to={APP_ROUTE.lowStock} className={link}>
              <AlertIcon size={15} /> Low stock
            </NavLink>
            {user?.role === ROLE.MANAGER && (
              <NavLink to={APP_ROUTE.team} className={link}>
                <UsersIcon size={15} /> Team
              </NavLink>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-sm font-medium text-slate-900">{user?.name}</div>
            <div className="text-xs text-slate-500">
              {user?.role === ROLE.MANAGER
                ? 'Manager — all locations'
                : `Handler — ${user?.locations.map((l) => l.code).join(', ') || 'no locations'}`}
            </div>
          </div>
          <Button variant="secondary" onClick={signOut}>
            <LogOutIcon size={15} /> Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * Cosmetic guard. Every route behind it is independently enforced server-side —
 * a handler who types /team into the address bar sees the message below, and a
 * handler who calls the API directly gets a 403 (AC-3).
 */
function ManagerOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== ROLE.MANAGER) {
    return (
      <EmptyState
        title="Managers only"
        description="Team management is available to managers. If you think you should have access, ask your manager to change your role."
      />
    );
  }
  return <>{children}</>;
}
