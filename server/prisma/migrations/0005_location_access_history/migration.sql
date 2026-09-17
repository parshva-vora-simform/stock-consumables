-- ---------------------------------------------------------------------------
-- Who could reach which location, and since when.
--
-- Location access decides who may move stock where, so changing it is a
-- security-relevant event and is recorded like one: append-only, attributed,
-- timestamped. Without this table the grant list only ever shows the present,
-- and "why was this person able to issue stock at SITE-1 last March?" has no
-- answer.
-- ---------------------------------------------------------------------------

CREATE TYPE "AccessChangeAction" AS ENUM ('GRANTED', 'REVOKED');

CREATE TABLE "location_access_changes" (
    "id"                 UUID NOT NULL,
    "user_id"            UUID NOT NULL,
    "location_id"        UUID NOT NULL,
    "action"             "AccessChangeAction" NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "changed_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason"             TEXT,
    "request_id"         TEXT NOT NULL,

    CONSTRAINT "location_access_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "location_access_changes_user_id_changed_at_idx"
    ON "location_access_changes" ("user_id", "changed_at" DESC);

CREATE INDEX "location_access_changes_location_id_changed_at_idx"
    ON "location_access_changes" ("location_id", "changed_at" DESC);

ALTER TABLE "location_access_changes"
    ADD CONSTRAINT "location_access_changes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "location_access_changes"
    ADD CONSTRAINT "location_access_changes_changed_by_user_id_fkey"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "location_access_changes"
    ADD CONSTRAINT "location_access_changes_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same reasoning as the ledger: a history that can be rewritten is not a
-- history. Reuses the trigger function from migration 0002.
CREATE TRIGGER "location_access_changes_immutable"
    BEFORE UPDATE OR DELETE ON "location_access_changes"
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
