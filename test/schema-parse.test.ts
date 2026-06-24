import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const schemaDir = path.join("docs", "contracts", "schemas");

test("all contract schemas parse as JSON", async () => {
  const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".json")).sort();

  assert.equal(files.length, 12);

  for (const file of files) {
    const raw = await readFile(path.join(schemaDir, file), "utf8");
    const parsed = JSON.parse(raw) as { readonly $id?: string; readonly title?: string };

    assert.ok(parsed.$id, `${file} must declare $id`);
    assert.ok(parsed.title, `${file} must declare title`);
  }
});
