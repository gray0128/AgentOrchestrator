import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const schemaDir = path.join("docs", "contracts", "schemas");
const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".json")).sort();

if (files.length === 0) {
  throw new Error(`No schema files found in ${schemaDir}`);
}

for (const file of files) {
  const raw = await readFile(path.join(schemaDir, file), "utf8");
  JSON.parse(raw);
  console.log(`ok ${file}`);
}
