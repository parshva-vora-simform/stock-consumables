-- Initial schema. Generated from prisma/schema.prisma.
-- The guarantees Prisma cannot express (CHECK constraint, append-only
-- triggers) are added in 0002; performance indexes in 0003.


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('EACH', 'KG', 'LITRE', 'METRE', 'BOX', 'PACK');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('NORMAL', 'REVERSAL', 'STOCK_TAKE_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('HANDLER', 'MANAGER');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('ACCEPTED', 'REJECTED_INSUFFICIENT_STOCK', 'REJECTED_VALIDATION', 'REJECTED_FORBIDDEN', 'REJECTED_NOT_FOUND', 'REJECTED_CONFLICT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'HANDLER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_location_access" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_location_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit_of_measure" "UnitOfMeasure" NOT NULL,
    "min_threshold" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movements" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "direction" "Direction" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "signed_quantity" INTEGER NOT NULL,
    "movement_type" "MovementType" NOT NULL DEFAULT 'NORMAL',
    "recorded_by_user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT,
    "note" TEXT,
    "reverses_movement_id" UUID,
    "transfer_group_id" UUID,
    "stock_take_id" UUID,
    "idempotency_key" TEXT,

    CONSTRAINT "movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("item_id","location_id")
);

-- CreateTable
CREATE TABLE "movement_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "item_id" UUID,
    "location_id" UUID,
    "direction" "Direction",
    "quantity" INTEGER,
    "outcome" "AttemptOutcome" NOT NULL,
    "failure_detail" TEXT,
    "resulting_movement_id" UUID,
    "request_id" TEXT NOT NULL,
    "ip_address" TEXT,

    CONSTRAINT "movement_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_takes" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "counted_quantity" INTEGER NOT NULL,
    "system_quantity" INTEGER NOT NULL,
    "counted_by_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_takes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE INDEX "user_location_access_user_id_idx" ON "user_location_access"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_location_access_user_id_location_id_key" ON "user_location_access"("user_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "items_sku_key" ON "items"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "items_name_key" ON "items"("name");

-- CreateIndex
CREATE INDEX "items_is_active_name_idx" ON "items"("is_active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "movements_reverses_movement_id_key" ON "movements"("reverses_movement_id");

-- CreateIndex
CREATE INDEX "movements_item_id_occurred_at_id_idx" ON "movements"("item_id", "occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "movements_item_id_location_id_occurred_at_id_idx" ON "movements"("item_id", "location_id", "occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "movements_item_id_location_id_idx" ON "movements"("item_id", "location_id");

-- CreateIndex
CREATE INDEX "movements_transfer_group_id_idx" ON "movements"("transfer_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "movements_recorded_by_user_id_idempotency_key_key" ON "movements"("recorded_by_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "stock_balances_location_id_quantity_idx" ON "stock_balances"("location_id", "quantity");

-- CreateIndex
CREATE INDEX "movement_attempts_user_id_attempted_at_id_idx" ON "movement_attempts"("user_id", "attempted_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "movement_attempts_item_id_attempted_at_id_idx" ON "movement_attempts"("item_id", "attempted_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "movement_attempts_outcome_attempted_at_idx" ON "movement_attempts"("outcome", "attempted_at" DESC);

-- CreateIndex
CREATE INDEX "stock_takes_item_id_created_at_idx" ON "stock_takes"("item_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "user_location_access" ADD CONSTRAINT "user_location_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location_access" ADD CONSTRAINT "user_location_access_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_reverses_movement_id_fkey" FOREIGN KEY ("reverses_movement_id") REFERENCES "movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_stock_take_id_fkey" FOREIGN KEY ("stock_take_id") REFERENCES "stock_takes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_attempts" ADD CONSTRAINT "movement_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_attempts" ADD CONSTRAINT "movement_attempts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_attempts" ADD CONSTRAINT "movement_attempts_resulting_movement_id_fkey" FOREIGN KEY ("resulting_movement_id") REFERENCES "movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_counted_by_user_id_fkey" FOREIGN KEY ("counted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

