import { bootHost } from "@thinkrail/server";
import { channel, version } from "@thinkrail/shared/version";

const hostAddress = process.env.THINKRAIL_HOST ?? "127.0.0.1";
const staticDir = process.env.THINKRAIL_STATIC_DIR;

const host = await bootHost({
	port: 0,
	host: hostAddress,
	portMode: "exact",
	resolveShellEnv: true,
	...(staticDir ? { staticDir } : {}),
	appVersion: version,
	analytics: {
		channel,
		build: "desktop",
	},
});

console.log(`thinkrail host: http://${hostAddress}:${host.port}`);

process.on("SIGINT", async () => {
	await host.server.shutdown();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	await host.server.shutdown();
	process.exit(0);
});
