import { DIRECTION, MOVEMENT_TYPE } from '@stock/shared';
import { Prisma } from '@prisma/client';
import type { Direction, MovementType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/AppError.js';

/**
 * ===========================================================================
 * THE CORE OF THIS PROJECT.
 *
 * This file is the only place in the codebase permitted to write to
 * `stock_balances`. Read the four stock rules in CLAUDE.md before changing
 * anything here.
 * ===========================================================================
 */

export type AppendMovementInput = {
  itemId: string;
  locationId: string;
  direction: Direction;
  /** Magnitude, always > 0. Validated at the route boundary before it gets here. */
  quantity: number;
  recordedByUserId: string;
  movementType?: MovementType;
  occurredAt?: Date;
  reference?: string | null;
  note?: string | null;
  reversesMovementId?: string | null;
  transferGroupId?: string | null;
  stockTakeId?: string | null;
  idempotencyKey?: string | null;
};

export type AppendMovementResult = {
  movementId: string;
  balanceAfter: number;
};

/**
 * Appends one movement and moves the balance with it, atomically.
 *
 * ### Why this is written the way it is
 *
 * The obvious implementation — read the balance, check it is enough, then write
 * — is the bug this entire POC exists to prevent. Two requests both read 1,
 * both conclude "enough", both write, and the shelf goes to -1.
 *
 * So there is no read, and no decision in application code. The check and the
 * change are a single statement whose WHERE clause carries the condition:
 *
 *     UPDATE ... SET quantity = quantity + $signed
 *     WHERE item_id = $1 AND location_id = $2 AND quantity + $signed >= 0
 *
 * Postgres takes a row-level exclusive lock for the duration of that UPDATE. A
 * second concurrent transaction targeting the same row blocks until the first
 * commits, then re-evaluates its WHERE against the newly committed value (the
 * re-check semantics of UPDATE under READ COMMITTED). It therefore sees 0,
 * matches no row, and is rejected. There is no interval in which both
 * transactions believe the unit is theirs.
 *
 * Zero rows returned means "refused". One row means "done".
 *
 * Note this same statement serves stock-in: for an IN, `$signed` is positive
 * and the condition is trivially satisfied. One path, one set of guarantees.
 */
export async function appendMovement(
  input: AppendMovementInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<AppendMovementResult> {
  const signed = input.direction === DIRECTION.IN ? input.quantity : -input.quantity;

  const run = async (tx: Prisma.TransactionClient) => {
    // The balance row must exist before it can be locked. An item's first-ever
    // movement has no row yet, and a missing row would otherwise be
    // indistinguishable from "no stock" for an IN as well as an OUT.
    //
    // ON CONFLICT DO NOTHING makes this safe when two first-time writers arrive
    // together: one inserts, the other no-ops, and both proceed to the UPDATE
    // below where the real arbitration happens.
    await tx.$executeRaw`
      INSERT INTO stock_balances (item_id, location_id, quantity, updated_at)
      VALUES (${input.itemId}::uuid, ${input.locationId}::uuid, 0, now())
      ON CONFLICT (item_id, location_id) DO NOTHING
    `;

    // --- the guarantee (FR-4.3) ---
    const updated = await tx.$queryRaw<{ quantity: number }[]>`
      UPDATE stock_balances
      SET quantity = quantity + ${signed}, updated_at = now()
      WHERE item_id = ${input.itemId}::uuid
        AND location_id = ${input.locationId}::uuid
        AND quantity + ${signed} >= 0
      RETURNING quantity
    `;

    if (updated.length === 0) {
      // Refused. Read the current figure only now, purely to tell the operator
      // how many there actually are — this read decides nothing.
      const [current] = await tx.$queryRaw<{ quantity: number }[]>`
        SELECT quantity FROM stock_balances
        WHERE item_id = ${input.itemId}::uuid AND location_id = ${input.locationId}::uuid
      `;
      throw AppError.insufficientStock({
        itemId: input.itemId,
        locationId: input.locationId,
        requested: input.quantity,
        available: current?.quantity ?? 0,
      });
    }

    const movement = await tx.movement.create({
      data: {
        itemId: input.itemId,
        locationId: input.locationId,
        direction: input.direction,
        quantity: input.quantity,
        signedQuantity: signed,
        movementType: input.movementType ?? MOVEMENT_TYPE.NORMAL,
        recordedByUserId: input.recordedByUserId,
        occurredAt: input.occurredAt ?? new Date(),
        reference: input.reference ?? null,
        note: input.note ?? null,
        reversesMovementId: input.reversesMovementId ?? null,
        transferGroupId: input.transferGroupId ?? null,
        stockTakeId: input.stockTakeId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      select: { id: true },
    });

    return { movementId: movement.id, balanceAfter: updated[0]!.quantity };
  };

  // Already inside a transaction (a transfer's two legs, a batch stock-take)?
  // Join it, so the caller's atomicity covers this too.
  if (isTransactionClient(client)) return run(client);

  return prisma.$transaction(run, {
    // READ COMMITTED deliberately. The conditional UPDATE above already
    // provides mutual exclusion through its row lock; SERIALIZABLE would add
    // serialisation failures and a retry loop for no additional guarantee.
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: 10_000,
  });
}

/**
 * Discards the balance rows of an item that has no movements.
 *
 * This lives here, rather than in the item service that calls it, because this
 * file is the only place permitted to write `stock_balances` — and a deletion
 * is a write. Putting it anywhere else would mean either a second module
 * touching the table or an eslint-disable, and both are the beginning of rule 4
 * being true only approximately.
 *
 * Safe only under the caller's precondition: no movements reference the item.
 * With no ledger behind them the rows are necessarily zero, so removing them
 * discards nothing the ledger could have reconstructed (FR-1.4).
 */
export async function deleteBalancesForItem(
  itemId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.stockBalance.deleteMany({ where: { itemId } });
}

/** Current balance for one item at one location. O(1): a single indexed row. */
export async function readBalance(itemId: string, locationId: string): Promise<number> {
  const row = await prisma.stockBalance.findUnique({
    where: { itemId_locationId: { itemId, locationId } },
    select: { quantity: true },
  });
  return row?.quantity ?? 0;
}

/**
 * The same figure, summed from the ledger instead of read from the cache.
 *
 * This is NOT how the application serves reads — it is O(n) in the movement
 * count and grows forever. It exists so the reconciliation job can prove the
 * cached balance still agrees with the ledger (T-14), and so the walkthrough
 * can compare the two query plans side by side (FRD §5.1).
 */
export async function sumBalanceFromLedger(
  itemId: string,
): Promise<{ locationId: string; quantity: number }[]> {
  const rows = await prisma.$queryRaw<{ location_id: string; quantity: bigint }[]>`
    SELECT location_id, SUM(signed_quantity) AS quantity
    FROM movements
    WHERE item_id = ${itemId}::uuid
    GROUP BY location_id
  `;
  return rows.map((r) => ({ locationId: r.location_id, quantity: Number(r.quantity) }));
}

function isTransactionClient(
  client: Prisma.TransactionClient | typeof prisma,
): client is Prisma.TransactionClient {
  // The extended client exposes $transaction; a transaction client does not.
  return !('$transaction' in client);
}
