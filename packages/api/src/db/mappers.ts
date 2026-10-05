import type {
  Cents,
  DomainEvent,
  Driver,
  Iso,
  Load,
  LoadDocument,
  LoadStop,
  Truck,
} from '@truckdesk/shared';

import type {
  DocumentRow,
  DriverRow,
  EventRow,
  GpsPingRow,
  LoadRow,
  LoadStopRow,
  TruckRow,
} from './schema.js';

/**
 * Row <-> domain mappers.
 *
 * The database is normalized (stops in their own table, money in integer
 * columns); the domain is not. These functions are the only place that knows
 * both shapes, so a schema change touches this file and nothing else.
 *
 * `undefined` is never written for a column that has a default: only real
 * values are emitted, so a partial update leaves the other columns alone.
 */

/* -------------------------------------------------------------------------- */
/* Trucks                                                                        */
/* -------------------------------------------------------------------------- */

export function rowToTruck(row: TruckRow): Truck {
  return {
    id: row.id,
    unit: row.unit,
    status: row.status,
    location: { lat: row.lat, lng: row.lng },
    companyId: row.companyId,
    vin: row.vin ?? undefined,
    plate: row.plate ?? undefined,
    make: row.make ?? undefined,
    model: row.model ?? undefined,
    year: row.year ?? undefined,
    trailerType: row.trailerType,
    maxWeightLbs: row.maxWeightLbs ?? undefined,
    homeTerminal: row.homeTerminal ?? undefined,
    driverId: row.driverId ?? undefined,
    currentDriverId: row.driverId ?? undefined,
    currentLoadId: row.currentLoadId ?? undefined,
    currentDriverName: row.currentDriverName ?? undefined,
    lastKnownAt: row.lastKnownAt?.toISOString(),
    odometer: row.odometer ?? undefined,
    hosStatus: row.hosStatus ?? undefined,
    eldProvider: row.eldProvider,
    eldDeviceId: row.eldDeviceId ?? undefined,
    notes: row.notes ?? undefined,
  };
}

