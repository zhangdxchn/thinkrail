import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

interface ManagedChildProcess {
	stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void };
	kill(signal?: string): boolean;
	exitCode: number | null;
	on(event: "error", listener: (err: Error) => void): void;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
	once(event: "exit", listener: () => void): void;
}

export interface SidecarOptions {
	isPackaged: boolean;
	appPath: string;
	staticDir?: string;
}

export interface SidecarInstance {
	origin: string;
	port: number;
	process: ChildProcess;
	stop(): Promise<void>;
}

function resolveServerRunner(dir: string): string {
	const direct = join(dir, "serverRunner.ts");
	if (existsSync(direct)) return direct;
	const fromDist = join(dir, "../src/serverRunner.ts");
	if (existsSync(fromDist)) return fromDist;
	return direct;
}

function resolveStaticDir(options: SidecarOptions, cwd: string): string | undefined {
	if (options.staticDir && existsSync(options.staticDir)) {
		return options.staticDir;
	}
	if (process.env.THINKRAIL_STATIC_DIR && existsSync(process.env.THINKRAIL_STATIC_DIR)) {
		return process.env.THINKRAIL_STATIC_DIR;
	}
	if (options.isPackaged && process.resourcesPath) {
		const packagedWeb = join(process.resourcesPath, "web");
		if (existsSync(packagedWeb)) return packagedWeb;
	} else {
		const devWeb = resolve(cwd, "../web/dist");
		if (existsSync(devWeb)) return devWeb;
	}
	return undefined;
}

export async function startBunSidecar(options: SidecarOptions): Promise<SidecarInstance> {
	const cmd = "bun";
	let args: string[] = [];
	let cwd = resolve(currentDir, "..");

	if (options.isPackaged && process.resourcesPath) {
		// In packaged mode, use bundled bun or compiled binary in resources
		const resourcesPath = join(process.resourcesPath, "server");
		const bundledRunner = join(resourcesPath, "serverRunner.js");
		if (existsSync(bundledRunner)) {
			args = [bundledRunner];
			cwd = resourcesPath;
		} else {
			// Fallback to local script if available
			args = [resolveServerRunner(currentDir)];
		}
	} else {
		// In dev mode, run the TypeScript server runner via bun
		args = [resolveServerRunner(currentDir)];
	}

	const resolvedStaticDir = resolveStaticDir(options, cwd);

	const env = {
		...process.env,
		THINKRAIL_HOST: "127.0.0.1",
		...(resolvedStaticDir ? { THINKRAIL_STATIC_DIR: resolvedStaticDir } : {}),
	};

	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(cmd, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "inherit"],
		}) as unknown as ManagedChildProcess;

		let resolved = false;
		let buffer = "";

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				child.kill("SIGTERM");
				rejectPromise(new Error("Timeout waiting for ThinkRail Bun server to start"));
			}
		}, 20000);

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			buffer += text;

			// Look for: thinkrail host: http://127.0.0.1:<port>
			const match = buffer.match(/thinkrail host:\s*(http:\/\/127\.0\.0\.1:(\d+))/i);
			if (match?.[1] && match[2] && !resolved) {
				resolved = true;
				clearTimeout(timeout);
				const origin = match[1];
				const port = Number(match[2]);

				const instance: SidecarInstance = {
					origin,
					port,
					process: child as unknown as ChildProcess,
					async stop() {
						if (child.exitCode !== null) return;
						return new Promise<void>((resolveStop) => {
							const killTimeout = setTimeout(() => {
								if (child.exitCode === null) {
									child.kill("SIGKILL");
								}
								resolveStop();
							}, 3000);

							child.once("exit", () => {
								clearTimeout(killTimeout);
								resolveStop();
							});

							child.kill("SIGTERM");
						});
					},
				};

				resolvePromise(instance);
			}
		});

		child.on("error", (err: Error) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				rejectPromise(err);
			}
		});

		child.on("exit", (code: number | null, signal: string | null) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				rejectPromise(
					new Error(`ThinkRail Bun server exited prematurely with code ${code ?? signal}`),
				);
			}
		});
	});
}
