import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema.
 *
 * Money is stored as integer cents in a `bigint`, never as a float or a
 * Postgres `numeric` that a naive client would turn into a JS number. Miles are
 * integers. Coordinates are `double precision` with an index, because "find
 * trucks near me" is a real query and the free tiers all support it.
 *
 * Every table is scoped by `company_id` and indexed on it first: this is a
 * multi-tenant app from day one, even though the free plan only ever has one
 * company on it.
 */

export const loadStatusEnum = pgEnum('load_status', [
  'booked',
  'dispatched',
  'in-transit',
  'delivered',
  'paid',
]);

export const truckStatusEnum = pgEnum('truck_status', [
  'available',
  'loaded',
  'empty',
  'maintenance',
]);

export const planEnum = pgEnum('plan', ['free', 'starter', 'business']);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
]);

export const driverStatusEnum = pgEnum('driver_status', ['active', 'inactive', 'on_leave']);

export const payTypeEnum = pgEnum('pay_type', [
  'percentage',
  'flat_per_mile',
  'flat_per_load',
  'salary',
]);

export const roleEnum = pgEnum('role', ['driver', 'dispatcher', 'owner', 'admin']);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'void',
]);

export const settlementStatusEnum = pgEnum('settlement_status', [
  'draft',
  'approved',
  'paid',
  'void',
]);

export const stopTypeEnum = pgEnum('stop_type', ['pickup', 'delivery', 'waypoint']);
export const stopStatusEnum = pgEnum('stop_status', ['pending', 'arrived', 'completed', 'skipped']);
export const documentTypeEnum = pgEnum('document_type', [
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
]);

export const trailerTypeEnum = pgEnum('trailer_type', [
  'dry_van',
  'reefer',
  'flatbed',
  'step_deck',
  'tanker',
  'box_truck',
  'power_only',
]);

export const hosStatusEnum = pgEnum('hos_status', [
  'off_duty',
  'sleeper',
  'available',
  'driving',
  'on_duty',
]);

export const eldProviderEnum = pgEnum('eld_provider', [
  'samsara',
  'motive',
  'simulator',
  'manual',
]);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'push',
  'sms',
  'email',
  'in_app',
]);

const id = () => varchar({ length: 40 }).primaryKey();
const companyRef = () => varchar({ length: 40 }).notNull();

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                      */
/* -------------------------------------------------------------------------- */

