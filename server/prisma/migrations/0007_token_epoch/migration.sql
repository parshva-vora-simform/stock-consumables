-- ---------------------------------------------------------------------------
-- Exact session invalidation.
--
-- 0006 invalidated tokens by comparing a JWT's `iat` against
-- users.password_changed_at. That comparison is unsound, because `iat` is in
-- whole seconds and the timestamp carries milliseconds:
--
--   * compared strictly, a token minted in the same second as account creation
--     looks older than the account and the user is locked out immediately;
--   * compared at second precision, a password reset within a second of
--     signing in invalidates nothing.
--
-- There is no precision at which both hold. So the decision moves to a counter:
-- a token carries the epoch it was minted under, and is refused the moment the
-- two disagree. No clocks, no window.
--
-- password_changed_at stays, as information rather than as a control.
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN "token_epoch" INTEGER NOT NULL DEFAULT 0;
