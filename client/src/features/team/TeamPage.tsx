import { queryKeys } from '../../api/queryKeys.js';
import { ACCESS_CHANGE, API, ROLE } from '@stock/shared';
import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type {
  TeamMember,
  LocationSummary,
  AccessChange,
  UserSortField,
  Paged,
} from '@stock/shared';
import { get, post, ApiRequestError } from '../../api/client.js';
import { useCurrentUser } from '../../auth/AuthProvider.js';
import {
  Badge,
  Button,
  Input,
  Select,
  Control,
  PageHeader,
  ErrorBanner,
  TableSkeleton,
  InfoNote,
  Spinner,
  IconButton,
} from '../../components/ui.js';
import {
  PlusIcon,
  MapPinIcon,
  KeyIcon,
  HistoryIcon,
  SearchIcon,
} from '../../components/icons.js';
import {
  SortableHeader,
  TableShell,
  TableHead,
  Th,
  Tr,
  Td,
  FilterBar,
  Pagination,
  EmptyRow,
  useDebounced,
  type SortState,
} from '../../components/table.js';
import { Modal } from '../../components/Modal.js';
import { AssignLocationsDialog } from './AssignLocationsDialog.js';
import { AddHandlerForm } from './AddHandlerForm.js';

/**
 * Manager-only. This is where the location scoping the rest of the system
 * enforces actually gets set: who may move stock in which warehouse or site.
 *
 * The route is guarded server-side too — a handler reaching /api/v1/users gets
 * a 403 whatever this page does or does not render.
 */
