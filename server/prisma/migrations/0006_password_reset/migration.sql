-- ---------------------------------------------------------------------------
-- Password reset.
--
-- Two properties this migration exists to support:
--
--   1. Only the HASH of a reset token is stored, so a leaked database yields no
--      usable reset links. A token that can stand in for a password deserves
--      the same treatment as a password.
--
--   2. users.password_changed_at lets every token issued before a reset be
--      refused. Without it, resetting a compromised password would change the
--      lock while leaving the intruder's existing key working until it happened
--      to expire — the opposite of what the person resetting expects.
-- ---------------------------------------------------------------------------

ALTER TABLE "users"
  ADD COLUMN "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "password_reset_tokens" (
    "id"                UUID NOT NULL,
    "user_id"           UUID NOT NULL,
    "token_hash"        TEXT NOT NULL,
    "expires_at"        TIMESTAMP(3) NOT NULL,
    "used_at"           TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_ip"        TEXT,
    "issued_by_user_id" UUID,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key"
    ON "password_reset_tokens" ("token_hash");

CREATE INDEX "password_reset_tokens_user_id_created_at_idx"
    ON "password_reset_tokens" ("user_id", "created_at" DESC);

-- Supports sweeping expired rows without scanning the table.
CREATE INDEX "password_reset_tokens_expires_at_idx"
    ON "password_reset_tokens" ("expires_at");

ALTER TABLE "password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
