import 'dotenv/config';

import { createServices } from '../services/container.js';
import { hashPassword } from '../auth.js';
import { DEMO_COMPANY_ID, DEMO_OWNER, DEMO_PASSWORD, seedDemoCompany } from './demo-company.js';

/**
 * Seed entry point.
 *
 * Runs the demo company and, when a database is configured, writes the owning
 * account so `dispatcher@ridgewayfreight.com` can sign in through Auth.js. With
 * no database it still seeds the in-memory store, which is what makes
 * `pnpm dev` show a populated board on a laptop with nothing configured.
 */
async function main(): Promise<void> {
  const services = createServices();

  console.log('\nTruckDesk seed\n===============');
  console.log(`Mode:     ${services.memory ? 'in-memory (no DATABASE_URL)' : 'postgres'}`);
  console.log(`LLM:      ${services.llm.isLive() ? services.env.GROQ_MODEL : 'deterministic parser'}`);
  console.log('');

  // Print the progress lines, but not the trailing summary: this script prints
  // that itself at the end, with the account details merged in.
  const result = await seedDemoCompany({ printSummary: false });

  if (services.db) {
    const schema = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const now = new Date();

    const existingCompany = await services.db
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(eq(schema.companies.id, DEMO_COMPANY_ID))
      .limit(1);

    if (existingCompany.length === 0) {
      await services.db.insert(schema.companies).values({
        id: DEMO_COMPANY_ID,
        name: 'Ridgeway Freight LLC',
        mcNumber: 'MC-847201',
        dotNumber: 'DOT-3391782',
        plan: 'business',
        subscriptionStatus: 'active',
        timezone: 'America/New_York',
        homeTerminal: 'Columbus, OH',
        billingEmail: DEMO_OWNER.email,
        createdAt: now,
        updatedAt: now,
      });
      console.log('  company row created');
    } else {
      console.log('  company row already exists');
    }

    const existingUser = await services.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, DEMO_OWNER.email))
      .limit(1);

    if (existingUser.length === 0) {
      await services.db.insert(schema.users).values({
        id: 'us_seed_owner',
        companyId: DEMO_COMPANY_ID,
        email: DEMO_OWNER.email,
        name: DEMO_OWNER.name,
        role: 'owner',
        passwordHash: await hashPassword(DEMO_PASSWORD),
        plan: 'business',
        emailVerified: true,
        timezone: 'America/New_York',
        createdAt: now,
        updatedAt: now,
      });
      console.log('  owner account created');
    } else {
      console.log('  owner account already exists');
    }

    // Driver logins for the mobile app. One shared password, so a driver can be
    // handed a phone and signed in at the yard without a provisioning step.
    const drivers = services.forCompany(DEMO_COMPANY_ID);
    const allDrivers = await drivers.drivers.query(DEMO_COMPANY_ID);

    const existingDriverUsers = await services.db
      .select({ driverId: schema.users.driverId })
      .from(schema.users)
      .where(eq(schema.users.companyId, DEMO_COMPANY_ID));

    const known = new Set(
      existingDriverUsers
        .map((row) => row.driverId)
        .filter((id): id is string => typeof id === 'string'),
    );

    const passwordHash = await hashPassword(DEMO_PASSWORD);
    let created = 0;

    for (const driver of allDrivers) {
      if (known.has(driver.id)) continue;
      await services.db.insert(schema.users).values({
        id: `us_${driver.id}`,
        companyId: DEMO_COMPANY_ID,
        email: driver.email ?? `${driver.id}@ridgewayfreight.com`,
        name: driver.name,
        role: 'driver',
        driverId: driver.id,
        passwordHash,
        plan: 'business',
        emailVerified: true,
        phone: driver.phone ?? null,
        timezone: 'America/New_York',
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }
    console.log(`  ${created} driver accounts created (${allDrivers.length} drivers total)`);
  } else {
    console.log('  No DATABASE_URL: the owner account was not written.');
    console.log('  The in-memory board is seeded and resets on restart.');
  }

  console.log('');
  for (const line of result.summary) console.log(`  ${line}`);
  console.log('');
  console.log('  Next: pnpm dev, then open http://localhost:3000\n');

  await services.close();
}

main().catch((error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});