---
id: module-desktop
type: module-design
status: active
title: Desktop launcher/client (Electron)
parent: architecture
depends-on: [module-server, module-contracts, module-shared]
tags: [desktop, launcher, packaging]
references: [submodule-web-navigation, module-artifact-tests, module-ci-release, submodule-web-shell, module-cli]
---

## Responsibility

The native Electron launcher/client over the existing web UI and wire. The local-host profile uses
Electron for native shell window management, menus, and operating-system integration, while managing
a dedicated Bun sidecar child process running `@thinkrail/server` on an ephemeral loopback port.
`apps/cli` remains the sibling browser launcher.

## Boundary

- **Owns:** Electron configuration and lifecycle; Bun sidecar process lifecycle management;
  native window policy and window-chrome geometry published to the web client; desktop route
  preload/persistence; bounded generic client-preference adapter; and Electron Preload bridges conforming
  to `@thinkrail/contracts`.
- **Public surface:** The packaged desktop application.
- **Allowed deps:** `server` via the Bun sidecar runner; `shared` for release identity; `contracts`
  for native bridge types and quit rules; built web artifact; `electron`.
- **Forbidden:** Implementing ordinary product features or agent/domain logic in the Electron main process;
  importing web source at runtime; altering the existing `@thinkrail/contracts` wire format or UI state model.

## Profile and topology

The desktop app runs a dual-process topology:
1. **Electron Main Process:** Node.js-based Electron process managing window lifecycle, native menus,
   shortcuts, OS notifications, and process coordination.
2. **Bun Server Sidecar:** Dedicated Bun child process executing `serverRunner.ts` (or packaged server bundle),
   hosting `@thinkrail/server` and `@earendil-works/pi-coding-agent` on an ephemeral loopback port (`port: 0`).
   The bound port is captured via stdout readiness signal and loaded directly into the main `BrowserWindow`.

Shutdown coordination is strictly maintained: quitting Electron sends `SIGTERM` to the Bun sidecar,
which runs graceful host shutdown before the app process exits.

## Native window chrome and contracts

The desktop preload bridges expose frozen, non-enumerable globals on `window` satisfying `@thinkrail/contracts`:
- `__THINKRAIL_NATIVE_MENU__`: menu label updates on language change.
- `__THINKRAIL_NATIVE_SHORTCUTS__`: command forwarding and quit hint subscription.
- `__THINKRAIL_NATIVE_NOTIFICATIONS__`: native OS notifications with click-to-focus window activation.
- `__THINKRAIL_NATIVE_WINDOW_CONTROLS__`: window state and minimize/maximize/close actions.
- `__THINKRAIL_NATIVE_UPDATES__`: desktop update controller bridge.

Title bar styling:
- **macOS:** `hiddenInset` with traffic light position `{ x: 16, y: 12 }`, publishing left inset `64px`.
- **Windows:** Custom frameless title bar with HTML-driven window controls, publishing right inset `138px`.
- **Linux:** Standard window decorations.

## Verification

[[module-artifact-tests]] owns expanded-app/first-install smoke, shared host probes, native navigation/
preload verification, and installer isolation. Every native release target must pass both smoke layers;
[[module-browser-e2e]] additionally covers wire-backed behavior against the packaged host. No platform's
native result is inferred from another platform's run. Signed download acceptance requires the private
release checks described in [[module-ci-release]].
