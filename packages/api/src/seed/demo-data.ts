import type { LanePreference } from '@truckdesk/shared';

/**
 * Demo data for Ridgeway Freight LLC.
 *
 * Everything a Midwestern owner-operator's board actually looks like: an 8-truck
 * fleet running out of Columbus, OH, mixed trailer types, a reefer specialist, a
 * driver close to his hours, and 24 loads spread across every status so each
 * screen has something true to render.
 */

export const DEMO = {
  companyName: 'Ridgeway Freight LLC',
  mcNumber: 'MC-847201',
  dotNumber: 'DOT-3391782',
  terminal: 'Columbus, OH',
} as const;

interface DriverSpec {
  name: string;
  phone: string;
  email: string;
  /** Cents per mile for company drivers. */
  cpm: number;
  ownerOperator?: boolean;
  hazmat?: boolean;
  tanker?: boolean;
  lanes?: LanePreference[];
}

export interface TruckSpec {
  unit: string;
  status: 'available' | 'loaded' | 'empty' | 'maintenance';
  trailer: 'dry_van' | 'reefer' | 'flatbed';
  maxWeight: number;
  hos: 'off_duty' | 'sleeper' | 'available' | 'driving' | 'on_duty';
  odometer: number;
}

export interface LoadSpec {
  reference: string;
  broker: string;
  origin: string;
  destination: string;
  originFacility: string;
  destinationFacility: string;
  status: 'booked' | 'dispatched' | 'in-transit' | 'delivered' | 'paid';
  /** Cents. $1,850.00 is 185_000. */
  rate: number;
  miles: number;
  weightLbs: number;
  equipment: 'dry_van' | 'reefer' | 'flatbed';
  commodity: string;
  truckIndex: number;
  bookedHoursAgo: number;
  pickupOffsetHours: number;
  deliveryOffsetHours: number;
  pickedUpHoursAgo?: number;
  deliveredHoursAgo?: number;
  paidHoursAgo?: number;
  accessorials?: number;
  rateType?: 'flat' | 'per_mile';
  source?: 'manual' | 'email' | 'api';
  quickPay?: boolean;
  missingPod?: boolean;
}

