import type {
	NativeMenuBridge,
	NativeNotificationBridge,
	NativeNotificationInput,
	NativeUpdateBridge,
	NativeUpdateState,
	NativeWindowControlsBridge,
	NativeWindowState,
} from "@thinkrail/contracts";
import { contextBridge, ipcRenderer } from "electron";
import {
	isDesktopPreferenceKey,
	isDesktopPreferenceValue,
	STABLE_PREFERENCES_GLOBAL,
} from "./preferenceAdapter";
import { createShortcutsBridge } from "./shortcutsBridge";
import { NATIVE_WINDOW_CONTROLS_GLOBAL } from "./windowChrome";

function exposeGlobal(name: string, value: unknown) {
	try {
		contextBridge.exposeInMainWorld(name, value);
	} catch {
		// Fallback if contextIsolation is disabled
	}
	try {
		Object.defineProperty(window, name, {
			value,
			writable: false,
			configurable: false,
			enumerable: false,
		});
	} catch {
		// Ignored if already defined by contextBridge
	}
}

// 1. Window Chrome CSS custom properties
function updateWindowChromeStyle(insets: {
	insetLeft?: number;
	insetRight?: number;
	dragRegion?: boolean;
}) {
	const root = document.documentElement;
	if (!root) return;
	if (typeof insets.insetLeft === "number") {
		root.style.setProperty("--window-chrome-inset-left", `${insets.insetLeft}px`);
	}
	if (typeof insets.insetRight === "number") {
		root.style.setProperty("--window-chrome-inset-right", `${insets.insetRight}px`);
	}
	if (typeof insets.dragRegion === "boolean") {
		root.style.setProperty("--window-chrome-drag-region", insets.dragRegion ? "drag" : "no-drag");
	}
}

ipcRenderer.on("thinkrail:window-chrome-changed", (_event, insets) => {
	updateWindowChromeStyle(insets);
});

document.addEventListener(
	"DOMContentLoaded",
	() => {
		ipcRenderer
			.invoke("thinkrail:get-window-chrome")
			.then((insets) => {
				if (insets) updateWindowChromeStyle(insets);
			})
			.catch(() => undefined);
	},
	{ once: true },
);

// 2. Shortcuts bridge (__THINKRAIL_NATIVE_SHORTCUTS__)
const shortcuts = createShortcutsBridge(() => ipcRenderer.invoke("thinkrail:quit-app"));
ipcRenderer.on("thinkrail:quit-hint-changed", (_event, { hint }) => {
	shortcuts.emitQuitHint(hint);
});
ipcRenderer.on("thinkrail:native-command", (_event, { command }) => {
	shortcuts.emitCommand(command);
});
exposeGlobal("__THINKRAIL_NATIVE_SHORTCUTS__", shortcuts.bridge);

// 3. Notifications bridge (__THINKRAIL_NATIVE_NOTIFICATIONS__)
let nativeWindowFocused = document.hasFocus();
window.addEventListener("focus", () => {
	nativeWindowFocused = true;
});
window.addEventListener("blur", () => {
	nativeWindowFocused = false;
});
ipcRenderer.on("thinkrail:window-focus-changed", (_event, { focused }) => {
	nativeWindowFocused = focused;
});
const notificationBridge: NativeNotificationBridge = Object.freeze({
	show: (input: NativeNotificationInput) => {
		ipcRenderer.invoke("thinkrail:show-notification", input).catch(() => undefined);
	},
	isWindowFocused: () => nativeWindowFocused,
});
exposeGlobal("__THINKRAIL_NATIVE_NOTIFICATIONS__", notificationBridge);

// 4. Menu labels bridge (__THINKRAIL_NATIVE_MENU__)
const menuBridge: NativeMenuBridge = Object.freeze({
	setLabels: (labels: Readonly<Record<string, string>>) => {
		ipcRenderer.send("thinkrail:menu-labels-changed", { labels: { ...labels } });
	},
});
exposeGlobal("__THINKRAIL_NATIVE_MENU__", menuBridge);

// 5. Window controls bridge (__THINKRAIL_NATIVE_WINDOW_CONTROLS__)
const windowStateListeners = new Set<(state: NativeWindowState) => void>();
ipcRenderer.on("thinkrail:window-state-changed", (_event, state: NativeWindowState) => {
	for (const listener of windowStateListeners) listener(state);
});
const windowControlsBridge: NativeWindowControlsBridge = Object.freeze({
	getState: () => ipcRenderer.invoke("thinkrail:get-window-state"),
	minimize: () => ipcRenderer.invoke("thinkrail:minimize-window"),
	toggleMaximize: () => ipcRenderer.invoke("thinkrail:toggle-maximize-window"),
	close: () => ipcRenderer.invoke("thinkrail:close-window"),
	subscribe: (listener: (state: NativeWindowState) => void) => {
		windowStateListeners.add(listener);
		return () => windowStateListeners.delete(listener);
	},
});
exposeGlobal(NATIVE_WINDOW_CONTROLS_GLOBAL, windowControlsBridge);

// 6. Update bridge (__THINKRAIL_NATIVE_UPDATES__)
const updateListeners = new Set<(state: NativeUpdateState) => void>();
ipcRenderer.on("thinkrail:update-state-changed", (_event, state: NativeUpdateState) => {
	for (const listener of updateListeners) listener(state);
});
const updateBridge: NativeUpdateBridge = Object.freeze({
	getState: () => ipcRenderer.invoke("thinkrail:get-update-state"),
	checkForUpdates: () => ipcRenderer.invoke("thinkrail:check-for-updates"),
	downloadUpdate: () => ipcRenderer.invoke("thinkrail:download-update"),
	restartToUpdate: () => ipcRenderer.invoke("thinkrail:restart-to-update"),
	dismissInstallResult: () => ipcRenderer.invoke("thinkrail:dismiss-install-result"),
	subscribe: (listener: (state: NativeUpdateState) => void) => {
		updateListeners.add(listener);
		return () => updateListeners.delete(listener);
	},
});
exposeGlobal("__THINKRAIL_NATIVE_UPDATES__", updateBridge);

// 7. Stable preferences bridge
const preferences = new Map<string, string>();
const preferenceAdapter = Object.freeze({
	getItem: (key: string) => (isDesktopPreferenceKey(key) ? (preferences.get(key) ?? null) : null),
	setItem: (key: string, value: string) => {
		if (!isDesktopPreferenceKey(key) || !isDesktopPreferenceValue(value)) return;
		preferences.set(key, value);
		ipcRenderer.send("thinkrail:preference-write", { key, value });
	},
	removeItem: (key: string) => {
		if (!isDesktopPreferenceKey(key)) return;
		preferences.delete(key);
		ipcRenderer.send("thinkrail:preference-remove", { key });
	},
});
exposeGlobal(STABLE_PREFERENCES_GLOBAL, preferenceAdapter);

// 8. Route change reporting
const sendRoute = () => {
	ipcRenderer.send("thinkrail:route-changed", { hash: window.location.hash });
};
const replaceState = history.replaceState.bind(history);
history.replaceState = (...args: Parameters<History["replaceState"]>) => {
	replaceState(...args);
	sendRoute();
};
const pushState = history.pushState.bind(history);
history.pushState = (...args: Parameters<History["pushState"]>) => {
	pushState(...args);
	sendRoute();
};
window.addEventListener("hashchange", sendRoute);
window.addEventListener("popstate", sendRoute);
window.addEventListener("DOMContentLoaded", sendRoute);
queueMicrotask(sendRoute);
