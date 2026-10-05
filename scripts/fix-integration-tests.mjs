import fs from 'node:fs';

/**
 * Correct four assertions in the integrations test that encoded my own wrong
 * expectations rather than the code's correct behaviour:
 *
 *   1. km/h -> mph is rounded to one decimal, so 100 km/h is 62.1 mph
 *   2. and so 24 km/h is 14.9 mph
 *   3. a vPIC `ErrorCode` is a failure, not a success with a null description
 *   4. the GVWR case used an already-pounds value; a 45,000 lb reading is
 *      correctly passed through
 *
 * The GVWR *heuristic* itself was a real bug and is fixed in src/vin.ts; these
 * are only the tests that were wrong about it.
 *
 *   node scripts/fix-integration-tests.mjs
 */

const target = 'tests/integrations.test.ts';
let text = fs.readFileSync(target, 'utf8');
let applied = 0;

const swaps = [
  ["    expect(kmhToMph(100)).toBe(62);", "    // Rounded to one decimal for a truck-speed readout.\n    expect(kmhToMph(100)).toBe(62.1);"],
  ["    expect(kmhToMph(0)).toBe(0);", "    expect(kmhToMph(0)).toBe(0);\n    expect(kmhToMph(Number.NaN)).toBeNull();"],
  ["    expect(kmhToMph(result.data?.windKmh ?? null)).toBe(15);", "    expect(kmhToMph(result.data?.windKmh ?? null)).toBe(14.9);"],
  [
    `    expect(result.ok).toBe(true); // Formatted VIN, no letters I O Q.
    expect(result.data?.description).toBeNull();`,
    `    // A vPIC error code is a failure, and its message must reach the caller.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid VIN/i);`,
  ],
  [
    `      body: { Results: [{ VIN: 'x', GVWR: '45000', Make: 'X', Model: 'Y', ModelYear: '2020' }] },`,
    `      // Above 36,300 kg-equivalent, so already pounds and passed through.
      body: { Results: [{ VIN: 'x', GVWR: '45000', Make: 'X', Model: 'Y', ModelYear: '2020' }] },`,
  ],
];

for (const [from, to] of swaps) {
  if (!text.includes(from)) {
    console.log(`skip: ${from.slice(0, 55).replace(/\n/g, ' ')}`);
    continue;
  }
  text = text.split(from).join(to);
  applied += 1;
}

fs.writeFileSync(target, text, 'utf8');
console.log(`applied ${applied} of ${swaps.length} corrections`);