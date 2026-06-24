import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const write = process.argv.includes("--write");
const roots = [".github", "config", "docs", "src", "test", "tools"];
const rootFiles = [".env.example", ".gitignore", "package.json", "tsconfig.json"];
const textExtensions = new Set([".json", ".md", ".mjs", ".ts", ".yml", ".yaml"]);

async function exists(filePath) {
  try {
    await readdir(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir) {
  if (!(await exists(dir))) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

const files = [
  ...rootFiles,
  ...(await Promise.all(roots.map((root) => collectFiles(root)))).flat()
].sort();

const failures = [];

for (const file of files) {
  let content = await readFile(file, "utf8");
  const original = content;
  content = content.replace(/[ \t]+$/gm, "");
  if (content.length > 0 && !content.endsWith("\n")) {
    content += "\n";
  }

  if (write && content !== original) {
    await writeFile(file, content);
  } else if (!write && content !== original) {
    failures.push(file);
  }
}

if (failures.length > 0) {
  console.error(`Format check failed for ${failures.length} file(s):`);
  for (const file of failures) {
    console.error(`- ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log(`format ok (${files.length} files)`);
}
