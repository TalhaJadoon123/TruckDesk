'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

import type { TrackResponse } from '@/lib/api';
import { Card, EmptyState, Spinner } from '@/components/ui';

/**
 * Fleet map.
 *
 * Leaflet is dynamically imported with SSR disabled: it touches `window` at
 * module scope, so a static import breaks the server render. It is MIT-licensed,
 * needs no API key, and reads tiles from OpenStreetMap.
 */

const MapContainer = dynamic(
  () => import('react-leaflet').then((module) => module.MapContainer),
  { ssr: false, loading: () => <Spinner label="Loading map" /> },
);

const TileLayer = dynamic(
  () => import('react-leaflet').then((module) => module.TileLayer),
  { ssr: false },
);

const Marker = dynamic(() => import('react-leaflet').then((module) => module.Marker), {
  ssr: false,
});

const Popup = dynamic(() => import('react-leaflet').then((module) => module.Popup), {
  ssr: false,
});

const Polyline = dynamic(
  () => import('react-leaflet').then((module) => module.Polyline),
  { ssr: false },
);

const L = dynamic(() => import('leaflet'), { ssr: false });

const TRUCK_COLOR: Record<string, string> = {
  available: '#3ecf8e',
  loaded: '#37c97a',
  empty: '#f0c04a',
  maintenance: '#e05a4a',
};

/** OSM tiles. Free, no key, but their policy requires a real User-Agent. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function FleetMap({ track, height = 480 }: { track: TrackResponse | null; height?: number }) {
  const [leaflet, setLeaflet] = useState<typeof import('leaflet') | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import('leaflet').then((module) => {
      if (!cancelled) setLeaflet(module.default ?? module);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const icon = useMemo(() => {
    if (!leaflet) return undefined;
    return (color: string, label: string) =>
      leaflet.divIcon({
        className: 'truck-marker',
        html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #0d0d12;box-shadow:0 1px 4px rgba(0,0,0,.6)"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -12],
        // The label is decorative; the popup carries the real information.
        alt: label,
      });
  }, [leaflet]);

  if (!track) {
    return (
      <Card>
        <EmptyState title="No positions yet" detail="Trucks appear here once the first ping arrives." />
      </Card>
    );
  }

  if (track.positions.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No trucks reporting"
          detail="Either the fleet has no trucks, or the API is running without GPS data."
        />
      </Card>
    );
  }

  const points: Array<[number, number]> = track.positions.map((position) => [
    position.location.lat,
    position.location.lng,
  ]);

  const center = points.reduce<[number, number]>(
    (accumulator, point) => [
      accumulator[0] + point[0] / points.length,
      accumulator[1] + point[1] / points.length,
    ],
    [0, 0],
  );

  return (
    <div style={{ height }} className="w-full">
      <MapContainer
        center={center}
        zoom={5}
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />

        {track.loads.map((progress) => {
          if (!progress.current || !progress.destination) return null;
          const pointsForLoad: Array<[number, number]> = [];
          if (progress.origin) pointsForLoad.push([progress.origin.lat, progress.origin.lng]);
          pointsForLoad.push([progress.current.lat, progress.current.lng]);
          pointsForLoad.push([progress.destination.lat, progress.destination.lng]);

          return (
            <Polyline
              key={progress.loadId}
              positions={pointsForLoad}
              pathOptions={{
                color: '#f0c04a',
                weight: 2,
                opacity: 0.6,
                dashArray: '4 6',
              }}
            />
          );
        })}

        {track.positions.map((position) => {
          const truck = track.trucks.find((entry) => entry.id === position.truckId);
          const status = truck?.status ?? position.status;

          return (
            <Marker
              key={position.truckId}
              position={[position.location.lat, position.location.lng]}
              icon={icon?.(TRUCK_COLOR[status] ?? '#8b8b9e', position.unit)}
            >
              <Popup>
                <div>
                  <div className="font-semibold">{position.unit}</div>
                  <div className="text-xs opacity-80">{status}</div>
                  {position.speedMph ? (
                    <div className="text-xs opacity-80">{Math.round(position.speedMph)} mph</div>
                  ) : null}
                  <div className="text-xs opacity-70">
                    {position.isStale
                      ? `No ping for ${position.staleMinutes}m`
                      : 'Pinged just now'}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}

/** Leaflet needs its CSS. Importing it here keeps it out of the server bundle. */
export function MapStyles() {
  return (
    <style>{`
      .truck-marker { background: transparent; border: 0; }
      .leaflet-container { background: #16161c; }
    `}</style>
  );
}