-- Refresh token rotation with reuse detection.
--
-- Before this, a refresh token was a bearer credential valid for its full
-- lifetime: presenting it minted a new access token, and the old refresh token
-- kept working. A copy taken from browser storage was therefore good for seven
-- days, and nothing in the system could tell that it had been taken.
--
-- Now each token is spent on use and replaced. Presenting a spent token is a
-- fact that only occurs under replay, so it revokes the whole family.

CREATE TABLE "refresh_tokens" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "family_id"  UUID NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "used_at"    TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3)
);

CREATE INDEX "refresh_tokens_user_id_created_at_idx"
  ON "refresh_tokens" ("user_id", "created_at" DESC);

CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" ("family_id");

-- Supports pruning expired rows without scanning the table.
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" ("expires_at");
