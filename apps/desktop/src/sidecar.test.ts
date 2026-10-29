import { expect, test } from "bun:test";
import { startBunSidecar } from "./sidecar";

test("starts bun sidecar, captures host origin, and stops cleanly", async () => {
	const sidecar = await startBunSidecar({
		isPackaged: false,
		appPath: process.cwd(),
	});

	expect(sidecar.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	expect(sidecar.port).toBeGreaterThan(0);

	// Test reaching the server
	const res = await fetch(`${sidecar.origin}/`);
	expect(res.status).toBe(200);

	await sidecar.stop();
	expect(sidecar.process.exitCode !== null || sidecar.process.killed).toBe(true);
}, 25000);
