import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { SpecGraphNode, SpecGraphSnapshot } from "@thinkrail/contracts";
import { FIELDS, list, SpecIndex, scalar } from "pi-spec-graph/core";
import { dataDir, loadWorkspaces } from "../persistence";

interface SeedCache {
	version: number;
	count: number;
	translations: Record<string, string>;
	byPath: Record<string, { rawHash: string; strippedHash: string }>;
}

let seedCache: SeedCache | null = null;

function loadSeedCache(): SeedCache {
	if (!seedCache) {
		try {
			const seedPath = join(__dirname, "specTranslationSeed.json");
			if (existsSync(seedPath)) {
				seedCache = JSON.parse(readFileSync(seedPath, "utf8")) as SeedCache;
			} else {
				seedCache = { version: 1, count: 0, translations: {}, byPath: {} };
			}
		} catch {
			seedCache = { version: 1, count: 0, translations: {}, byPath: {} };
		}
	}
	return seedCache;
}

let userCache: Record<string, string> | null = null;

function userCachePath(): string {
	return join(dataDir(), "cache", "spec-translations.json");
}

function loadUserCache(): Record<string, string> {
	if (!userCache) {
		try {
			const p = userCachePath();
			if (existsSync(p)) {
				userCache = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
			} else {
				userCache = {};
			}
		} catch {
			userCache = {};
		}
	}
	return userCache;
}

export function saveUserSpecTranslation(hash: string, translation: string): void {
	const cache = loadUserCache();
	cache[hash] = translation;
	try {
		const p = userCachePath();
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(cache, null, 2), "utf8");
	} catch {
		// non-fatal
	}
}

function stripFrontmatter(text: string): string {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	return match ? text.slice(match[0].length) : text;
}

function sha256(str: string): string {
	return createHash("sha256").update(str, "utf8").digest("hex");
}

export function getSpecTranslation(
	workspaceId: string,
	filePath: string,
): { translation: string | null; cached: boolean } {
	const ws = loadWorkspaces().find((w) => w.id === workspaceId);
	if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);

	const absPath = resolve(ws.worktreePath, filePath);
	if (!existsSync(absPath)) {
		return { translation: null, cached: false };
	}

	let rawContent: string;
	try {
		rawContent = readFileSync(absPath, "utf8");
	} catch {
		return { translation: null, cached: false };
	}

	const strippedContent = stripFrontmatter(rawContent);
	const rawHash = sha256(rawContent);
	const strippedHash = sha256(strippedContent);

	// 1. Check user cache
	const localCache = loadUserCache();
	if (localCache[rawHash]) {
		return { translation: localCache[rawHash], cached: true };
	}
	if (localCache[strippedHash]) {
		return { translation: localCache[strippedHash], cached: true };
	}

	// 2. Check seed cache
	const seed = loadSeedCache();
	if (seed.translations[rawHash]) {
		return { translation: seed.translations[rawHash], cached: true };
	}
	if (seed.translations[strippedHash]) {
		return { translation: seed.translations[strippedHash], cached: true };
	}

	// 3. Check byPath fallback in seed
	const relPath = relative(ws.worktreePath, absPath).replaceAll("\\", "/");
	const byPathEntry = seed.byPath[relPath];
	if (byPathEntry) {
		const fallback =
			seed.translations[byPathEntry.rawHash] ?? seed.translations[byPathEntry.strippedHash];
		if (fallback) {
			return { translation: fallback, cached: true };
		}
	}

	return { translation: null, cached: false };
}

const indexes = new Map<string, SpecIndex>();

function indexFor(workspaceId: string, root: string): SpecIndex {
	let index = indexes.get(workspaceId);
	if (!index) {
		index = new SpecIndex(root);
		indexes.set(workspaceId, index);
	}
	return index;
}

export function evictSpecIndex(workspaceId: string): void {
	indexes.delete(workspaceId);
}

const projectIndexes = new Map<string, SpecIndex>();

export function projectHasSpecs(root: string): boolean {
	let index = projectIndexes.get(root);
	if (!index) {
		index = new SpecIndex(root);
		projectIndexes.set(root, index);
	}
	try {
		for (const node of index.graph().nodes.values()) {
			if (node.type !== "task-spec") return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function specGraph(workspaceId: string): SpecGraphSnapshot {
	const ws = loadWorkspaces().find((w) => w.id === workspaceId);
	if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);

	const graph = indexFor(ws.id, ws.worktreePath).graph();
	const nodes: SpecGraphNode[] = [...graph.nodes.values()].map((node) => {
		const status = scalar(node.frontmatter, FIELDS.status);
		const parent = scalar(node.frontmatter, FIELDS.parent);
		return {
			id: node.id,
			type: node.type,
			title: node.title ?? node.id,
			...(status !== undefined ? { status } : {}),
			path: node.path,
			...(parent !== undefined ? { parent } : {}),
			dependsOn: list(node.frontmatter, FIELDS.dependsOn),
			references: list(node.frontmatter, FIELDS.references),
			implements: list(node.frontmatter, FIELDS.implements),
			tags: list(node.frontmatter, FIELDS.tags),
		};
	});
	return { nodes };
}
