/**
 * Prompts for the broker email parser.
 *
 * Kept in one file so they can be reviewed and diffed without reading code, and
 * so a prompt change is a one-line diff in review.
 */

export const BROKER_EMAIL_SYSTEM = `You extract freight load details from broker emails and shipping documents.

Return ONLY a JSON object with exactly these keys:
{
  "broker": string | null,
  "reference": string | null,
  "origin": string | null,
  "destination": string | null,
  "commodity": string | null,
  "equipment": "dry_van" | "reefer" | "flatbed" | "step_deck" | "tanker" | "box_truck" | "power_only" | null,
  "rate": number | null,
  "rateType": "flat" | "per_mile" | "per_load" | null,
  "miles": number | null,
  "weightLbs": number | null,
  "pickupDate": string | null,
  "deliveryDate": string | null,
  "pickupWindowStart": string | null,
  "pickupWindowEnd": string | null,
  "commodityRequiresTemp": boolean | null,
  "stops": Array<{ "type": "pickup" | "delivery", "facilityName": string | null, "city": string | null, "state": string | null, "address": string | null }> | null,
  "confirmationCode": string | null,
  "accessorialNotes": string | null
}

Rules:
- Use null for anything the email does not state. Never guess a rate, a date, or a city.
- Dates: output ISO 8601 (YYYY-MM-DD) when you can resolve it, otherwise copy the email's own text verbatim.
- Numbers: plain digits, no currency symbols or commas. rate is the total all-in dollars (e.g. 2450 for $2,450.00). miles and weightLbs are numbers.
- The origin is where the freight is picked up. The destination is where it is delivered.
- Multi-stop loads: put every stop in "stops" in the order given.
- Output the JSON object only. No markdown fence, no commentary.`;

export const BROKER_EMAIL_USER_PREFIX =
  'Extract load details from this email: origin, destination, rate, weight, pickup date, delivery date. Output JSON.\n\n';

export function buildBrokerEmailPrompt(email: {
  subject?: string;
  from?: string;
  body: string;
}): { system: string; user: string } {
  const header: string[] = [];
  if (email.subject) header.push(`Subject: ${email.subject}`);
  if (email.from) header.push(`From: ${email.from}`);
  header.push('', '---', '');

  return {
    system: BROKER_EMAIL_SYSTEM,
    user: `${BROKER_EMAIL_USER_PREFIX}${header.join('\n')}${email.body}`,
  };
}

/** Ask the model to repair JSON it wrote that failed validation. */
export const JSON_REPAIR_PROMPT = `Your previous output was not valid JSON for the requested schema.

Fix it and output ONLY the corrected JSON object. Preserve every value you correctly extracted; do not invent new ones. If a value was null it stays null.

Previous output:
`;