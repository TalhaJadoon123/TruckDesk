import { laneFrom, deterministicParse } from '@truckdesk/llm';

/**
 * Lane-parsing probe. `pnpm --filter @truckdesk/llm probe:lane`
 *
 * Lane extraction is the step most likely to need tuning against real broker
 * emails, and regex work needs a fast way to see what a pattern actually matched.
 */

const CASES = [
  { label: 'subject, no comma', email: { subject: 'Tender - Columbus OH to Pittsburgh PA', body: '' } },
  { label: 'labelled, with state codes', email: { subject: '', body: 'Load: Columbus, OH to Pittsburgh, PA' } },
  { label: 'labelled, no commas', email: { subject: '', body: 'Load: Memphis TN to Nashville TN' } },
  { label: 'arrow form', email: { subject: '', body: 'Route: DFW -> Atlanta' } },
  { label: 'slash form', email: { subject: '', body: 'Route: Memphis TN / Nashville TN' } },
  { label: 'RE line', email: { subject: '', body: 'RE: Tender - Columbus OH to Pittsburgh PA' } },
  { label: 'sentence containing to', email: { subject: '', body: 'Load: Please deliver to Columbus, OH' } },
];

for (const testCase of CASES) {
  const lane = laneFrom(testCase.email);
  console.log(`${testCase.label.padEnd(30)} -> ${lane ? `${lane.origin} -> ${lane.destination}` : 'null'}`);
}

console.log('\nfull deterministic parse of a labelled, comma-less lane:');
const parsed = deterministicParse(
  { subject: '', body: 'Load: Memphis TN to Nashville TN\nRate: 2400' },
  '2026-03-16T14:00:00.000Z',
);
console.log(`  origin      ${parsed.origin}`);
console.log(`  destination ${parsed.destination}`);
console.log(`  rate        ${parsed.rateDollars}`);