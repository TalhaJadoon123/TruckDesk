import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/**
 * Electron main process.
 *
 * The desktop app is a thin shell over the same HTTP API the web tier uses.
 * That is deliberate: there is one implementation of dispatch, and the desktop
 * build cannot drift from it.
 *
 * It also starts the TruckDesk API as a child process when it is not already
 * running, so a dispatcher can double-click the app on a laptop in a truck stop
 * with no server, no terminal and no Docker.
 */

const isDev = !app.isPackaged;
const PORT = Number(process.env['TRUCKDESK_PORT'] ?? 4000);
const API_URL = process.env['TRUCKDESK_API_URL'] ?? `http://127.0.0.1:${PORT}`;

let mainWindow: BrowserWindow | null = null;
let apiProcess: ChildProcess | null = null;

/** Only the app's own origin may be loaded in the main window. */
const ALLOWED_ORIGINS = [
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'file://',
];

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#16161c',
    title: 'TruckDesk',
    show: false,
    webPreferences: {
      // Context isolation stays on and node integration stays off: the renderer
      // is untrusted input as far as the OS is concerned, because it renders
      // broker emails, load references and driver names.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Nothing external may navigate the shell out of the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Links to outside sources open in the real browser, not inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void mainWindow.loadURL(`http://127.0.0.1:${5173}`);
  } else {
    void mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }
}

function isAllowed(url: string): boolean {
  return ALLOWED_ORIGINS.some((origin) => url.startsWith(origin));
}

/**
 * Start the API if nothing is already listening.
 *
 * Only in a packaged build and only when the port is free, so a developer with
 * `pnpm dev` running never gets a second server fighting for the port.
 */
async function ensureApi(): Promise<void> {
  if (isDev) return;
  if (await isPortOpen(PORT)) return;

  const entry = path.join(process.resourcesPath ?? __dirname, '..', '..', 'api', 'dist', 'main.js');
  if (!existsSync(entry)) {
    console.warn(`[truckdesk] API bundle not found at ${entry}; expecting it on ${API_URL}`);
    return;
  }

  apiProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'inherit',
  });

  apiProcess.on('exit', (code: number | null) => {
    console.warn(`[truckdesk] API exited with code ${code}`);
    apiProcess = null;
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.reload(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => void shell.openExternal('https://truckdesk.pages.dev/docs'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

void app.whenReady().then(async () => {
  await ensureApi();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  apiProcess?.kill();
  apiProcess = null;
});

/* -------------------------------------------------------------------------- */
/* IPC: a deliberately tiny, read-only surface                                   */
/* -------------------------------------------------------------------------- */

ipcMain.handle('truckdesk:version', () => ({
  app: app.getVersion(),
  electron: process.versions['electron'] ?? '',
  node: process.versions['node'] ?? '',
  apiUrl: API_URL,
  platform: process.platform,
}));

ipcMain.handle('truckdesk:open-external', async (_event, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: 'Only http and https URLs may be opened externally' };
});