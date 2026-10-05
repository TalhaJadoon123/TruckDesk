/**
 * TruckDesk canonical domain types.
 *
 * The two interfaces pinned by the spec (`Truck`, `Load`) are reproduced
 * field-for-field. Everything added below is either an optional extension on
 * those contracts or a separate type that the core engines consume. Nothing
 * in the required shapes was renamed or made optional.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                   */
/* -------------------------------------------------------------------------- */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type Iso = string;

/** All money in TruckDesk is integer USD cents. Floats never touch a balance. */
export type Cents = number;

/* -------------------------------------------------------------------------- */
/* Core entities required by the spec                                           */
/* -------------------------------------------------------------------------- */

export interface Truck extends TruckExtension {
  id: string;
  unit: string;
  status: 'available'|'loaded'|'empty'|'maintenance';
  location: { lat: number; lng: number };
  driverId?: string;
}

export interface Load extends LoadExtension {
  id: string;
  broker: string;
  origin: string;
  destination: string;
  rate: number;
  miles: number;
  status: 'booked'|'dispatched'|'in-transit'|'delivered'|'paid';
}

/* -------------------------------------------------------------------------- */
/* Optional extensions on the pinned contracts                                  */
/* -------------------------------------------------------------------------- */

/**
 * Optional fields added on top of the spec's pinned `Truck` contract.
 * `Truck extends TruckExtension` below, so these are additive: every consumer
 * that only knows the six required fields keeps compiling unchanged.
 */
export interface TruckExtension {
  companyId?: string;
  vin?: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: number;
  /** Empty trailer is a separate board column from `available`. */
  trailerType?: TrailerType;
  maxWeightLbs?: number;
  homeTerminal?: string;
  currentDriverId?: string;
  currentLoadId?: string;
  currentDriverName?: string;
  lastKnownAt?: Iso;
  eldDeviceId?: string;
  eldProvider?: EldProviderName;
  hosStatus?: HosStatus;
  odometer?: number;
  notes?: string;
}

export interface LoadExtension {
  companyId?: string;
  reference?: string;
  /** Numeric core.rate is the all-in broker rate in USD cents. */
  commodity?: string;
  weightLbs?: number;
  equipment?: TrailerType;
  pickupDate?: Iso;
  deliveryDate?: Iso;
  pickupWindow?: TimeWindow;
  deliveryWindow?: TimeWindow;
  bookedAt?: Iso;
  dispatchedAt?: Iso;
  pickedUpAt?: Iso;
  deliveredAt?: Iso;
  paidAt?: Iso;
  assignedTruckId?: string;
  assignedDriverId?: string;
  driverPayCents?: Cents;
  linehaulCents?: Cents;
  fuelSurchargeCents?: Cents;
  accessorialCents?: Cents;
  quickPayEligible?: boolean;
  rateType?: RateType;
  notes?: string;
  source?: LoadSource;
  /**
   * Cancellation is a flag, not a seventh status, because `Load.status` is the
   * five-value union pinned by the spec. `cancelledAt` wins over `status`.
   */
  cancelledAt?: Iso;
  cancelReason?: string;
  /** Set when a stop was marked complete without a POD on file. */
  proofOfDeliveryMissing?: boolean;
  stops?: LoadStop[];
  documents?: LoadDocument[];
}

/* -------------------------------------------------------------------------- */
/* Supporting domain                                                            */
/* -------------------------------------------------------------------------- */

export type TrailerType =
  | 'dry_van'
  | 'reefer'
  | 'flatbed'
  | 'step_deck'
  | 'tanker'
  | 'box_truck'
  | 'power_only';

export type RateType = 'flat' | 'per_mile' | 'per_load' | 'hourly';

export type LoadSource = 'manual' | 'email' | 'api' | 'edi' | 'import';

export type HosStatus = 'off_duty' | 'sleeper' | 'available' | 'driving' | 'on_duty';

export type EldProviderName = 'samsara' | 'motive' | 'simulator' | 'manual';

export type DriverRole = 'driver' | 'dispatcher' | 'owner' | 'admin';

export interface TimeWindow {
  /** ISO timestamp the window opens. */
  start: Iso;
  /** ISO timestamp the window closes. */
  end: Iso;
  earlyAccepted?: boolean;
  lateAccepted?: boolean;
}

export interface LoadStop {
  id: string;
  loadId: string;
  type: 'pickup' | 'delivery' | 'waypoint';
  sequence: number;
  facilityName: string;
  address: string;
  city: string;
  state: string;
  postalCode?: string;
  location?: GeoPoint;
  window?: TimeWindow;
  appointmentRequired?: boolean;
  appointmentRef?: string;
  contactName?: string;
  contactPhone?: string;
  status: 'pending' | 'arrived' | 'completed' | 'skipped';
  arrivedAt?: Iso;
  completedAt?: Iso;
  notes?: string;
}

