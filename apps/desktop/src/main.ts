import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	ipcMain,
	Menu,
	type MenuItemConstructorOptions,
	Notification,
	type NotificationConstructorOptions,
	shell,
} from "electron";
import { PreferenceStore } from "./preferenceStore";
import { RouteStore } from "./routeStore";
import { type SidecarInstance, startBunSidecar } from "./sidecar";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BACKEND_PROFILE_ID = "local";
const WINDOW_ID = "main";

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarInstance | null = null;
let isQuitting = false;

// Enforce single instance
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
	app.quit();
	process.exit(0);
}

app.on("second-instance", () => {
	if (mainWindow) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	}
});

function getChromeGeometry() {
	const platform = process.platform;
	if (platform === "darwin") {
		return { insetLeft: 64, insetRight: 0, dragRegion: true };
	}
	if (platform === "win32") {
		return { insetLeft: 0, insetRight: 138, dragRegion: true };
	}
	return { insetLeft: 0, insetRight: 0, dragRegion: false };
}

function broadcastWindowState(win: BrowserWindow) {
	if (win.isDestroyed()) return;
	const state = {
		isMaximized: win.isMaximized(),
		isFullScreen: win.isFullScreen(),
	};
	win.webContents.send("thinkrail:window-state-changed", state);
}

function setupApplicationMenu(win: BrowserWindow) {
	const isMac = process.platform === "darwin";

	const template: MenuItemConstructorOptions[] = [];

	if (isMac) {
		template.push({
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" as const },
				{
					label: "Settings…",
					accelerator: "CmdOrCtrl+,",
					click: () => {
						win.webContents.send("thinkrail:native-command", { command: "open-settings" });
					},
				},
				{ type: "separator" as const },
				{ role: "services" },
				{ type: "separator" as const },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" as const },
				{
					label: "Quit ThinkRail",
					accelerator: "CmdOrCtrl+Q",
					click: () => {
						app.quit();
					},
				},
			],
		});
	}

	template.push(
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" as const },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" as const },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" as const },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				...(isMac
					? [
							{ type: "separator" as const },
							{ role: "front" as const },
							{ type: "separator" as const },
							{ role: "window" as const },
						]
					: [{ role: "close" as const }]),
			],
		},
	);

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

async function createWindow() {
	const isMac = process.platform === "darwin";
	const isWin = process.platform === "win32";

	const userDataPath = app.getPath("userData");
	const routeStore = new RouteStore(join(userDataPath, "routes.json"));
	const preferenceStore = new PreferenceStore(join(userDataPath, "preferences.json"));

	// Preload file is in dist/preload.cjs
	const preloadPath = join(__dirname, "preload.cjs");

	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		title: "ThinkRail",
		show: false,
		backgroundColor: "#18181b",
		titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
		...(isMac ? { trafficLightPosition: { x: 16, y: 12 } } : {}),
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	mainWindow = win;

	// IPC handlers
	ipcMain.handle("thinkrail:get-window-chrome", () => getChromeGeometry());
	ipcMain.handle("thinkrail:get-window-state", () => ({
		isMaximized: win.isMaximized(),
		isFullScreen: win.isFullScreen(),
	}));
	ipcMain.handle("thinkrail:minimize-window", () => win.minimize());
	ipcMain.handle("thinkrail:toggle-maximize-window", () => {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	});
	ipcMain.handle("thinkrail:close-window", () => win.close());
	ipcMain.handle("thinkrail:quit-app", () => app.quit());

	ipcMain.handle(
		"thinkrail:show-notification",
		(_event, input: { title: string; subtitle?: string; body: string; silent?: boolean }) => {
			if (Notification.isSupported()) {
				const opts: NotificationConstructorOptions = {
					title: input.title,
					body: input.body,
				};
				if (input.subtitle) opts.subtitle = input.subtitle;
				if (typeof input.silent === "boolean") opts.silent = input.silent;
				const notification = new Notification(opts);
				notification.on("click", () => {
					if (!win.isDestroyed()) {
						if (win.isMinimized()) win.restore();
						win.focus();
					}
				});
				notification.show();
			}
		},
	);

	ipcMain.handle("thinkrail:get-update-state", () => ({ state: "idle" }));
	ipcMain.handle("thinkrail:check-for-updates", async () => undefined);
	ipcMain.handle("thinkrail:download-update", async () => undefined);
	ipcMain.handle("thinkrail:restart-to-update", async () => {
		app.relaunch();
		app.exit(0);
	});
	ipcMain.handle("thinkrail:dismiss-install-result", async () => undefined);

	ipcMain.on("thinkrail:route-changed", (_event, { hash }: { hash: string }) => {
		routeStore.write(BACKEND_PROFILE_ID, WINDOW_ID, hash);
	});

	ipcMain.on(
		"thinkrail:preference-write",
		(_event, { key, value }: { key: string; value: string }) => {
			preferenceStore.write(BACKEND_PROFILE_ID, WINDOW_ID, key, value);
		},
	);

	ipcMain.on("thinkrail:preference-remove", (_event, { key }: { key: string }) => {
		preferenceStore.remove(BACKEND_PROFILE_ID, WINDOW_ID, key);
	});

	// Window events
	win.on("maximize", () => broadcastWindowState(win));
	win.on("unmaximize", () => broadcastWindowState(win));
	win.on("enter-full-screen", () => broadcastWindowState(win));
	win.on("leave-full-screen", () => broadcastWindowState(win));
	win.on("focus", () => win.webContents.send("thinkrail:window-focus-changed", { focused: true }));
	win.on("blur", () => win.webContents.send("thinkrail:window-focus-changed", { focused: false }));

	// External links open in default OS browser
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
			void shell.openExternal(url);
		}
		return { action: "deny" };
	});

	// Start Bun Sidecar
	try {
		console.log("[desktop] Starting ThinkRail Bun server sidecar...");
		sidecar = await startBunSidecar({
			isPackaged: app.isPackaged,
			appPath: app.getAppPath(),
		});
		console.log(`[desktop] Sidecar ready at ${sidecar.origin}`);

		const initialRoute = routeStore.read(BACKEND_PROFILE_ID, WINDOW_ID);
		const targetUrl = `${sidecar.origin}${initialRoute || ""}`;

		await win.loadURL(targetUrl);
		win.show();
		setupApplicationMenu(win);
	} catch (err) {
		console.error("[desktop] Failed to start sidecar or load window:", err);
		app.quit();
	}

	win.on("closed", () => {
		mainWindow = null;
	});
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});

app.on("before-quit", async (event) => {
	if (isQuitting) return;
	event.preventDefault();
	isQuitting = true;
	console.log("[desktop] Shutting down Bun sidecar...");
	try {
		if (sidecar) {
			await sidecar.stop();
			sidecar = null;
		}
	} catch (err) {
		console.error("[desktop] Error stopping sidecar:", err);
	}
	app.exit(0);
});
