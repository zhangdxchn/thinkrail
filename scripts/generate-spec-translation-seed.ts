import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(str: string): string {
	return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function stripFrontmatter(text: string): string {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	return match ? text.slice(match[0].length) : text;
}

function findZhFiles(dir: string, list: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".thinkrail")
			continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			findZhFiles(full, list);
		} else if (entry.name.endsWith("_zh.md")) {
			list.push(full);
		}
	}
	return list;
}

const zhFiles = findZhFiles(".");
const translations: Record<string, string> = {};
const byPath: Record<string, { rawHash: string; strippedHash: string }> = {};

let totalFiles = 0;

for (const zh of zhFiles) {
	const relZh = path.relative(".", zh).replaceAll("\\", "/");
	const relEn = relZh.replace(/_zh\.md$/, ".md");
	if (!fs.existsSync(relEn)) {
		console.warn("No matching English file for:", relZh);
		continue;
	}

	const enRaw = fs.readFileSync(relEn, "utf8");
	const zhRaw = fs.readFileSync(relZh, "utf8");
	const enStripped = stripFrontmatter(enRaw);
	const zhStripped = stripFrontmatter(zhRaw);

	const rawHash = sha256(enRaw);
	const strippedHash = sha256(enStripped);

	// Store full translation under rawHash, and stripped translation under strippedHash
	translations[rawHash] = zhRaw;
	if (strippedHash !== rawHash) {
		translations[strippedHash] = zhStripped;
	}

	byPath[relEn] = { rawHash, strippedHash };
	totalFiles++;
}

const seedData = {
	version: 1,
	count: totalFiles,
	generatedAt: "2026-10-28T12:00:00Z",
	translations,
	byPath,
};

const targetPath = path.join("packages", "server", "src", "spec", "specTranslationSeed.json");
fs.writeFileSync(targetPath, JSON.stringify(seedData), "utf8");

console.log(`Generated ${targetPath} with ${totalFiles} translated specs.`);
