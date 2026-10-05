import { parseCsv, importCsv } from '@truckdesk/loads';

/**
 * CSV probe. Broker exports are messy: unbalanced quotes, ragged rows, blank
 * lines, Windows line endings. This feeds each of those to the importer.
 *
 *   npx tsx src/probe-csv.ts
 */

const CASES: Array<{ name: string; csv: string }> = [
  {
    name: 'well formed',
    csv: 'broker,origin,destination,rate,miles\nMidwest,Columbus OH,Pittsburgh PA,1850,185',
  },
  {
    name: 'quoted field with a comma',
    csv: 'broker,origin,destination,rate,miles\n"Springfield, IL",Columbus OH,Pittsburgh PA,1850,185',
  },
  {
    name: 'unclosed quote (rest of line swallowed)',
    csv: 'broker,origin,destination,rate,miles\n"unclosed,Springfield,IL,2,Eugene,OR,1000,50\n,,,,,\n,B,Springfield,IL,1000,50',
  },
  {
    name: 'ragged row with too few cells',
    csv: 'broker,origin,destination,rate,miles\nB,Columbus OH,Pittsburgh PA,1850\nC,Dayton OH,Indianapolis IN,900,80',
  },
  {
    name: 'blank lines everywhere',
    csv: '\n\nbroker,origin,destination,rate,miles\n\n\nB,Columbus OH,Pittsburgh PA,1850,185\n\n',
  },
  {
    name: 'CRLF line endings',
    csv: 'broker,origin,destination,rate,miles\r\nB,Columbus OH,Pittsburgh PA,1850,185\r\n',
  },
  {
    name: 'header only',
    csv: 'broker,origin,destination,rate,miles',
  },
  {
    name: 'completely empty',
    csv: '',
  },
  {
    name: 'numeric rate as text and as a bare dollar figure',
    csv: 'broker,origin,destination,rate,miles\nA,Columbus OH,Pittsburgh PA,"$1,850.00",185\nB,Dayton OH,Indianapolis IN,900,80',
  },
  {
    name: 'header with spaces and mixed case',
    csv: 'Broker Name,Origin City,Dest City,Pay,Distance\nMidwest,Columbus OH,Pittsburgh PA,1850,185',
  },
];

let failures = 0;

for (const testCase of CASES) {
  const label = `${testCase.name.padEnd(50)}`;
  try {
    const rows = parseCsv(testCase.csv);
    const result = importCsv(testCase.csv);
    const ok = Number.isFinite(result.totalRows) && Number.isFinite(result.valid);
    if (!ok) failures += 1;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${label} rows=${rows.length} valid=${result.valid} failed=${result.failed}`,
    );
  } catch (error) {
    failures += 1;
    console.log(`${'FAIL'} ${label} threw ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${failures === 0 ? 'csv parser is robust' : `${failures} csv case(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);