export function truckToRow(truck: Truck): Record<string, unknown> {
  return {
    id: truck.id,
    companyId: truck.companyId,
    unit: truck.unit,
    vin: truck.vin ?? null,
    plate: truck.plate ?? null,
    make: truck.make ?? null,
    model: truck.model ?? null,
    year: truck.year ?? null,
    trailerType: truck.trailerType ?? 'dry_van',
    status: truck.status,
    maxWeightLbs: truck.maxWeightLbs ?? null,
    homeTerminal: truck.homeTerminal ?? null,
    driverId: truck.driverId ?? null,
    currentLoadId: truck.currentLoadId ?? null,
    currentDriverName: truck.currentDriverName ?? null,
    lat: truck.location.lat,
    lng: truck.location.lng,
    lastKnownAt: truck.lastKnownAt ? new Date(truck.lastKnownAt) : null,
    odometer: truck.odometer ?? null,
    hosStatus: truck.hosStatus ?? null,
    eldProvider: truck.eldProvider ?? 'simulator',
    eldDeviceId: truck.eldDeviceId ?? null,
    notes: truck.notes ?? null,
    updatedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* Drivers                                                                       */
/* -------------------------------------------------------------------------- */

export function rowToDriver(row: DriverRow): Driver {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId ?? undefined,
    name: row.name,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    homeBase: row.homeBase ?? undefined,
    homeTerminal: row.homeTerminal ?? undefined,
    licenseNumber: row.licenseNumber ?? undefined,
    licenseState: row.licenseState ?? undefined,
    licenseExpiresAt: row.licenseExpiresAt?.toISOString(),
    hazmatEndorsed: row.hazmatEndorsed,
    tankerEndorsed: row.tankerEndorsed,
    teamDrivers: row.teamDrivers,
    status: row.status,
    hireDate: row.hireDate?.toISOString(),
    payType: row.payType,
    payRateBps: row.payRateBps ?? undefined,
    payPerMileCents: row.payPerMileCents ?? undefined,
    maxDailyDriveHours: row.maxDailyDriveHours ?? undefined,
    preferredLanes: row.preferredLanes as Driver['preferredLanes'],
    doNotAssign: row.doNotAssign,
    avatarUrl: row.avatarUrl ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function driverToRow(driver: Driver): Record<string, unknown> {
  return {
    id: driver.id,
    companyId: driver.companyId,
    userId: driver.userId ?? null,
    name: driver.name,
    phone: driver.phone ?? null,
    email: driver.email ?? null,
    homeBase: driver.homeBase ?? null,
    homeTerminal: driver.homeTerminal ?? null,
    licenseNumber: driver.licenseNumber ?? null,
    licenseState: driver.licenseState ?? null,
    licenseExpiresAt: driver.licenseExpiresAt ? new Date(driver.licenseExpiresAt) : null,
    hazmatEndorsed: driver.hazmatEndorsed ?? false,
    tankerEndorsed: driver.tankerEndorsed ?? false,
    teamDrivers: driver.teamDrivers ?? false,
    status: driver.status,
    hireDate: driver.hireDate ? new Date(driver.hireDate) : null,
    payType: driver.payType,
    payRateBps: driver.payRateBps ?? null,
    payPerMileCents: driver.payPerMileCents ?? null,
    maxDailyDriveHours: driver.maxDailyDriveHours ?? null,
    preferredLanes: driver.preferredLanes ?? [],
    doNotAssign: driver.doNotAssign ?? false,
    avatarUrl: driver.avatarUrl ?? null,
    notes: undefined,
    updatedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* Loads                                                                         */
/* -------------------------------------------------------------------------- */

export function rowToLoad(row: LoadRow): Load {
  const load: Load = {
    id: row.id,
    broker: row.broker,
    origin: row.origin,
    destination: row.destination,
    rate: row.rate,
    miles: row.miles,
    status: row.status,
    companyId: row.companyId,
    reference: row.reference ?? undefined,
    commodity: row.commodity ?? undefined,
    weightLbs: row.weightLbs ?? undefined,
    equipment: row.equipment ?? undefined,
    pickupDate: row.pickupDate?.toISOString(),
    deliveryDate: row.deliveryDate?.toISOString(),
    pickupWindow:
      row.pickupWindowStart && row.pickupWindowEnd
        ? { start: row.pickupWindowStart.toISOString(), end: row.pickupWindowEnd.toISOString() }
        : undefined,
    deliveryWindow:
      row.deliveryWindowStart && row.deliveryWindowEnd
        ? { start: row.deliveryWindowStart.toISOString(), end: row.deliveryWindowEnd.toISOString() }
        : undefined,
    bookedAt: row.bookedAt.toISOString(),
    dispatchedAt: row.dispatchedAt?.toISOString(),
    pickedUpAt: row.pickedUpAt?.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString(),
    paidAt: row.paidAt?.toISOString(),
    assignedTruckId: row.assignedTruckId ?? undefined,
    assignedDriverId: row.assignedDriverId ?? undefined,
    driverPayCents: row.driverPayCents ?? undefined,
    linehaulCents: row.linehaulCents ?? undefined,
    fuelSurchargeCents: row.fuelSurchargeCents ?? undefined,
    accessorialCents: row.accessorialCents ?? undefined,
    quickPayEligible: row.quickPayEligible,
    rateType: (row.rateType as Load['rateType']) ?? undefined,
    source: (row.source as Load['source']) ?? 'manual',
    notes: row.notes ?? undefined,
    cancelledAt: row.cancelledAt?.toISOString(),
    cancelReason: row.cancelReason ?? undefined,
    proofOfDeliveryMissing: row.proofOfDeliveryMissing,
  };

  return load;
}

export function loadToRow(load: Load): Record<string, unknown> {
  return {
    id: load.id,
    companyId: load.companyId,
    reference: load.reference ?? null,
    broker: load.broker,
    origin: load.origin,
    destination: load.destination,
    rate: Math.round(load.rate),
    miles: Math.round(load.miles),
    status: load.status,
    commodity: load.commodity ?? null,
    weightLbs: load.weightLbs ?? null,
    equipment: load.equipment ?? null,
    pickupDate: load.pickupDate ? new Date(load.pickupDate) : null,
    deliveryDate: load.deliveryDate ? new Date(load.deliveryDate) : null,
    pickupWindowStart: load.pickupWindow ? new Date(load.pickupWindow.start) : null,
    pickupWindowEnd: load.pickupWindow ? new Date(load.pickupWindow.end) : null,
    deliveryWindowStart: load.deliveryWindow ? new Date(load.deliveryWindow.start) : null,
    deliveryWindowEnd: load.deliveryWindow ? new Date(load.deliveryWindow.end) : null,
    dispatchedAt: load.dispatchedAt ? new Date(load.dispatchedAt) : null,
    pickedUpAt: load.pickedUpAt ? new Date(load.pickedUpAt) : null,
    deliveredAt: load.deliveredAt ? new Date(load.deliveredAt) : null,
    paidAt: load.paidAt ? new Date(load.paidAt) : null,
    assignedTruckId: load.assignedTruckId ?? null,
    assignedDriverId: load.assignedDriverId ?? null,
    driverPayCents: load.driverPayCents ?? null,
    linehaulCents: load.linehaulCents ?? null,
    fuelSurchargeCents: load.fuelSurchargeCents ?? null,
    accessorialCents: load.accessorialCents ?? null,
    rateType: load.rateType ?? null,
    quickPayEligible: load.quickPayEligible ?? true,
    source: load.source ?? 'manual',
    notes: load.notes ?? null,
    cancelledAt: load.cancelledAt ? new Date(load.cancelledAt) : null,
    cancelReason: load.cancelReason ?? null,
    proofOfDeliveryMissing: load.proofOfDeliveryMissing ?? false,
    updatedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* Stops                                                                         */
/* -------------------------------------------------------------------------- */

export function rowToStop(row: LoadStopRow): LoadStop {
  return {
    id: row.id,
    loadId: row.loadId,
    type: row.type,
    sequence: row.sequence,
    facilityName: row.facilityName,
    address: row.address,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode ?? undefined,
    location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : undefined,
    window:
      row.windowStart && row.windowEnd
        ? { start: row.windowStart.toISOString(), end: row.windowEnd.toISOString() }
        : undefined,
    appointmentRequired: row.appointmentRequired,
    appointmentRef: row.appointmentRef ?? undefined,
    contactName: row.contactName ?? undefined,
    contactPhone: row.contactPhone ?? undefined,
    status: row.status,
    arrivedAt: row.arrivedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    notes: row.notes ?? undefined,
  };
}

export function stopToRow(stop: LoadStop, companyId: string): Record<string, unknown> {
  return {
    id: stop.id,
    loadId: stop.loadId,
    companyId,
    type: stop.type,
    sequence: stop.sequence,
    facilityName: stop.facilityName,
    address: stop.address,
    city: stop.city,
    state: stop.state,
    postalCode: stop.postalCode ?? null,
    lat: stop.location?.lat ?? null,
    lng: stop.location?.lng ?? null,
    windowStart: stop.window ? new Date(stop.window.start) : null,
    windowEnd: stop.window ? new Date(stop.window.end) : null,
    appointmentRequired: stop.appointmentRequired ?? false,
    appointmentRef: stop.appointmentRef ?? null,
    contactName: stop.contactName ?? null,
    contactPhone: stop.contactPhone ?? null,
    status: stop.status,
    arrivedAt: stop.arrivedAt ? new Date(stop.arrivedAt) : null,
    completedAt: stop.completedAt ? new Date(stop.completedAt) : null,
    notes: stop.notes ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                     */
/* -------------------------------------------------------------------------- */

export function rowToDocument(row: DocumentRow): LoadDocument {
  return {
    id: row.id,
    loadId: row.loadId,
    type: row.type,
    fileName: row.fileName,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt.toISOString(),
    capturedAt: row.capturedAt?.toISOString(),
    geo: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : undefined,
    signatureName: row.signatureName ?? undefined,
    signatureDataUrl: row.signatureDataUrl ?? undefined,
    pageCount: row.pageCount ?? undefined,
    status: row.status as LoadDocument['status'],
    rejectReason: row.rejectReason ?? undefined,
  };
}

export function documentToRow(document: LoadDocument, companyId: string): Record<string, unknown> {
  return {
    id: document.id,
    loadId: document.loadId,
    companyId,
    type: document.type,
    fileName: document.fileName,
    storageKey: document.storageKey,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    uploadedBy: document.uploadedBy,
    uploadedAt: new Date(document.uploadedAt),
    capturedAt: document.capturedAt ? new Date(document.capturedAt) : null,
    lat: document.geo?.lat ?? null,
    lng: document.geo?.lng ?? null,
    signatureName: document.signatureName ?? null,
    signatureDataUrl: document.signatureDataUrl ?? null,
    pageCount: document.pageCount ?? null,
    status: document.status,
    rejectReason: document.rejectReason ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* GPS and events                                                                */
/* -------------------------------------------------------------------------- */

export function rowToPing(row: GpsPingRow): {
  id: string;
  truckId: string;
  location: { lat: number; lng: number };
  at: Iso;
  accuracyM?: number;
  headingDeg?: number;
  speedMph?: number;
  source?: string;
  offline?: boolean;
} {
  return {
    id: row.id,
    truckId: row.truckId,
    location: { lat: row.lat, lng: row.lng },
    at: row.at.toISOString(),
    accuracyM: row.accuracyM ?? undefined,
    headingDeg: row.headingDeg ?? undefined,
    speedMph: row.speedMph ?? undefined,
    source: row.source,
    offline: row.offline,
  };
}

export function rowToEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as DomainEvent['type'],
    entityType: row.entityType as DomainEvent['entityType'],
    entityId: row.entityId,
    payload: row.payload,
    actorId: row.actorId ?? undefined,
    occurredAt: row.occurredAt.toISOString(),
    offline: row.offline,
  };
}

export function eventToRow(event: DomainEvent, companyId: string): Record<string, unknown> {
  return {
    id: event.id,
    companyId,
    type: event.type,
    entityType: event.entityType,
    entityId: event.entityId,
    payload: (event.payload ?? {}) as Record<string, unknown>,
    actorId: event.actorId ?? null,
    occurredAt: new Date(event.occurredAt),
    offline: event.offline ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* Money                                                                         */
/* -------------------------------------------------------------------------- */

export function centsToDb(cents: Cents | undefined): number | null {
  return cents === undefined || cents === null ? null : Math.round(cents);
}