export function TeamPage() {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const [assigning, setAssigning] = useState<TeamMember | null>(null);
  const [adding, setAdding] = useState(false);
  const [historyFor, setHistoryFor] = useState<TeamMember | null>(null);
  const [resetLink, setResetLink] = useState<{ member: TeamMember; url: string } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [sort, setSort] = useState<SortState<UserSortField>>({
    sortBy: 'name',
    sortOrder: 'asc',
  });
  const debouncedSearch = useDebounced(search);
  const [page, setPage] = useState(1);

  const team = useQuery({
    queryKey: queryKeys.team.list({ debouncedSearch, role, filterLocation, ...sort }, page),
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: '10',
        sortBy: sort.sortBy,
        sortOrder: sort.sortOrder,
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (role) params.set('role', role);
      // "Who can act here?" — a manager matches every location by role, which
      // the server accounts for rather than the client guessing.
      if (filterLocation) params.set('locationId', filterLocation);
      return get<Paged<TeamMember>>(`${API.users.list()}?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const members = team.data?.data ?? [];

  /** Filters and sort reset the page; the old number describes a different set. */
  function reset<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  const locations = useQuery({
    queryKey: queryKeys.locations.all,
    queryFn: () => get<{ data: LocationSummary[] }>(API.locations.list()),
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: queryKeys.team.all });
  }

  /**
   * Warehouse handlers often have no work email to receive a link at, so
   * without this the practical fallback is a manager inventing a password and
   * sending it over chat. The link is single-use and expires in 30 minutes, and
   * the manager never learns the password the handler chooses.
   */
  async function issueResetLink(member: TeamMember) {
    setResetError(null);
    try {
      const res = await post<{ resetUrl: string }>(API.users.resetLink(member.id), {});
      setResetLink({ member, url: res.resetUrl });
    } catch (err) {
      setResetError(
        err instanceof ApiRequestError ? err.message : 'Could not create a reset link.',
      );
    }
  }

  return (
    <div>
      <PageHeader
        title="Team"
        description="Who may record stock at which warehouse or site."
        actions={
          <Button onClick={() => setAdding(true)}>
            <PlusIcon size={15} /> Add handler
          </Button>
        }
      />

      {resetError && (
        <div className="mb-4">
          <ErrorBanner>{resetError}</ErrorBanner>
        </div>
      )}

      <FilterBar>
        <div className="w-full sm:w-56">
          <Control label="Search">
            <div className="relative">
              <SearchIcon
                size={15}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <Input
                placeholder="Name or email…"
                value={search}
                onChange={(e) => reset(setSearch)(e.target.value)}
                className="pl-8"
              />
            </div>
          </Control>
        </div>
        <div className="w-36">
          <Control label="Role">
            <Select value={role} onChange={(e) => reset(setRole)(e.target.value)}>
              <option value="">Any</option>
              <option value="HANDLER">Handler</option>
              <option value="MANAGER">Manager</option>
            </Select>
          </Control>
        </div>
        <div className="w-48">
          <Control label="Can act at">
            <Select
              value={filterLocation}
              onChange={(e) => reset(setFilterLocation)(e.target.value)}
            >
              <option value="">Anywhere</option>
              {(locations.data?.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
            </Select>
          </Control>
        </div>
      </FilterBar>

      {resetError && (
        <div className="mb-4">
          <ErrorBanner>{resetError}</ErrorBanner>
        </div>
      )}

      {team.isError && <ErrorBanner>{(team.error as Error).message}</ErrorBanner>}

      <TableShell>
        <TableHead>
          <SortableHeader field="name" sort={sort} onSort={reset(setSort)}>
            Person
          </SortableHeader>
          <SortableHeader field="role" sort={sort} onSort={reset(setSort)}>
            Role
          </SortableHeader>
          <Th>Can act at</Th>
          <SortableHeader field="movementCount" sort={sort} onSort={reset(setSort)} align="right">
            Movements
          </SortableHeader>
          <Th align="right" />
        </TableHead>

        {team.isPending ? (
          <TableSkeleton rows={6} cols={5} />
        ) : (
          <tbody className="divide-y divide-slate-100">
            {members.length === 0 && (
              <EmptyRow colSpan={5}>Nobody matches those filters.</EmptyRow>
            )}
            {members.map((member) => (
              <Tr key={member.id} muted={!member.isActive}>
                <Td>
                  <p className="font-medium text-slate-900">
                    {member.name}
                    {member.id === me.id && (
                      <span className="ml-2 text-xs font-normal text-slate-400">you</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">{member.email}</p>
                </Td>
                <Td>
                  <Badge tone="neutral">
                    {member.role === ROLE.MANAGER ? 'manager' : 'handler'}
                  </Badge>
                  {!member.isActive && (
                    <span className="ml-1.5">
                      <Badge tone="danger">deactivated</Badge>
                    </span>
                  )}
                </Td>
                <Td>
                  {member.role === ROLE.MANAGER ? (
                    <span className="text-sm text-slate-500">
                      Every location
                      <span className="ml-1 text-xs text-slate-400">(by role)</span>
                    </span>
                  ) : member.locations.length === 0 ? (
                    <Badge tone="warn">nowhere — cannot record anything</Badge>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {member.locations.map((l) => (
                        <span
                          key={l.id}
                          title={l.name}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700"
                        >
                          {l.code}
                        </span>
                      ))}
                    </div>
                  )}
                </Td>
                <Td align="right" numeric className="text-slate-600">
                  {member.movementCount.toLocaleString()}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  <div className="flex justify-end gap-0.5">
                    {member.role === ROLE.HANDLER && (
                      <IconButton
                        label="Change locations"
                        icon={<MapPinIcon />}
                        onClick={() => setAssigning(member)}
                      />
                    )}
                    {member.isActive && (
                      <IconButton
                        label="Issue a password reset link"
                        icon={<KeyIcon />}
                        onClick={() => issueResetLink(member)}
                      />
                    )}
                    <IconButton
                      label="Access history"
                      icon={<HistoryIcon />}
                      onClick={() => setHistoryFor(member)}
                    />
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        )}
      </TableShell>

      {!team.isPending && (
        <Pagination
          page={team.data?.page ?? 1}
          totalPages={team.data?.totalPages ?? 1}
          total={team.data?.total ?? 0}
          totalIsExact={team.data?.totalIsExact ?? true}
          hasNext={team.data?.hasNext ?? false}
          pageSize={team.data?.pageSize ?? 10}
          rowsOnPage={members.length}
          isLoading={team.isFetching}
          onPage={setPage}
        />
      )}

      <InfoNote>
        Removing someone from a location stops them recording there from now on. It does not touch
        movements they already recorded — those are part of the ledger and stay attributed to them.
      </InfoNote>

      {adding && (
        <Modal title="Add a handler" onClose={() => setAdding(false)}>
          <AddHandlerForm
            locations={locations.data?.data ?? []}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        </Modal>
      )}

      {assigning && (
        <Modal
          title={`Locations for ${assigning.name}`}
          onClose={() => setAssigning(null)}
        >
          <AssignLocationsDialog
            member={assigning}
            locations={locations.data?.data ?? []}
            onDone={() => {
              setAssigning(null);
              refresh();
            }}
          />
        </Modal>
      )}

      {resetLink && (
        <Modal
          title={`Reset link for ${resetLink.member.name}`}
          onClose={() => setResetLink(null)}
        >
          <p className="text-sm text-slate-600">
            Send this to {resetLink.member.name}. It works once, expires in 30 minutes, and lets
            them choose their own password — you will not see it.
          </p>
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <code className="block break-all text-xs text-slate-800">{resetLink.url}</code>
          </div>
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => navigator.clipboard?.writeText(resetLink.url)}
          >
            Copy link
          </Button>
          <p className="mt-3 text-xs text-slate-500">
            Any earlier link for this person has stopped working. Using this one signs them out
            everywhere.
          </p>
        </Modal>
      )}

      {historyFor && (
        <Modal title={`Access history — ${historyFor.name}`} onClose={() => setHistoryFor(null)}>
          <AccessHistory userId={historyFor.id} />
        </Modal>
      )}
    </div>
  );
}

function AccessHistory({ userId }: { userId: string }) {
  const history = useQuery({
    queryKey: queryKeys.team.accessHistory(userId),
    queryFn: () => get<{ data: AccessChange[] }>(API.users.accessHistory(userId)),
  });

  if (history.isPending) return <Spinner />;
  if (history.isError) return <ErrorBanner>{(history.error as Error).message}</ErrorBanner>;
  if (history.data.data.length === 0) {
    return <p className="text-sm text-slate-500">No access changes recorded.</p>;
  }

  return (
    <ul className="space-y-2 text-sm">
      {history.data.data.map((c) => (
        <li key={c.id} className="rounded border border-slate-200 p-3">
          <div className="flex items-baseline justify-between">
            <span>
              {c.action === ACCESS_CHANGE.GRANTED ? (
                <Badge tone="ok">granted</Badge>
              ) : (
                <Badge tone="warn">revoked</Badge>
              )}
              <span className="ml-2 font-medium text-slate-900">{c.locationCode}</span>
            </span>
            <span className="text-xs text-slate-500">
              {new Date(c.changedAt).toLocaleString()}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-600">
            by {c.changedByName}
            {c.reason && <> — {c.reason}</>}
          </div>
        </li>
      ))}
    </ul>
  );
}
