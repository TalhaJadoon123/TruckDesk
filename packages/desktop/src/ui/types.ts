export interface TruckDeskBridge {
  version(): Promise<{
    app: string;
    electron: string;
    node: string;
    apiUrl: string;
    platform: string;
  }>;
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    truckdesk?: TruckDeskBridge;
  }
}

export {};