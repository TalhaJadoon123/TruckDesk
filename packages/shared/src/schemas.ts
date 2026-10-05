/**
 * Runtime validation for everything that crosses a trust boundary: HTTP bodies,
 * LLM output, webhook payloads. Zod v4 (`@truckdesk/shared` re-exports it) so
 * web, api and mobile validate identically.
 */
import { z } from 'zod';

export { z };

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const moneyCentsSchema = z
  .number()
  .int('money must be integer cents')
  .nonnegative('money cannot be negative');

export const isoSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'not a valid ISO timestamp' });

export const trailerTypeSchema = z.enum([
  'dry_van',
  'reefer',
  'flatbed',
  'step_deck',
  'tanker',
  'box_truck',
  'power_only',
]);

export const loadStatusSchema = z.enum(['booked', 'dispatched', 'in-transit', 'delivered', 'paid']);
export const truckStatusSchema = z.enum(['available', 'loaded', 'empty', 'maintenance']);

export const timeWindowSchema = z
  .object({
    start: isoSchema,
    end: isoSchema,
    earlyAccepted: z.boolean().optional(),
    lateAccepted: z.boolean().optional(),
  })
  .refine((w) => Date.parse(w.end) > Date.parse(w.start), {
    message: 'time window end must be after start',
    path: ['end'],
  });

export const loadStopSchema = z.object({
  id: z.string().min(1),
  loadId: z.string().min(1),
  type: z.enum(['pickup', 'delivery', 'waypoint']),
  sequence: z.number().int().min(0),
  facilityName: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string().length(2, 'state must be a 2-letter code'),
  postalCode: z.string().optional(),
  location: geoPointSchema.optional(),
  window: timeWindowSchema.optional(),
  appointmentRequired: z.boolean().optional(),
  appointmentRef: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  status: z.enum(['pending', 'arrived', 'completed', 'skipped']),
  arrivedAt: isoSchema.optional(),
  completedAt: isoSchema.optional(),
  notes: z.string().optional(),
});

export const loadDocumentSchema = z.object({
  id: z.string().min(1),
  loadId: z.string().min(1),
  type: z.enum([
    'rate_con',
    'bol',
    'pod',
    'lumper_receipt',
    'tif',
    'fuel_receipt',
    'damage_photo',
    'driver_signature',
    'w9',
    'insurance_cert',
    'exemption',
  ]),
  fileName: z.string().min(1),
  storageKey: z.string().min(1),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  uploadedBy: z.string(),
  uploadedAt: isoSchema,
  capturedAt: isoSchema.optional(),
  geo: geoPointSchema.optional(),
  signatureName: z.string().optional(),
  signatureDataUrl: z.string().optional(),
  pageCount: z.number().int().optional(),
  status: z.enum(['pending', 'uploaded', 'rejected']),
  rejectReason: z.string().optional(),
});

/**
 * The full `Load` shape: the six required spec fields plus the additive
 * extensions. `rate` is all-in USD cents.
 */
export const loadSchema = z.object({
  id: z.string().min(1),
  broker: z.string().min(1, 'broker is required'),
  origin: z.string().min(1, 'origin is required'),
  destination: z.string().min(1, 'destination is required'),
  rate: moneyCentsSchema,
  miles: z.number().nonnegative(),
  status: loadStatusSchema,

  companyId: z.string().optional(),
  reference: z.string().optional(),
  commodity: z.string().optional(),
  weightLbs: z.number().int().nonnegative().optional(),
  equipment: trailerTypeSchema.optional(),
  pickupDate: isoSchema.optional(),
  deliveryDate: isoSchema.optional(),
  pickupWindow: timeWindowSchema.optional(),
  deliveryWindow: timeWindowSchema.optional(),
  bookedAt: isoSchema.optional(),
  dispatchedAt: isoSchema.optional(),
  pickedUpAt: isoSchema.optional(),
  deliveredAt: isoSchema.optional(),
  paidAt: isoSchema.optional(),
  assignedTruckId: z.string().optional(),
  assignedDriverId: z.string().optional(),
  driverPayCents: moneyCentsSchema.optional(),
  linehaulCents: moneyCentsSchema.optional(),
  fuelSurchargeCents: moneyCentsSchema.optional(),
  accessorialCents: moneyCentsSchema.optional(),
  quickPayEligible: z.boolean().optional(),
  rateType: z.enum(['flat', 'per_mile', 'per_load', 'hourly']).optional(),
  notes: z.string().optional(),
  source: z.enum(['manual', 'email', 'api', 'edi', 'import']).optional(),
  cancelledAt: isoSchema.optional(),
  cancelReason: z.string().optional(),
  proofOfDeliveryMissing: z.boolean().optional(),
  stops: z.array(loadStopSchema).optional(),
  documents: z.array(loadDocumentSchema).optional(),
});

export const truckSchema = z.object({
  id: z.string().min(1),
  unit: z.string().min(1),
  status: truckStatusSchema,
  location: geoPointSchema,
  driverId: z.string().optional(),

  companyId: z.string().optional(),
  vin: z.string().optional(),
  plate: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().optional(),
  trailerType: trailerTypeSchema.optional(),
  maxWeightLbs: z.number().int().positive().optional(),
  homeTerminal: z.string().optional(),
  currentDriverId: z.string().optional(),
  currentLoadId: z.string().optional(),
  currentDriverName: z.string().optional(),
  lastKnownAt: isoSchema.optional(),
  eldDeviceId: z.string().optional(),
  eldProvider: z.enum(['samsara', 'motive', 'simulator', 'manual']).optional(),
  hosStatus: z.enum(['off_duty', 'sleeper', 'available', 'driving', 'on_duty']).optional(),
  odometer: z.number().optional(),
  notes: z.string().optional(),
});

export const driverSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().optional(),
  userId: z.string().optional(),
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.email().optional(),
  homeBase: geoPointSchema.optional(),
  homeTerminal: z.string().optional(),
  licenseNumber: z.string().optional(),
  licenseState: z.string().length(2).optional(),
  licenseExpiresAt: isoSchema.optional(),
  hazmatEndorsed: z.boolean().optional(),
  tankerEndorsed: z.boolean().optional(),
  teamDrivers: z.boolean().optional(),
  status: z.enum(['active', 'inactive', 'on_leave']),
  hireDate: isoSchema.optional(),
  payType: z.enum(['percentage', 'flat_per_mile', 'flat_per_load', 'salary']),
  payRateBps: z.number().int().min(0).max(10_000).optional(),
  payPerMileCents: moneyCentsSchema.optional(),
  homePayPerMileCents: moneyCentsSchema.optional(),
  maxDailyDriveHours: z.number().min(0).max(24).optional(),
  preferredLanes: z
    .array(
      z.object({
        originCity: z.string().optional(),
        originState: z.string().optional(),
        destinationCity: z.string().optional(),
        destinationState: z.string().optional(),
        weight: z.number().optional(),
      }),
    )
    .optional(),
  doNotAssign: z.boolean().optional(),
  avatarUrl: z.string().optional(),
  createdAt: isoSchema.optional(),
  updatedAt: isoSchema.optional(),
});

export type LoadInput = z.input<typeof loadSchema>;
export type TruckInput = z.input<typeof truckSchema>;
export type DriverInput = z.input<typeof driverSchema>;
export type LoadStopInput = z.input<typeof loadStopSchema>;

/** Flatten a ZodError into a route-friendly payload. */
export function zodErrorToIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}