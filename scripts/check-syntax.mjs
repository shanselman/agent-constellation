import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = [
    path.resolve(".github/extensions/agent-constellation"),
    path.resolve("scripts"),
];

const files = roots.flatMap((root) =>
    readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
        .map((entry) => path.join(root, entry.name))
);

for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
        stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Checked ${files.length} JavaScript modules.`);
