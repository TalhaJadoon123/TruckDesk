import { GroqClient, parseBrokerEmail } from '@truckdesk/llm';

/**
 * Parser probe. Not part of the test suite: this is the tool for inspecting what
 * the deterministic parser does with a real broker email while tuning it.
 *
 *   pnpm --filter @truckdesk/llm probe
 */

const email = {
  from: 'dispatch@midwestfreight.com',
  subject: 'Tender - Columbus OH to Pittsburgh PA',
  body: [
    'Load: Columbus, OH to Pittsburgh, PA',
    'Rate: $1,850.00 flat',
    'Miles: 185',
    'Weight: 38,000 lbs',
    'Pickup: tomorrow 08:00',
    'Delivery: 2026-10-06',
  ].join('\n'),
  receivedAt: '2026-10-03T12:00:00.000Z',
};

const result = await parseBrokerEmail(email, new GroqClient({}), {});

if (!result.ok) {
  console.error('parse failed:', result.error.message);
  process.exit(1);
}

const { value } = result;
console.log('--- parsed ---');
console.log(JSON.stringify(value.parsed, null, 2));
console.log('\n--- needsReview ---');
console.log(JSON.stringify(value.needsReview, null, 2));
console.log('\n--- confidence (overall) ---');
console.log(value.overallConfidence);
console.log('\n--- load built? ---');
console.log(value.load ? `yes: ${value.load.id}` : 'null');
console.log('\n--- warnings ---');
console.log(value.warnings.join('\n'));