export const FLAGS: {
  companyName: string;
  terminalPoints: string[];
  receivers: string[];
  drivers: DriverSpec[];
  trucks: TruckSpec[];
  loads: LoadSpec[];
  fuel: Array<{
    truckIndex: number;
    gallons: number;
    priceCents: number;
    odometer: number;
    state: string;
    hoursAgo: number;
    card: string;
  }>;
} = {
  companyName: DEMO.companyName,

  terminalPoints: [
    'Columbus, OH',
    'Cleveland, OH',
    'Cincinnati, OH',
    'Dayton, OH',
    'Toledo, OH',
    'Akron, OH',
    'Indianapolis, IN',
    'Louisville, KY',
  ],

  receivers: [
    'M. Alvarez - Receiving',
    'J. Whitfield - DC 3',
    'R. Okonkwo - Dock 12',
    'S. Patel - Night Receiving',
    'T. Nguyen - Warehouse',
    'K. Brennan - Yard Office',
  ],

  drivers: [
    {
      name: 'Marcus Bell',
      phone: '+16145550142',
      email: 'marcus@ridgewayfreight.com',
      cpm: 48,
      lanes: [
        { originState: 'OH', destinationState: 'PA', weight: 3 },
        { originState: 'OH', destinationState: 'NY', weight: 2 },
      ],
    },
    {
      name: 'Tanya Ruiz',
      phone: '+16145550157',
      email: 'tanya@ridgewayfreight.com',
      cpm: 52,
      hazmat: true,
      lanes: [
        { originState: 'OH', destinationState: 'IN', weight: 3 },
        { originState: 'OH', destinationState: 'MI', weight: 2 },
      ],
    },
    {
      name: 'Devon Carter',
      phone: '+16145550163',
      email: 'devon@ridgewayfreight.com',
      cpm: 46,
      tanker: true,
      lanes: [
        { originState: 'OH', destinationState: 'KY', weight: 3 },
        { originState: 'OH', destinationState: 'WV', weight: 1 },
      ],
    },
    {
      name: 'Priya Raman',
      phone: '+16145550179',
      email: 'priya@ridgewayfreight.com',
      cpm: 50,
      lanes: [{ originState: 'OH', destinationState: 'PA', weight: 4 }],
    },
    {
      name: 'Cole Whitfield',
      phone: '+16145550184',
      email: 'cole@ridgewayfreight.com',
      cpm: 45,
      ownerOperator: true,
      lanes: [
        { originState: 'OH', destinationState: 'IL', weight: 3 },
        { originState: 'OH', destinationState: 'TN', weight: 2 },
      ],
    },
    {
      name: 'Sam Okafor',
      phone: '+16145550196',
      email: 'sam@ridgewayfreight.com',
      cpm: 49,
      lanes: [{ originState: 'OH', destinationState: 'NC', weight: 2 }],
    },
    {
      name: 'Rosa Delgado',
      phone: '+16145550203',
      email: 'rosa@ridgewayfreight.com',
      cpm: 47,
      lanes: [{ originState: 'OH', destinationState: 'PA', weight: 2 }],
    },
    {
      name: 'Jim Brennan',
      phone: '+16145550217',
      email: 'jim@ridgewayfreight.com',
      cpm: 44,
      ownerOperator: true,
      lanes: [{ originState: 'OH', destinationState: 'WI', weight: 2 }],
    },
  ],

  trucks: [
    { unit: '101', status: 'loaded', trailer: 'dry_van', maxWeight: 45_000, hos: 'driving', odometer: 412_880 },
    { unit: '102', status: 'loaded', trailer: 'reefer', maxWeight: 43_500, hos: 'driving', odometer: 289_104 },
    { unit: '103', status: 'empty', trailer: 'dry_van', maxWeight: 45_000, hos: 'on_duty', odometer: 501_337 },
    { unit: '104', status: 'available', trailer: 'dry_van', maxWeight: 45_000, hos: 'sleeper', odometer: 355_602 },
    { unit: '105', status: 'loaded', trailer: 'flatbed', maxWeight: 48_000, hos: 'driving', odometer: 198_745 },
    { unit: '106', status: 'available', trailer: 'dry_van', maxWeight: 45_000, hos: 'off_duty', odometer: 623_918 },
    { unit: '107', status: 'maintenance', trailer: 'reefer', maxWeight: 43_500, hos: 'off_duty', odometer: 774_260 },
    { unit: '108', status: 'empty', trailer: 'dry_van', maxWeight: 45_000, hos: 'on_duty', odometer: 133_490 },
  ],

  // 24 loads: 6 booked, 4 dispatched, 3 in transit, 6 delivered, 5 paid.
  loads: [
    /* ---------------------------------------------------------- booked */
    {
      reference: 'RWF-1041', broker: 'Midwest Freight Systems',
      origin: 'Columbus, OH', destination: 'Pittsburgh, PA',
      originFacility: 'Ridgeway Freight - Columbus Terminal',
      destinationFacility: 'Consolidated Steel Receiving',
      status: 'booked', rate: 185_000, miles: 185, weightLbs: 38_400,
      equipment: 'dry_van', commodity: 'Rolled steel coil', truckIndex: 2,
      bookedHoursAgo: 2, pickupOffsetHours: 9, deliveryOffsetHours: 22,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1042', broker: 'Atlantic Logistics Co',
      origin: 'Cleveland, OH', destination: 'Buffalo, NY',
      originFacility: 'Lakeside Distribution', destinationFacility: 'Niagara Cold Storage',
      status: 'booked', rate: 92_500, miles: 191, weightLbs: 21_000,
      equipment: 'dry_van', commodity: 'Auto parts', truckIndex: 2,
      bookedHoursAgo: 5, pickupOffsetHours: 26, deliveryOffsetHours: 44,
      rateType: 'flat', source: 'email', quickPay: false,
    },
    {
      reference: 'RWF-1043', broker: 'Heartland Produce',
      origin: 'Dayton, OH', destination: 'Chicago, IL',
      originFacility: 'Heartland Cold Storage', destinationFacility: 'Midway Grocers DC 4',
      status: 'booked', rate: 268_000, miles: 296, weightLbs: 41_200,
      equipment: 'reefer', commodity: 'Fresh produce, 34F', truckIndex: 1,
      bookedHoursAgo: 1, pickupOffsetHours: 4, deliveryOffsetHours: 20,
      accessorials: 18_500, rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1044', broker: 'Great Lakes Chemical',
      origin: 'Toledo, OH', destination: 'Indianapolis, IN',
      originFacility: 'Toledo Terminal 2', destinationFacility: 'Glenns Ferry Plant',
      status: 'booked', rate: 143_000, miles: 218, weightLbs: 42_800,
      equipment: 'dry_van', commodity: 'Non-hazmat industrial solvent', truckIndex: 3,
      bookedHoursAgo: 14, pickupOffsetHours: 20, deliveryOffsetHours: 38,
      rateType: 'flat', source: 'manual', quickPay: true,
    },
    {
      reference: 'RWF-1045', broker: 'Summit Building Supply',
      origin: 'Akron, OH', destination: 'Nashville, TN',
      originFacility: 'Summit Yard 1', destinationFacility: 'Cumberland Materials',
      status: 'booked', rate: 312_000, miles: 512, weightLbs: 44_600,
      equipment: 'dry_van', commodity: 'Dried lumber bundles', truckIndex: 5,
      bookedHoursAgo: 30, pickupOffsetHours: 30, deliveryOffsetHours: 58,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1046', broker: 'Keystone Flatbed',
      origin: 'Columbus, OH', destination: 'Charleston, WV',
      originFacility: 'Ridgeway Freight - Columbus Yard',
      destinationFacility: 'Kanawha Steel Yard',
      status: 'booked', rate: 224_000, miles: 226, weightLbs: 47_200,
      equipment: 'flatbed', commodity: 'Structural steel plate', truckIndex: 4,
      bookedHoursAgo: 7, pickupOffsetHours: 14, deliveryOffsetHours: 30,
      rateType: 'flat', source: 'api', quickPay: true,
    },

    /* ------------------------------------------------------ dispatched */
    {
      reference: 'RWF-1039', broker: 'Midwest Freight Systems',
      origin: 'Columbus, OH', destination: 'Fort Wayne, IN',
      originFacility: 'Ridgeway Freight - Columbus Terminal',
      destinationFacility: 'Fort Wayne Manufacturing',
      status: 'dispatched', rate: 128_000, miles: 178, weightLbs: 33_100,
      equipment: 'dry_van', commodity: 'Automotive fasteners', truckIndex: 2,
      bookedHoursAgo: 9, pickupOffsetHours: 2, deliveryOffsetHours: 9,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1040', broker: 'Blue Ridge Distribution',
      origin: 'Cincinnati, OH', destination: 'Greenville, SC',
      originFacility: 'Blue Ridge Crossdock', destinationFacility: 'Greenville DC 2',
      status: 'dispatched', rate: 246_000, miles: 487, weightLbs: 36_800,
      equipment: 'dry_van', commodity: 'Retail goods', truckIndex: 5,
      bookedHoursAgo: 11, pickupOffsetHours: 6, deliveryOffsetHours: 26,
      rateType: 'flat', source: 'email', quickPay: false,
    },
    {
      reference: 'RWF-1038', broker: 'Heartland Produce',
      origin: 'Dayton, OH', destination: 'Detroit, MI',
      originFacility: 'Heartland Cold Storage', destinationFacility: 'Great Lakes Grocers',
      status: 'dispatched', rate: 158_000, miles: 233, weightLbs: 39_900,
      equipment: 'reefer', commodity: 'Frozen prepared foods', truckIndex: 1,
      bookedHoursAgo: 6, pickupOffsetHours: 1, deliveryOffsetHours: 11,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1037', broker: 'Iron Ridge Steel',
      origin: 'Columbus, OH', destination: 'Louisville, KY',
      originFacility: 'Ridgeway Freight - Columbus Yard',
      destinationFacility: 'Iron Ridge Mill',
      status: 'dispatched', rate: 132_000, miles: 205, weightLbs: 46_900,
      equipment: 'flatbed', commodity: 'Steel coils, tarped', truckIndex: 4,
      bookedHoursAgo: 4, pickupOffsetHours: 8, deliveryOffsetHours: 20,
      rateType: 'flat', source: 'manual', quickPay: true,
    },

    /* ------------------------------------------------------ in transit */
    {
      reference: 'RWF-1036', broker: 'Atlantic Logistics Co',
      origin: 'Cleveland, OH', destination: 'Pittsburgh, PA',
      originFacility: 'Lakeside Distribution', destinationFacility: 'Aliquippa Metals',
      status: 'in-transit', rate: 86_000, miles: 132, weightLbs: 28_400,
      equipment: 'dry_van', commodity: 'Aluminum extrusions', truckIndex: 0,
      bookedHoursAgo: 16, pickupOffsetHours: -6, deliveryOffsetHours: 3,
      pickedUpHoursAgo: 6, rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1035', broker: 'Heartland Produce',
      origin: 'Dayton, OH', destination: 'Indianapolis, IN',
      originFacility: 'Heartland Cold Storage', destinationFacility: 'Circle City Market',
      status: 'in-transit', rate: 118_000, miles: 118, weightLbs: 37_500,
      equipment: 'reefer', commodity: 'Fresh dairy, 38F', truckIndex: 1,
      bookedHoursAgo: 20, pickupOffsetHours: -8, deliveryOffsetHours: -1,
      pickedUpHoursAgo: 8, rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1034', broker: 'Keystone Flatbed',
      origin: 'Toledo, OH', destination: 'Columbus, OH',
      originFacility: 'Toledo Terminal 2', destinationFacility: 'Ridgeway Freight - Columbus Yard',
      status: 'in-transit', rate: 64_000, miles: 152, weightLbs: 41_800,
      equipment: 'flatbed', commodity: 'Machined components', truckIndex: 4,
      bookedHoursAgo: 22, pickupOffsetHours: -5, deliveryOffsetHours: 4,
      pickedUpHoursAgo: 5, rateType: 'flat', source: 'api', quickPay: false,
    },

    /* ------------------------------------------------------- delivered */
    {
      reference: 'RWF-1033', broker: 'Midwest Freight Systems',
      origin: 'Columbus, OH', destination: 'Cleveland, OH',
      originFacility: 'Ridgeway Freight - Columbus Terminal',
      destinationFacility: 'Lakeside Distribution',
      status: 'delivered', rate: 74_000, miles: 142, weightLbs: 34_200,
      equipment: 'dry_van', commodity: 'Packaged beverages', truckIndex: 0,
      bookedHoursAgo: 74, pickupOffsetHours: -50, deliveryOffsetHours: -44,
      pickedUpHoursAgo: 50, deliveredHoursAgo: 44,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1032', broker: 'Summit Building Supply',
      origin: 'Akron, OH', destination: 'Columbus, OH',
      originFacility: 'Summit Yard 1', destinationFacility: 'Ridgeway Freight - Columbus Terminal',
      status: 'delivered', rate: 52_000, miles: 62, weightLbs: 39_000,
      equipment: 'dry_van', commodity: 'Cement and masonry', truckIndex: 7,
      bookedHoursAgo: 96, pickupOffsetHours: -70, deliveryOffsetHours: -68,
      pickedUpHoursAgo: 70, deliveredHoursAgo: 68,
      rateType: 'flat', source: 'manual', quickPay: true,
    },
    {
      reference: 'RWF-1031', broker: 'Great Lakes Chemical',
      origin: 'Toledo, OH', destination: 'Akron, OH',
      originFacility: 'Toledo Terminal 2', destinationFacility: 'Summit Rubber Works',
      status: 'delivered', rate: 96_000, miles: 194, weightLbs: 43_100,
      equipment: 'dry_van', commodity: 'Industrial solvent, non-hazmat', truckIndex: 3,
      bookedHoursAgo: 120, pickupOffsetHours: -92, deliveryOffsetHours: -86,
      pickedUpHoursAgo: 92, deliveredHoursAgo: 86,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      // Deliberately missing its POD: this is the exception a dispatcher chases.
      reference: 'RWF-1030', broker: 'Blue Ridge Distribution',
      origin: 'Cincinnati, OH', destination: 'Columbus, OH',
      originFacility: 'Blue Ridge Crossdock', destinationFacility: 'Ridgeway Freight - Columbus Terminal',
      status: 'delivered', rate: 78_000, miles: 108, weightLbs: 26_800,
      equipment: 'dry_van', commodity: 'General freight', truckIndex: 5,
      bookedHoursAgo: 144, pickupOffsetHours: -110, deliveryOffsetHours: -104,
      pickedUpHoursAgo: 110, deliveredHoursAgo: 104,
      rateType: 'flat', source: 'email', quickPay: true, missingPod: true,
    },
    {
      reference: 'RWF-1029', broker: 'Atlantic Logistics Co',
      origin: 'Cleveland, OH', destination: 'Columbus, OH',
      originFacility: 'Lakeside Distribution', destinationFacility: 'Ridgeway Freight - Columbus Terminal',
      status: 'delivered', rate: 71_000, miles: 142, weightLbs: 31_600,
      equipment: 'dry_van', commodity: 'Automotive castings', truckIndex: 6,
      bookedHoursAgo: 168, pickupOffsetHours: -130, deliveryOffsetHours: -124,
      pickedUpHoursAgo: 130, deliveredHoursAgo: 124,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1028', broker: 'Heartland Produce',
      origin: 'Dayton, OH', destination: 'Columbus, OH',
      originFacility: 'Heartland Cold Storage', destinationFacility: 'Ridgeway Freight - Columbus Terminal',
      status: 'delivered', rate: 68_000, miles: 72, weightLbs: 38_900,
      equipment: 'reefer', commodity: 'Fresh produce, 36F', truckIndex: 1,
      bookedHoursAgo: 190, pickupOffsetHours: -156, deliveryOffsetHours: -152,
      pickedUpHoursAgo: 156, deliveredHoursAgo: 152,
      rateType: 'flat', source: 'email', quickPay: true,
    },

    /* ------------------------------------------------------------- paid */
    {
      reference: 'RWF-1027', broker: 'Midwest Freight Systems',
      origin: 'Columbus, OH', destination: 'Fort Wayne, IN',
      originFacility: 'Ridgeway Freight - Columbus Terminal',
      destinationFacility: 'Fort Wayne Manufacturing',
      status: 'paid', rate: 126_000, miles: 178, weightLbs: 35_700,
      equipment: 'dry_van', commodity: 'Industrial fasteners', truckIndex: 0,
      bookedHoursAgo: 340, pickupOffsetHours: -300, deliveryOffsetHours: -294,
      pickedUpHoursAgo: 300, deliveredHoursAgo: 294, paidHoursAgo: 40,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1026', broker: 'Iron Ridge Steel',
      origin: 'Columbus, OH', destination: 'Pittsburgh, PA',
      originFacility: 'Ridgeway Freight - Columbus Yard',
      destinationFacility: 'Aliquippa Metals',
      status: 'paid', rate: 182_000, miles: 185, weightLbs: 45_100,
      equipment: 'flatbed', commodity: 'Steel plate', truckIndex: 4,
      bookedHoursAgo: 362, pickupOffsetHours: -320, deliveryOffsetHours: -312,
      pickedUpHoursAgo: 320, deliveredHoursAgo: 312, paidHoursAgo: 52,
      rateType: 'flat', source: 'manual', quickPay: false,
    },
    {
      reference: 'RWF-1025', broker: 'Summit Building Supply',
      origin: 'Akron, OH', destination: 'Indianapolis, IN',
      originFacility: 'Summit Yard 1', destinationFacility: 'Circle City Supply',
      status: 'paid', rate: 168_000, miles: 286, weightLbs: 42_300,
      equipment: 'dry_van', commodity: 'Lumber and building materials', truckIndex: 5,
      bookedHoursAgo: 388, pickupOffsetHours: -344, deliveryOffsetHours: -336,
      pickedUpHoursAgo: 344, deliveredHoursAgo: 336, paidHoursAgo: 28,
      rateType: 'flat', source: 'email', quickPay: true,
    },
    {
      reference: 'RWF-1024', broker: 'Blue Ridge Distribution',
      origin: 'Cincinnati, OH', destination: 'Detroit, MI',
      originFacility: 'Blue Ridge Crossdock', destinationFacility: 'Great Lakes Grocers',
      status: 'paid', rate: 214_000, miles: 289, weightLbs: 40_800,
      equipment: 'dry_van', commodity: 'Mixed retail', truckIndex: 7,
      bookedHoursAgo: 412, pickupOffsetHours: -368, deliveryOffsetHours: -358,
      pickedUpHoursAgo: 368, deliveredHoursAgo: 358, paidHoursAgo: 60,
      rateType: 'flat', source: 'api', quickPay: true,
    },
    {
      reference: 'RWF-1023', broker: 'Great Lakes Chemical',
      origin: 'Toledo, OH', destination: 'Cleveland, OH',
      originFacility: 'Toledo Terminal 2', destinationFacility: 'Lakeside Distribution',
      status: 'paid', rate: 58_000, miles: 62, weightLbs: 41_500,
      equipment: 'dry_van', commodity: 'Industrial solvent, non-hazmat', truckIndex: 3,
      bookedHoursAgo: 438, pickupOffsetHours: -396, deliveryOffsetHours: -392,
      pickedUpHoursAgo: 396, deliveredHoursAgo: 392, paidHoursAgo: 76,
      rateType: 'flat', source: 'email', quickPay: true,
    },
  ],

  fuel: [
    { truckIndex: 0, gallons: 128.4, priceCents: 388, odometer: 412_640, state: 'OH', hoursAgo: 12, card: '4417' },
    { truckIndex: 0, gallons: 141.2, priceCents: 394, odometer: 412_880, state: 'PA', hoursAgo: 3, card: '4417' },
    { truckIndex: 1, gallons: 116.8, priceCents: 391, odometer: 288_742, state: 'OH', hoursAgo: 20, card: '4418' },
    { truckIndex: 2, gallons: 152.6, priceCents: 386, odometer: 501_104, state: 'OH', hoursAgo: 30, card: '4419' },
    { truckIndex: 4, gallons: 98.4, priceCents: 402, odometer: 198_560, state: 'IN', hoursAgo: 26, card: '4421' },
    { truckIndex: 5, gallons: 137.9, priceCents: 389, odometer: 355_180, state: 'WV', hoursAgo: 44, card: '4422' },
    { truckIndex: 7, gallons: 104.1, priceCents: 383, odometer: 133_220, state: 'OH', hoursAgo: 52, card: '4424' },
  ],
} as const;