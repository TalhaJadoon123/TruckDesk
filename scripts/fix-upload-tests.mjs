import fs from 'node:fs';
import path from 'node:path';

/**
 * Correct four assertions in the upload/input test file that encoded my own
 * wrong expectations rather than correct behaviour:
 *
 *   1. the storage key is rebuilt, so a prefix is not an equality
 *   2. half the circumference is ~12,437 miles, not 19,000
 *   3. a fully blank CSV row is skipped, not reported as a rejected row
 *   4. a POD without a receiver signature must still block delivery
 *
 *   node scripts/fix-upload-tests.mjs
 */

const target = path.join(process.cwd(), 'tests/uploads-and-inputs.test.ts');
let text = fs.readFileSync(target, 'utf8');

const swaps = [
  [
    `    expect(result.value.storageKey).toBe(\`\${SCOPE.companyId}/\${SCOPE.loadId}/dc_\`);
    expect(result.value.storageKey.startsWith(\`\${SCOPE.companyId}/\${SCOPE.loadId}/\`)).toBe(true);`,
    `    // The client never chooses the key; it is rebuilt inside our own scope.
    expect(result.value.storageKey).toMatch(
      new RegExp(\`^\${SCOPE.companyId}/\${SCOPE.loadId}/dc_[a-z0-9]+\\\\.jpg\$\`),
    );`,
  ],
  [
    `    expect(miles).toBeGreaterThan(19_000);`,
    `    // Half the circumference of the earth is ~12,437 miles.
    expect(miles).toBeGreaterThan(12_000);
    expect(miles).toBeLessThan(13_000);`,
  ],
  [
    `    const result = importCsv('broker,origin,destination,rate,miles\\n,,,,,\\nB,Columbus OH,Pittsburgh PA,1850,185');
    expect(result.failed).toBe(1);
    expect(result.failures[0]?.reason).toMatch(/missing|rate|miles/i);`,
    `    // A row that has content but no usable rate is a real data error.
    const result = importCsv(
      'broker,origin,destination,rate,miles\\nB,Columbus OH,Pittsburgh PA,,185\\nC,Dayton OH,Indianapolis IN,900,80',
    );
    expect(result.failed).toBe(1);
    expect(result.failures[0]?.reason).toMatch(/rate/i);
    expect(result.valid).toBe(1);
  });

  [
    `    expect(result.failed).toBe(1);
    expect(result.failures[0]?.reason).toMatch(/rate/i);
    expect(result.valid).toBe(1);
  });`,
    `    expect(result.failed).toBe(1);
    expect(result.failures[0]?.reason).toMatch(/rate/i);
    expect(result.valid).toBe(1);
  });

  it('does not report blank rows as errors', () => {
    const result = importCsv('broker,origin,destination,rate,miles\\n\\nB,Columbus OH,Pittsburgh PA,1850,185\\n\\n');
    expect(result.failed).toBe(0);
    expect(result.valid).toBe(1);
  });`,
  ],
  [
    `          mimeType: 'image/jpeg', sizeBytes: 1,
          uploadedBy: 'u', uploadedAt: new Date().toISOString(), status: 'uploaded' as const,
        },
      ],
    };`,
    `          mimeType: 'image/jpeg', sizeBytes: 1,
          uploadedBy: 'u', uploadedAt: new Date().toISOString(),
          // A POD without a receiver signature is not a signed POD.
          signatureName: 'M. Alvarez',
          status: 'uploaded' as const,
        },
      ],
    };`,
  ],
];

let applied = 0;

for (const [from, to] of swaps) {
  if (!text.includes(from)) {
    console.log(`skip (not found): ${from.slice(0, 60).replace(/\n/g, ' ')}`);
    continue;
  }
  text = text.replace(from, to);
  applied += 1;
}

fs.writeFileSync(target, text, 'utf8');
console.log(`applied ${applied} of ${swaps.length} corrections`);