export type DocumentType =
  | 'rate_con'
  | 'bol'
  | 'pod'
  | 'lumper_receipt'
  | 'tif'
  | 'fuel_receipt'
  | 'damage_photo'
  | 'driver_signature'
  | 'w9'
  | 'insurance_cert'
  | 'exemption';

export interface LoadDocument {
  id: string;
  loadId: string;
  type: DocumentType;
  fileName: string;
  /** Storage key. Files live in Supabase Storage (free) or R2. */
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: Iso;
  capturedAt?: Iso;
  geo?: GeoPoint;
  signatureName?: string;
  signatureDataUrl?: string;
  pageCount?: number;
  status: 'pending' | 'uploaded' | 'rejected';
  rejectReason?: string;
}

export interface Driver {
  id: string;
  companyId?: string;
  userId?: string;
  name: string;
  phone?: string;
  email?: string;
  /** Home base used for deadhead preference in load matching. */
  homeBase?: GeoPoint;
  homeTerminal?: string;
  licenseNumber?: string;
  licenseState?: string;
  licenseExpiresAt?: Iso;
  hazmatEndorsed?: boolean;
  tankerEndorsed?: boolean;
  teamDrivers?: boolean;
  status: 'active' | 'inactive' | 'on_leave';
  hireDate?: Iso;
  payType: 'percentage' | 'flat_per_mile' | 'flat_per_load' | 'salary';
  /** Percentage in basis points when payType is percentage (25% => 2500). */
  payRateBps?: number;
  payPerMileCents?: Cents;
  homePayPerMileCents?: Cents;
  /** Hard cap used to stop a load being assigned past legal hours. */
  maxDailyDriveHours?: number;
  preferredLanes?: LanePreference[];
  doNotAssign?: boolean;
  avatarUrl?: string;
  createdAt?: Iso;
  updatedAt?: Iso;
}

export interface LanePreference {
  originCity?: string;
  originState?: string;
  destinationCity?: string;
  destinationState?: string;
  /** Negative weight means "avoid this lane". */
  weight?: number;
}

export interface User {
  id: string;
  companyId: string;
  email: string;
  name: string;
  role: DriverRole;
  driverId?: string;
  plan: PlanId;
  emailVerified?: boolean;
  createdAt: Iso;
  lastLoginAt?: Iso;
}

export interface Company {
  id: string;
  name: string;
  mcNumber?: string;
  dotNumber?: string;
  plan: PlanId;
  /** Trial end for paid plans; null means never trialled. */
  trialEndsAt?: Iso | null;
  timezone: string;
  homeTerminal?: string;
  address?: string;
  billingEmail?: string;
  paymentCustomerId?: string;
  paymentSubscriptionId?: string;
  subscriptionStatus?: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';
  createdAt: Iso;
}

export type PlanId = 'free' | 'starter' | 'business';

/* -------------------------------------------------------------------------- */
/* Events & audit                                                               */
/* -------------------------------------------------------------------------- */

export type DomainEventType =
  | 'load.created'
  | 'load.assigned'
  | 'load.unassigned'
  | 'load.status_changed'
  | 'load.delivered'
  | 'load.paid'
  | 'load.cancelled'
  | 'truck.status_changed'
  | 'truck.ping'
  | 'hos.violation'
  | 'hos.warning'
  | 'invoice.sent'
  | 'invoice.paid'
  | 'settlement.created'
  | 'document.uploaded'
  | 'driver.checked_in';

export interface DomainEvent<TPayload = unknown> {
  id: string;
  companyId?: string;
  type: DomainEventType;
  entityType: 'load' | 'truck' | 'driver' | 'invoice' | 'settlement' | 'document';
  entityId: string;
  payload: TPayload;
  actorId?: string;
  occurredAt: Iso;
  /** True when the event originated on a driver's device and was synced later. */
  offline?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Money                                                                        */
/* -------------------------------------------------------------------------- */

export interface Money {
  cents: Cents;
  currency: 'USD';
}

export interface RateBreakdown {
  linehaulCents: Cents;
  fuelSurchargeCents: Cents;
  accessorialCents: Cents;
  totalCents: Cents;
  miles: number;
  revenuePerMileCents: number;
  /** linehaul only; the number a dispatcher actually quotes on. */
  linehaulPerMileCents: number;
}

/* -------------------------------------------------------------------------- */
/* Aggregation helpers used by dashboard + docs                                */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary {
  trucksAvailable: number;
  trucksTotal: number;
  loadsInTransit: number;
  loadsDeliveredThisWeek: number;
  revenueThisWeekCents: Cents;
  revenueLastWeekCents: Cents;
  deadheadRatio: number;
  averageRevenuePerMileCents: number;
  onTimeRate: number;
  unpaidReceivablesCents: Cents;
  hosViolations: number;
  generatedAt: Iso;
}