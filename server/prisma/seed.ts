/**
 * Demo data, so `docker compose up` gives a usable system rather than an empty
 * one (NFR-1).
 *
 * The important constraint: all stock here is created by appending MOVEMENTS
 * through the same code path the API uses. Nothing writes `stock_balances`
 * directly — a seed that cheats would quietly disprove the guarantee the rest
 * of the project is built on (stock rule 4 in CLAUDE.md).
 */
import argon2 from 'argon2';
import { PrismaClient, type UnitOfMeasure } from '@prisma/client';
import { appendMovement } from '../src/modules/movements/repository.js';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Password123!';

async function main() {
  console.log('Seeding…');

  // --- Locations ---------------------------------------------------------
  const locationSpecs = [
    { code: 'WH-A', name: 'Main Warehouse A' },
    { code: 'WH-B', name: 'Main Warehouse B' },
    { code: 'SITE-1', name: 'Site 1 Store' },
    { code: 'SITE-2', name: 'Site 2 Store' },
  ];
  const locations = await Promise.all(
    locationSpecs.map((l) =>
      prisma.location.upsert({ where: { code: l.code }, update: {}, create: l }),
    ),
  );
  const byCode = Object.fromEntries(locations.map((l) => [l.code, l]));

  // --- Users -------------------------------------------------------------
  //
  // The two handlers get DISJOINT location access on purpose: the
  // wrong-location test (T-4) needs a handler who genuinely cannot reach a
  // location that genuinely exists.
  const passwordHash = await argon2.hash(DEMO_PASSWORD);

  const manager = await prisma.user.upsert({
    where: { email: 'manager@stock.local' },
    update: {},
    create: { email: 'manager@stock.local', name: 'Meera Nair', role: 'MANAGER', passwordHash },
  });

  const handlerA = await prisma.user.upsert({
    where: { email: 'handler.a@stock.local' },
    update: {},
    create: { email: 'handler.a@stock.local', name: 'Raj Patel', role: 'HANDLER', passwordHash },
  });

  const handlerB = await prisma.user.upsert({
    where: { email: 'handler.b@stock.local' },
    update: {},
    create: { email: 'handler.b@stock.local', name: 'Priya Shah', role: 'HANDLER', passwordHash },
  });

  // Handler A: warehouses only. Handler B: sites only. No overlap.
  const grants: [string, string[]][] = [
    [handlerA.id, ['WH-A', 'WH-B']],
    [handlerB.id, ['SITE-1', 'SITE-2']],
  ];
  for (const [userId, codes] of grants) {
    for (const code of codes) {
      await prisma.userLocationAccess.upsert({
        where: { userId_locationId: { userId, locationId: byCode[code]!.id } },
        update: {},
        create: { userId, locationId: byCode[code]!.id },
      });
    }
  }
  // A manager needs no rows here — the role grants every location (AC-5).

  // --- Items -------------------------------------------------------------
  const itemSpecs: { sku: string; name: string; unit: UnitOfMeasure; threshold: number }[] = [
    { sku: 'GLV-NIT-M', name: 'Nitrile gloves (medium)', unit: 'BOX', threshold: 20 },
    { sku: 'GLV-NIT-L', name: 'Nitrile gloves (large)', unit: 'BOX', threshold: 20 },
    { sku: 'CEM-OPC-50', name: 'Cement OPC 50kg bag', unit: 'EACH', threshold: 40 },
    { sku: 'SND-RIV-T', name: 'River sand', unit: 'KG', threshold: 500 },
    { sku: 'TNR-HP-26A', name: 'Toner cartridge HP 26A', unit: 'EACH', threshold: 3 },
    { sku: 'TNR-HP-05A', name: 'Toner cartridge HP 05A', unit: 'EACH', threshold: 3 },
    { sku: 'PPR-A4-80', name: 'A4 paper 80gsm', unit: 'PACK', threshold: 25 },
    { sku: 'HLM-SAF-WH', name: 'Safety helmet (white)', unit: 'EACH', threshold: 15 },
    { sku: 'VST-HIV-XL', name: 'Hi-vis vest XL', unit: 'EACH', threshold: 10 },
    { sku: 'DSL-FUEL', name: 'Diesel fuel', unit: 'LITRE', threshold: 200 },
    { sku: 'CBL-ELE-25', name: 'Electrical cable 2.5mm', unit: 'METRE', threshold: 300 },
    { sku: 'TAP-DUC-48', name: 'Duct tape 48mm', unit: 'EACH', threshold: 12 },
    { sku: 'SCR-WD-50', name: 'Wood screws 50mm', unit: 'BOX', threshold: 8 },
    { sku: 'PNT-EMU-20', name: 'Emulsion paint 20L', unit: 'EACH', threshold: 6 },
    { sku: 'BRS-PNT-4', name: 'Paint brush 4 inch', unit: 'EACH', threshold: 10 },
    { sku: 'MSK-N95', name: 'N95 dust mask', unit: 'BOX', threshold: 15 },
    { sku: 'GOG-SAF-CL', name: 'Safety goggles (clear)', unit: 'EACH', threshold: 12 },
    { sku: 'BLT-M12-70', name: 'Bolts M12x70', unit: 'BOX', threshold: 10 },
    { sku: 'WLD-ROD-32', name: 'Welding rods 3.2mm', unit: 'KG', threshold: 25 },
    { sku: 'OIL-HYD-20', name: 'Hydraulic oil 20L', unit: 'EACH', threshold: 4 },
    { sku: 'FLT-AIR-STD', name: 'Air filter (standard)', unit: 'EACH', threshold: 6 },
    { sku: 'BAT-AA-PK', name: 'AA batteries', unit: 'PACK', threshold: 20 },
    { sku: 'LMP-LED-9W', name: 'LED lamp 9W', unit: 'EACH', threshold: 30 },
    { sku: 'SLV-SIL-300', name: 'Silicone sealant 300ml', unit: 'EACH', threshold: 18 },
    { sku: 'RAG-CTN-KG', name: 'Cotton rags', unit: 'KG', threshold: 10 },
  ];

  const items = await Promise.all(
    itemSpecs.map((i) =>
      prisma.item.upsert({
        where: { sku: i.sku },
        update: {},
        create: {
          sku: i.sku,
          name: i.name,
          unitOfMeasure: i.unit,
          minThreshold: i.threshold,
        },
      }),
    ),
  );

  // --- Stock, created only through movements ------------------------------
  //
  // Skipped entirely if movements already exist, so re-running the seed does
  // not silently double every balance.
  const existing = await prisma.movement.count();
  if (existing > 0) {
    console.log(`Ledger already holds ${existing} movements — leaving stock untouched.`);
    await report();
    return;
  }

  const handlerFor = (code: string) => (code.startsWith('WH-') ? handlerA.id : handlerB.id);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  let ins = 0;
  let outs = 0;

  for (const [index, item] of items.entries()) {
    for (const [locIndex, location] of locations.entries()) {
      // Deterministic but varied: some pairs are well stocked, some sit right
      // on their threshold, and a few are empty — so the low-stock view has
      // something real to show on first load, and the race demo has a
      // single-unit item to work with.
      const seedQty = ((index * 7 + locIndex * 13) % 9) * 15;
      if (seedQty === 0) continue;

      await appendMovement({
        itemId: item.id,
        locationId: location.id,
        direction: 'IN',
        quantity: seedQty,
        recordedByUserId: handlerFor(location.code),
        occurredAt: daysAgo(30 - locIndex),
        reference: `PO #${4500 + index}`,
        note: 'Opening stock',
      });
      ins++;

      // Issue some of it back out, so histories are not all one-directional.
      const issued = Math.floor(seedQty / 3);
      if (issued > 0) {
        await appendMovement({
          itemId: item.id,
          locationId: location.id,
          direction: 'OUT',
          quantity: issued,
          recordedByUserId: handlerFor(location.code),
          occurredAt: daysAgo(10 - locIndex),
          note: `Issued to ${location.name}`,
        });
        outs++;
      }
    }
  }

  // One item deliberately left at exactly 1 unit at WH-A, so the race demo
  // (UI-9) and a manual walkthrough have a last unit to fight over.
  const raceItem = items.find((i) => i.sku === 'TNR-HP-26A')!;
  const whA = byCode['WH-A']!;
  const current = await prisma.stockBalance.findUnique({
    where: { itemId_locationId: { itemId: raceItem.id, locationId: whA.id } },
  });
  const surplus = (current?.quantity ?? 0) - 1;
  if (surplus > 0) {
    await appendMovement({
      itemId: raceItem.id,
      locationId: whA.id,
      direction: 'OUT',
      quantity: surplus,
      recordedByUserId: handlerA.id,
      occurredAt: daysAgo(1),
      note: 'Drawn down to a single unit for the concurrency demo',
    });
    outs++;
  } else if (surplus < 0) {
    await appendMovement({
      itemId: raceItem.id,
      locationId: whA.id,
      direction: 'IN',
      quantity: -surplus,
      recordedByUserId: handlerA.id,
      occurredAt: daysAgo(1),
      note: 'Topped up to a single unit for the concurrency demo',
    });
    ins++;
  }

  console.log(`  ${ins} stock-in and ${outs} stock-out movements appended.`);
  await report();
}

async function report() {
  const [items, locations, movements, lowStock] = await Promise.all([
    prisma.item.count(),
    prisma.location.count(),
    prisma.movement.count(),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM stock_balances b
      JOIN items i ON i.id = b.item_id
      WHERE b.quantity <= i.min_threshold`,
  ]);

  console.log(`
Seed complete.
  ${items} items across ${locations} locations, ${movements} movements.
  ${Number(lowStock[0]?.count ?? 0)} item/location pairs are at or below threshold.

  Sign in with password: ${DEMO_PASSWORD}
    manager@stock.local     MANAGER — every location
    handler.a@stock.local   HANDLER — WH-A, WH-B only
    handler.b@stock.local   HANDLER — SITE-1, SITE-2 only

  TNR-HP-26A at WH-A is seeded to exactly 1 unit, for the race demo.
`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
