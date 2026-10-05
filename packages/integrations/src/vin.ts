import {
  HttpClient,
  SOURCES,
  failed,
  ok,
  type IntegrationResult,
} from './client.js';

/**
 * VIN decoding via NHTSA vPIC.
 *
 * Public domain, no key. A dispatcher keying in a truck gets the model, the GVWR
 * and the year for free, which is exactly the data `trucks.maxWeightLbs` needs
 * to check a load against, and it removes the most tedious field on the truck
 * setup screen.
 */

export interface VinDetails {
  vin: string;
  /** Trimmed for display: "2021 Freightliner Cascadia 126". */
  description: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  series: string | null;
  bodyClass: string | null;
  driveType: string | null;
  /** Engine litres, as reported. */
  engineDisplacementL: number | null;
  engineCylinders: number | null;
  electrificationLevel: number | null;
  manufacturedIn: string | null;
  plantCountry: string | null;
  plantState: string | null;
  /** GVWR in pounds, converted from the reported kilograms. */
  grossVehicleWeightLbs: number | null;
  source: string;
}

interface VpicResponse {
  Results?: Array<{
    VIN?: string;
    ErrorCode?: string;
    ErrorText?: string;
    Make?: string;
    Model?: string;
    ModelYear?: string;
    TrimLevel?: string;
    Series?: string;
    Series2?: string;
    BodyClass?: string;
    DriveType?: string;
    EngineDisplacement?: string;
    EngineCylinders?: string;
    ElectrificationLevel?: string;
    ManufacturerCountry?: string;
    PlantCountry?: string;
    PlantState?: string;
    GVWR?: string;
    GVWR_CH?: string;
    GVWR_Chassis?: string;
  }>;
}

/** A VIN is 17 characters, excluding I, O and Q. */
export function isValidVinFormat(vin: string): boolean {
  const value = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(value)) return false;
  return true;
}

export class VinDecoder {
  private readonly client: HttpClient;

  constructor(client?: HttpClient) {
    this.client = client ?? new HttpClient({ ttlMs: 30 * 86_400_000 });
  }

  async decode(vin: string): Promise<IntegrationResult<VinDetails>> {
    const value = vin.trim().toUpperCase();

    if (!isValidVinFormat(value)) {
      return failed('vpic', 'A VIN is 17 characters and cannot contain I, O or Q');
    }

    const url = `${SOURCES.vpic}/${encodeURIComponent(value)}?format=json`;
    const payload = await this.client.getJson<VpicResponse>(url);

    const result = payload?.Results?.[0];
    if (!result) return failed('vpic', 'No decode result');

    if (result.ErrorCode && result.ErrorCode !== '0' && result.ErrorCode !== '') {
      return failed('vpic', result.ErrorText ?? `vPIC error ${result.ErrorCode}`);
    }

    const year = toInteger(result.ModelYear);
    const description = [result.ModelYear, result.Make, result.Model, trimOf(result.TrimLevel)]
      .filter(Boolean)
      .join(' ');

    return ok(
      {
        vin: value,
        description: description.length > 0 ? description : null,
        year,
        make: trimOf(result.Make),
        model: trimOf(result.Model),
        series: trimOf(result.Series) ?? trimOf(result.Series2),
        bodyClass: trimOf(result.BodyClass),
        driveType: trimOf(result.DriveType),
        engineDisplacementL: toNumber(result.EngineDisplacement),
        engineCylinders: toInteger(result.EngineCylinders),
        electrificationLevel: toInteger(result.ElectrificationLevel),
        manufacturedIn: trimOf(result.ManufacturerCountry) ?? trimOf(result.PlantCountry),
        plantCountry: trimOf(result.PlantCountry),
        plantState: trimOf(result.PlantState),
        // vPIC reports GVWR in kilograms for most vehicles.
        grossVehicleWeightLbs: kilogramsToPounds(toNumber(result.GVWR ?? result.GVWR_CH ?? result.GVWR_Chassis)),
        source: 'nhtsa-vpic',
      },
      'nhtsa-vpic',
    );
  }

  /**
   * The payload a truck form needs, so the UI can offer a "Look up" button that
   * fills in make, model, year and weight in one call.
   */
  async toTruckFields(
    vin: string,
  ): Promise<IntegrationResult<{ year?: number; make?: string; model?: string; maxWeightLbs?: number }>> {
    const decoded = await this.decode(vin);
    if (!decoded.data) return failed('nhtsa-vpic', decoded.error ?? 'Decode failed');

    const fields: { year?: number; make?: string; model?: string; maxWeightLbs?: number } = {};
    if (decoded.data.year !== null) fields.year = decoded.data.year;
    if (decoded.data.make) fields.make = decoded.data.make;
    if (decoded.data.model) fields.model = decoded.data.model;
    if (decoded.data.grossVehicleWeightLbs !== null) {
      fields.maxWeightLbs = decoded.data.grossVehicleWeightLbs;
    }

    return ok(fields, decoded.data.source);
  }
}

function trimOf(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value: string | undefined): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

/**
 * vPIC reports GVWR in kilograms for most vehicles, but in pounds for some
 * light ones. The two ranges are disjoint in practice: the heaviest US Class 8
 * tractor is 80,000 lb, which is 36,287 kg, so any value above that cannot be
 * kilograms. A 20,000 reading is 44,000 lb, which is a normal Cascadia - reading
 * it as pounds would understate the truck by half and let an overweight load
 * through the capacity check.
 */
const MAX_GVWR_KILOGRAMS = 36_300;

function kilogramsToPounds(value: number | null): number | null {
  if (value === null) return null;
  if (value > MAX_GVWR_KILOGRAMS) return Math.round(value);
  return Math.round(value * 2.20462);
}