export const companies = pgTable(
  'companies',
  {
    id: id(),
    name: varchar({ length: 200 }).notNull(),
    mcNumber: varchar({ length: 20 }),
    dotNumber: varchar({ length: 20 }),
    plan: planEnum('plan').notNull().default('free'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    subscriptionStatus: subscriptionStatusEnum('subscription_status').notNull().default('none'),
    paymentCustomerId: varchar({ length: 120 }),
    paymentSubscriptionId: varchar({ length: 120 }),
    timezone: varchar({ length: 64 }).notNull().default('America/Chicago'),
    homeTerminal: varchar({ length: 200 }),
    address: text('address'),
    billingEmail: varchar({ length: 320 }),
    /** Per-tenant feature and channel switches. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    billingEmailIdx: index('companies_billing_email_idx').on(table.billingEmail),
  }),
);

export const users = pgTable(
  'users',
  {
    id: id(),
    companyId: companyRef(),
    email: varchar({ length: 320 }).notNull(),
    name: varchar({ length: 200 }).notNull(),
    role: roleEnum('role').notNull().default('dispatcher'),
    /** Scrypt hash, `salt:hash` hex. Never store a plaintext password. */
    passwordHash: text('password_hash'),
    driverId: varchar({ length: 40 }),
    plan: planEnum('plan').notNull().default('free'),
    emailVerified: boolean('email_verified').notNull().default(false),
    pushToken: varchar({ length: 200 }),
    phone: varchar({ length: 32 }),
    timezone: varchar({ length: 64 }).notNull().default('America/Chicago'),
    quietHoursStart: integer('quiet_hours_start'),
    quietHoursEnd: integer('quiet_hours_end'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: uniqueIndex('users_email_idx').on(table.email),
    companyIdx: index('users_company_idx').on(table.companyId),
  }),
);

/* -------------------------------------------------------------------------- */
/* Fleet                                                                         */
/* -------------------------------------------------------------------------- */

export const trucks = pgTable(
  'trucks',
  {
    id: id(),
    companyId: companyRef(),
    unit: varchar({ length: 40 }).notNull(),
    vin: varchar({ length: 20 }),
    plate: varchar({ length: 20 }),
    make: varchar({ length: 60 }),
    model: varchar({ length: 60 }),
    year: integer('year'),
    trailerType: trailerTypeEnum('trailer_type').notNull().default('dry_van'),
    status: truckStatusEnum('status').notNull().default('available'),
    maxWeightLbs: integer('max_weight_lbs'),
    homeTerminal: varchar({ length: 200 }),
    driverId: varchar({ length: 40 }),
    currentLoadId: varchar({ length: 40 }),
    currentDriverName: varchar({ length: 200 }),
    lat: real('lat').notNull().default(0),
    lng: real('lng').notNull().default(0),
    lastKnownAt: timestamp('last_known_at', { withTimezone: true }),
    odometer: integer('odometer'),
    hosStatus: hosStatusEnum('hos_status'),
    eldProvider: eldProviderEnum('eld_provider').notNull().default('simulator'),
    eldDeviceId: varchar({ length: 120 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index('trucks_company_idx').on(table.companyId),
    unitIdx: uniqueIndex('trucks_company_unit_idx').on(table.companyId, table.unit),
    statusIdx: index('trucks_company_status_idx').on(table.companyId, table.status),
    driverIdx: index('trucks_driver_idx').on(table.driverId),
    locationIdx: index('trucks_location_idx').on(table.companyId, table.lat, table.lng),
  }),
);

export const drivers = pgTable(
  'drivers',
  {
    id: id(),
    companyId: companyRef(),
    userId: varchar({ length: 40 }),
    name: varchar({ length: 200 }).notNull(),
    phone: varchar({ length: 32 }),
    email: varchar({ length: 320 }),
    /** JSON GeoPoint: { lat, lng }. */
    homeBase: jsonb('home_base').$type<{ lat: number; lng: number } | null>(),
    homeTerminal: varchar({ length: 200 }),
    licenseNumber: varchar({ length: 40 }),
    licenseState: varchar({ length: 2 }),
    licenseExpiresAt: timestamp('license_expires_at', { withTimezone: true }),
    hazmatEndorsed: boolean('hazmat_endorsed').notNull().default(false),
    tankerEndorsed: boolean('tanker_endorsed').notNull().default(false),
    teamDrivers: boolean('team_drivers').notNull().default(false),
    status: driverStatusEnum('status').notNull().default('active'),
    hireDate: timestamp('hire_date', { withTimezone: true }),
    payType: payTypeEnum('pay_type').notNull().default('flat_per_mile'),
    /** Basis points: 2500 = 25%. */
    payRateBps: integer('pay_rate_bps'),
    payPerMileCents: integer('pay_per_mile_cents'),
    maxDailyDriveHours: real('max_daily_drive_hours'),
    preferredLanes: jsonb('preferred_lanes')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    doNotAssign: boolean('do_not_assign').notNull().default(false),
    avatarUrl: text('avatar_url'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index('drivers_company_idx').on(table.companyId),
    userIdx: index('drivers_user_idx').on(table.userId),
    nameIdx: index('drivers_name_idx').on(table.companyId, table.name),
  }),
);

/* -------------------------------------------------------------------------- */
/* Loads                                                                         */
/* -------------------------------------------------------------------------- */

export const loads = pgTable(
  'loads',
  {
    id: id(),
    companyId: companyRef(),
    reference: varchar({ length: 120 }),
    broker: varchar({ length: 200 }).notNull(),
    origin: varchar({ length: 300 }).notNull(),
    destination: varchar({ length: 300 }).notNull(),
    /** All-in broker rate, integer cents. */
    rate: integer('rate').notNull(),
    miles: integer('miles').notNull(),
    status: loadStatusEnum('status').notNull().default('booked'),
    commodity: varchar({ length: 200 }),
    weightLbs: integer('weight_lbs'),
    equipment: trailerTypeEnum('equipment'),
    pickupDate: timestamp('pickup_date', { withTimezone: true }),
    deliveryDate: timestamp('delivery_date', { withTimezone: true }),
    pickupWindowStart: timestamp('pickup_window_start', { withTimezone: true }),
    pickupWindowEnd: timestamp('pickup_window_end', { withTimezone: true }),
    deliveryWindowStart: timestamp('delivery_window_start', { withTimezone: true }),
    deliveryWindowEnd: timestamp('delivery_window_end', { withTimezone: true }),
    bookedAt: timestamp('booked_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    assignedTruckId: varchar({ length: 40 }),
    assignedDriverId: varchar({ length: 40 }),
    driverPayCents: integer('driver_pay_cents'),
    linehaulCents: integer('linehaul_cents'),
    fuelSurchargeCents: integer('fuel_surcharge_cents'),
    accessorialCents: integer('accessorial_cents'),
    rateType: varchar({ length: 20 }),
    quickPayEligible: boolean('quick_pay_eligible').notNull().default(true),
    source: varchar({ length: 20 }).notNull().default('manual'),
    notes: text('notes'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    proofOfDeliveryMissing: boolean('proof_of_delivery_missing').notNull().default(false),
    /** Set once the load appears on an invoice, for double-billing checks. */
    invoicedOn: varchar({ length: 40 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index('loads_company_idx').on(table.companyId),
    statusIdx: index('loads_company_status_idx').on(table.companyId, table.status),
    truckIdx: index('loads_truck_idx').on(table.assignedTruckId),
    driverIdx: index('loads_driver_idx').on(table.assignedDriverId),
    brokerIdx: index('loads_broker_idx').on(table.companyId, table.broker),
    pickupIdx: index('loads_pickup_idx').on(table.companyId, table.pickupDate),
    invoicedIdx: index('loads_invoiced_idx').on(table.invoicedOn),
  }),
);

export const loadStops = pgTable(
  'load_stops',
  {
    id: id(),
    loadId: varchar({ length: 40 }).notNull(),
    companyId: companyRef(),
    type: stopTypeEnum('type').notNull(),
    sequence: integer('sequence').notNull(),
    facilityName: varchar({ length: 300 }).notNull(),
    address: varchar({ length: 400 }).notNull(),
    city: varchar({ length: 120 }).notNull(),
    state: varchar({ length: 2 }).notNull(),
    postalCode: varchar({ length: 12 }),
    lat: real('lat'),
    lng: real('lng'),
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    appointmentRequired: boolean('appointment_required').notNull().default(false),
    appointmentRef: varchar({ length: 120 }),
    contactName: varchar({ length: 200 }),
    contactPhone: varchar({ length: 32 }),
    status: stopStatusEnum('status').notNull().default('pending'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    loadIdx: index('load_stops_load_idx').on(table.loadId, table.sequence),
    companyIdx: index('load_stops_company_idx').on(table.companyId),
  }),
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    loadId: varchar({ length: 40 }).notNull(),
    companyId: companyRef(),
    type: documentTypeEnum('type').notNull(),
    fileName: varchar({ length: 300 }).notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: varchar({ length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedBy: varchar({ length: 40 }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    lat: real('lat'),
    lng: real('lng'),
    signatureName: varchar({ length: 200 }),
    /** Small inline signature (data URL); large scans live in storage. */
    signatureDataUrl: text('signature_data_url'),
    pageCount: integer('page_count'),
    status: varchar({ length: 20 }).notNull().default('uploaded'),
    rejectReason: text('reject_reason'),
  },
  (table) => ({
    loadIdx: index('documents_load_idx').on(table.loadId),
    companyIdx: index('documents_company_idx').on(table.companyId, table.type),
  }),
);

/* -------------------------------------------------------------------------- */
/* GPS                                                                            */
/* -------------------------------------------------------------------------- */

/**
 * GPS pings are the one table that grows without bound, so it is separate,
 * time-ordered, and pruned by `TrackingEngine`. On the free tiers (500MB) the
 * retention window matters: 30 days at one ping per minute per truck is about
 * 43k rows for eight trucks, which is comfortably inside budget.
 */
export const gpsPings = pgTable(
  'gps_pings',
  {
    /** Device-generated id: the offline replay dedupe key. */
    id: id(),
    companyId: companyRef(),
    truckId: varchar({ length: 40 }).notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    accuracyM: real('accuracy_m'),
    headingDeg: real('heading_deg'),
    speedMph: real('speed_mph'),
    source: varchar({ length: 20 }).notNull().default('gps'),
    offline: boolean('offline').notNull().default(false),
  },
  (table) => ({
    truckTimeIdx: index('gps_pings_truck_time_idx').on(table.truckId, table.at),
    companyTimeIdx: index('gps_pings_company_time_idx').on(table.companyId, table.at),
  }),
);

/* -------------------------------------------------------------------------- */
/* Money                                                                          */
/* -------------------------------------------------------------------------- */

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    companyId: companyRef(),
    number: varchar({ length: 40 }).notNull(),
    brokerName: varchar({ length: 200 }).notNull(),
    brokerAccountRef: varchar({ length: 120 }),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    subtotalCents: integer('subtotal_cents').notNull(),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    amountPaidCents: integer('amount_paid_cents').notNull().default(0),
    balanceCents: integer('balance_cents').notNull(),
    termsDays: integer('terms_days').notNull().default(30),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    quickPayBps: integer('quick_pay_bps'),
    quickPayWindowDays: integer('quick_pay_window_days'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    numberIdx: uniqueIndex('invoices_number_idx').on(table.number),
    companyIdx: index('invoices_company_idx').on(table.companyId),
    brokerIdx: index('invoices_broker_idx').on(table.companyId, table.brokerName),
    dueIdx: index('invoices_due_idx').on(table.companyId, table.dueAt),
  }),
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    invoiceId: varchar({ length: 40 }).notNull(),
    companyId: companyRef(),
    loadId: varchar({ length: 40 }),
    description: varchar({ length: 400 }).notNull(),
    kind: varchar({ length: 40 }).notNull(),
    miles: integer('miles').notNull().default(0),
    rateCents: integer('rate_cents'),
    amountCents: integer('amount_cents').notNull(),
    taxCents: integer('tax_cents').notNull().default(0),
    sequence: integer('sequence').notNull().default(0),
  },
  (table) => ({
    invoiceIdx: index('invoice_lines_invoice_idx').on(table.invoiceId, table.sequence),
    loadIdx: index('invoice_lines_load_idx').on(table.loadId),
  }),
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    invoiceId: varchar({ length: 40 }).notNull(),
    companyId: companyRef(),
    amountCents: integer('amount_cents').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    method: varchar({ length: 20 }).notNull(),
    reference: varchar({ length: 120 }),
    note: text('note'),
    feeCents: integer('fee_cents').notNull().default(0),
  },
  (table) => ({
    invoiceIdx: index('payments_invoice_idx').on(table.invoiceId),
    companyIdx: index('payments_company_idx').on(table.companyId, table.at),
  }),
);

export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    companyId: companyRef(),
    driverId: varchar({ length: 40 }).notNull(),
    driverName: varchar({ length: 200 }).notNull(),
    weekKey: varchar({ length: 10 }).notNull(),
    weekStart: timestamp('week_start', { withTimezone: true }).notNull(),
    weekEnd: timestamp('week_end', { withTimezone: true }).notNull(),
    status: settlementStatusEnum('status').notNull().default('draft'),
    grossRevenueCents: integer('gross_revenue_cents').notNull().default(0),
    loadPayCents: integer('load_pay_cents').notNull().default(0),
    deadheadPayCents: integer('deadhead_pay_cents').notNull().default(0),
    perDiemCents: integer('per_diem_cents').notNull().default(0),
    reimbursementsCents: integer('reimbursements_cents').notNull().default(0),
    bonusCents: integer('bonus_cents').notNull().default(0),
    advancesCents: integer('advances_cents').notNull().default(0),
    deductionsCents: integer('deductions_cents').notNull().default(0),
    grossCents: integer('gross_cents').notNull().default(0),
    netCents: integer('net_cents').notNull().default(0),
    totalLoadedMiles: integer('total_loaded_miles').notNull().default(0),
    totalEmptyMiles: integer('total_empty_miles').notNull().default(0),
    loadsCompleted: integer('loads_completed').notNull().default(0),
    driverSignatureName: varchar({ length: 200 }),
    driverSignedAt: timestamp('driver_signed_at', { withTimezone: true }),
    approvedBy: varchar({ length: 40 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paymentMethod: varchar({ length: 40 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    driverWeekIdx: uniqueIndex('settlements_driver_week_idx').on(table.driverId, table.weekKey),
    companyIdx: index('settlements_company_idx').on(table.companyId, table.weekKey),
  }),
);

export const settlementLines = pgTable(
  'settlement_lines',
  {
    id: id(),
    settlementId: varchar({ length: 40 }).notNull(),
    companyId: companyRef(),
    sequence: integer('sequence').notNull(),
    kind: varchar({ length: 30 }).notNull(),
    description: varchar({ length: 400 }).notNull(),
    loadId: varchar({ length: 40 }),
    miles: integer('miles').notNull().default(0),
    rateCents: integer('rate_cents'),
    amountCents: integer('amount_cents').notNull(),
    meta: jsonb('meta').$type<Record<string, string | number | boolean>>().notNull().default({}),
  },
  (table) => ({
    settlementIdx: index('settlement_lines_settlement_idx').on(table.settlementId, table.sequence),
  }),
);

/* -------------------------------------------------------------------------- */
/* Ops & compliance                                                              */
/* -------------------------------------------------------------------------- */

export const fuelEntries = pgTable(
  'fuel_entries',
  {
    id: id(),
    companyId: companyRef(),
    truckId: varchar({ length: 40 }).notNull(),
    driverId: varchar({ length: 40 }),
    loadId: varchar({ length: 40 }),
    gallons: numeric('gallons', { precision: 8, scale: 2 }).notNull(),
    priceCentsPerGallon: integer('price_cents_per_gallon').notNull(),
    totalCents: integer('total_cents').notNull(),
    odometerMiles: integer('odometer_miles'),
    lat: real('lat'),
    lng: real('lng'),
    jurisdictionCode: varchar({ length: 4 }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    receiptStorageKey: text('receipt_storage_key'),
    cardLast4: varchar({ length: 4 }),
    isPrepaid: boolean('is_prepaid').notNull().default(false),
    note: text('note'),
  },
  (table) => ({
    truckIdx: index('fuel_entries_truck_idx').on(table.truckId, table.at),
    companyIdx: index('fuel_entries_company_idx').on(table.companyId, table.at),
    jurisdictionIdx: index('fuel_entries_jurisdiction_idx').on(table.companyId, table.jurisdictionCode),
  }),
);

export const iftaReports = pgTable(
  'ifta_reports',
  {
    id: id(),
    companyId: companyRef(),
    periodLabel: varchar({ length: 20 }).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /** The full calculated report, so a filed quarter can be reproduced exactly. */
    report: jsonb('report').$type<Record<string, unknown>>().notNull(),
    netTaxDueCents: integer('net_tax_due_cents').notNull(),
    filedAt: timestamp('filed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    periodIdx: uniqueIndex('ifta_reports_period_idx').on(table.companyId, table.periodLabel),
  }),
);

export const events = pgTable(
  'events',
  {
    id: id(),
    companyId: companyRef(),
    type: varchar({ length: 40 }).notNull(),
    entityType: varchar({ length: 20 }).notNull(),
    entityId: varchar({ length: 40 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    actorId: varchar({ length: 40 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    offline: boolean('offline').notNull().default(false),
  },
  (table) => ({
    entityIdx: index('events_entity_idx').on(table.entityId, table.occurredAt),
    companyIdx: index('events_company_idx').on(table.companyId, table.occurredAt),
  }),
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    companyId: companyRef(),
    userId: varchar({ length: 40 }),
    driverId: varchar({ length: 40 }),
    kind: varchar({ length: 40 }).notNull(),
    priority: varchar({ length: 20 }).notNull().default('normal'),
    title: varchar({ length: 200 }).notNull(),
    body: text('body').notNull(),
    url: varchar({ length: 300 }),
    channel: notificationChannelEnum('channel').notNull().default('in_app'),
    entityType: varchar({ length: 20 }),
    entityId: varchar({ length: 40 }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    providerMessageId: varchar({ length: 120 }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('notifications_user_idx').on(table.userId, table.createdAt),
    companyIdx: index('notifications_company_idx').on(table.companyId, table.createdAt),
  }),
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    companyId: companyRef(),
    name: varchar({ length: 120 }).notNull(),
    /** SHA-256 of the key. The plaintext is shown once, at creation. */
    keyHash: varchar({ length: 64 }).notNull(),
    prefix: varchar({ length: 12 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hashIdx: uniqueIndex('api_keys_hash_idx').on(table.keyHash),
  }),
);

export const settlementsAdvances = pgTable(
  'advances',
  {
    id: id(),
    companyId: companyRef(),
    driverId: varchar({ length: 40 }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
    /** Set when the advance has been deducted from a settlement. */
    settledOn: varchar({ length: 40 }),
  },
  (table) => ({
    driverIdx: index('advances_driver_idx').on(table.driverId, table.at),
  }),
);

export const driverDeductions = pgTable(
  'driver_deductions',
  {
    id: id(),
    companyId: companyRef(),
    driverId: varchar({ length: 40 }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    category: varchar({ length: 30 }).notNull(),
    note: text('note'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    settledOn: varchar({ length: 40 }),
  },
  (table) => ({
    driverIdx: index('driver_deductions_driver_idx').on(table.driverId, table.at),
  }),
);

/* -------------------------------------------------------------------------- */
/* Composite keys                                                                 */
/* -------------------------------------------------------------------------- */

export const loadStopPk = primaryKey({ columns: [loadStops.loadId, loadStops.sequence] });

export type CompanyRow = typeof companies.$inferSelect;
export type NewCompanyRow = typeof companies.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type TruckRow = typeof trucks.$inferSelect;
export type NewTruckRow = typeof trucks.$inferInsert;
export type DriverRow = typeof drivers.$inferSelect;
export type NewDriverRow = typeof drivers.$inferInsert;
export type LoadRow = typeof loads.$inferSelect;
export type NewLoadRow = typeof loads.$inferInsert;
export type LoadStopRow = typeof loadStops.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type SettlementRow = typeof settlements.$inferSelect;
export type FuelEntryRow = typeof fuelEntries.$inferSelect;
export type GpsPingRow = typeof gpsPings.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type IftaReportRow = typeof iftaReports.$inferSelect;