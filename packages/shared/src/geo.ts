import type { GeoPoint } from './types.js';

export const EARTH_RADIUS_MILES = 3958.7613;

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * Great-circle distance in miles.
 *
 * Non-finite or out-of-range inputs return 0 rather than NaN. A NaN here is
 * worse than useless: it silently poisons every aggregate it touches, so a
 * single bad ping would turn a truck's deadhead miles into NaN and break the
 * ranking, the ETA and the settlement with no error anywhere.
 */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  if (!isUsableCoordinate(a) || !isUsableCoordinate(b)) return 0;

  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  // Floating point can push `h` a hair above 1, which makes asin(NaN).
  const clamped = Math.min(1, Math.max(0, h));
  const miles = 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(clamped));

  return Number.isFinite(miles) ? miles : 0;
}

/** A coordinate is usable when it is finite and inside the valid range. */
export function isUsableCoordinate(point: GeoPoint | null | undefined): point is GeoPoint {
  if (!point || typeof point !== 'object') return false;
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
  return point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

export function haversineMilesBetween(a: GeoPoint, b: GeoPoint): number {
  return haversineMiles(a, b);
}

export function kmToMiles(km: number): number {
  return km / 1.609344;
}

export function milesToKm(miles: number): number {
  return miles * 1.609344;
}

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Bounding box for a list of points, with a 1-degree pad so Leaflet fits. */
export function boundingBox(points: readonly GeoPoint[], padDegrees = 0.15): BoundingBox | null {
  // A single NaN latitude makes every comparison false, so the box stays NaN
  // and Leaflet renders an infinite zoom with no tiles. Skip unusable points.
  const usable = points.filter(isUsableCoordinate);
  const first = usable[0];
  if (!first) return null;

  let south = first.lat;
  let north = first.lat;
  let west = first.lng;
  let east = first.lng;

  for (const point of usable) {
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
    if (point.lng < west) west = point.lng;
    if (point.lng > east) east = point.lng;
  }

  return {
    south: south - padDegrees,
    north: north + padDegrees,
    west: west - padDegrees,
    east: east + padDegrees,
  };
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearingDegrees(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLng = toRadians(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Road distance. Straight-line distance under-reads by 10-20% in the US road
 * network, and deadhead math needs a road-realistic number. This multiplier is
 * the standard cheap approximation used when a routing engine is not wired up
 * (it is only used for estimates; money always uses broker-posted miles).
 */
export const ROAD_WINDING_FACTOR = 1.18;

export function estimateRoadMiles(a: GeoPoint, b: GeoPoint): number {
  return haversineMiles(a, b) * ROAD_WINDING_FACTOR;
}

export function routeMiles(points: readonly GeoPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (from && to) total += estimateRoadMiles(from, to);
  }
  return total;
}

export function midpoint(a: GeoPoint, b: GeoPoint): GeoPoint {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

/** Interpolate along the great circle. t in [0, 1]. */
export function interpolate(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  const clamped = Math.max(0, Math.min(1, t));
  const lat1 = toRadians(a.lat);
  const lng1 = toRadians(a.lng);
  const lat2 = toRadians(b.lat);
  const lng2 = toRadians(b.lng);

  const d = haversineMiles(a, b) / EARTH_RADIUS_MILES;
  if (d === 0) return { ...a };

  const sinD = Math.sin(d);
  const A = Math.sin((1 - clamped) * d) / sinD;
  const B = Math.sin(clamped * d) / sinD;

  const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
  const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);

  return {
    lat: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDegrees(Math.atan2(y, x)),
  };
}

/**
 * Interpolate a position between two GPS pings using the timestamp ratio, so
 * replaying a breadcrumb trail at 10x speed stays on the real path.
 */
export function positionAtTime(
  pings: readonly { location: GeoPoint; at: string }[],
  at: string,
): GeoPoint | null {
  if (pings.length === 0) return null;
  const first = pings[0];
  if (!first) return null;

  const target = Date.parse(at);
  if (Number.isNaN(target)) return null;

  if (pings.length === 1 || target <= Date.parse(first.at)) return { ...first.location };

  const last = pings[pings.length - 1];
  if (last && target >= Date.parse(last.at)) return { ...last.location };

  for (let i = 1; i < pings.length; i += 1) {
    const prev = pings[i - 1];
    const curr = pings[i];
    if (!prev || !curr) continue;

    const prevMs = Date.parse(prev.at);
    const currMs = Date.parse(curr.at);
    if (target >= prevMs && target <= currMs) {
      const span = currMs - prevMs;
      const t = span === 0 ? 0 : (target - prevMs) / span;
      return interpolate(prev.location, curr.location, t);
    }
  }

  return last ? { ...last.location } : null;
}

/** Distance in miles a truck can reasonably cover in `hours`, with load time. */
export function driveableMiles(hours: number, avgSpeedMph = 55): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * avgSpeedMph;
}

export function isValidPoint(point: GeoPoint | null | undefined): point is GeoPoint {
  if (!point) return false;
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
  return point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

/** Round to a sane GPS precision (~11m) to keep payloads small. */
export function roundPoint(point: GeoPoint, decimals = 5): GeoPoint {
  const factor = 10 ** decimals;
  return {
    lat: Math.round(point.lat * factor) / factor,
    lng: Math.round(point.lng * factor) / factor,
  };
}

/**
 * Point a fraction of the way along a straight line. Used to fan out demo
 * trucks around a terminal so the dashboard map does not stack them.
 */
export function offsetPoint(origin: GeoPoint, milesNorth: number, milesEast: number): GeoPoint {
  const latDelta = toDegrees(milesNorth / EARTH_RADIUS_MILES);
  const lngDelta = toDegrees(milesEast / (EARTH_RADIUS_MILES * Math.cos(toRadians(origin.lat))));
  return { lat: origin.lat + latDelta, lng: origin.lng + lngDelta };
}