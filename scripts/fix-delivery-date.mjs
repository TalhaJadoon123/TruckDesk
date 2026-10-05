import fs from 'node:fs';

/**
 * Teach the email parser that a delivery *date* means "by end of that day".
 *
 * A broker writing "Delivery: 2026-10-06" alongside "Pickup: tomorrow 08:00"
 * describes a same-day delivery. Resolved literally the delivery is midnight,
 * which lands before the pickup and the load is rejected as impossible. The
 * fix belongs here, at the point the date is resolved, because that is where
 * the information about whether a time was present is still available.
 */

const target = 'packages/llm/src/broker-email.ts';
let text = fs.readFileSync(target, 'utf8');
let applied = 0;

/* 1. thread an `endOfDay` hint through firstDateMatch ------------------- */

const oldFirstDateMatch = `function firstDateMatch(
  text: string,
  patterns: RegExp[],
  receivedAt: Iso,
): Iso | null {`;

const newFirstDateMatch = `function firstDateMatch(
  text: string,
  patterns: RegExp[],
  receivedAt: Iso,
  /**
   * When true, a value that carried no time of day is pushed to 23:59:59.
   * Delivery and drop-off dates are deadlines, not instants: "deliver 03/18"
   * means the freight is there some time on the 18th.
   */
  endOfDay = false,
): Iso | null {`;

if (text.includes(oldFirstDateMatch)) {
  text = text.replace(oldFirstDateMatch, newFirstDateMatch);
  applied += 1;
  console.log('firstDateMatch signature');
} else {
  console.log('skip: firstDateMatch signature');
}

/* 2. apply it to the resolved value ------------------------------------- */

const oldResolve = `      const raw = match[1] ?? match[0];
      const resolved = resolveDate(raw.trim(), receivedAt);
      if (resolved) return resolved;
      match = re.exec(text);`;

const newResolve = `      const raw = match[1] ?? match[0];
      const resolved = resolveDate(raw.trim(), receivedAt);
      if (resolved) return endOfDay && !raw.includes(':') ? toEndOfDay(resolved) : resolved;
      match = re.exec(text);`;

if (text.includes(oldResolve)) {
  text = text.replace(oldResolve, newResolve);
  applied += 1;
  console.log('firstDateMatch body');
} else {
  console.log('skip: firstDateMatch body');
}

/* 3. the helper ---------------------------------------------------------- */

const oldResolveDateDecl = 'function resolveDate(value: string | null, receivedAt: Iso): Iso | null {';
const newResolveDateDecl = `/** Push a midnight timestamp to the end of its day. */
function toEndOfDay(iso: Iso): Iso {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  date.setUTCHours(23, 59, 59, 999);
  return date.toISOString();
}

function resolveDate(value: string | null, receivedAt: Iso): Iso | null {`;

if (text.includes(oldResolveDateDecl)) {
  text = text.replace(oldResolveDateDecl, newResolveDateDecl);
  applied += 1;
  console.log('toEndOfDay helper');
} else {
  console.log('skip: toEndOfDay helper');
}

/* 4. call it for the delivery date -------------------------------------- */

const oldDelivery = `      /\\bdeliver\\s+(?:by|on)?\\s*(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|\\d{4}-\\d{2}-\\d{2})/i,
    ],
    receivedAt,
  );`;

const newDelivery = `      /\\bdeliver\\s+(?:by|on)?\\s*(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|\\d{4}-\\d{2}-\\d{2})/i,
    ],
    receivedAt,
    true,
  );`;

if (text.includes(oldDelivery)) {
  text = text.replace(oldDelivery, newDelivery);
  applied += 1;
  console.log('delivery date uses end-of-day');
} else {
  console.log('skip: delivery date end-of-day');
}

fs.writeFileSync(target, text, 'utf8');
console.log(`applied ${applied} change(s)`);