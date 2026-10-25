import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `main.js` is never imported by another test, so a syntax error in it used to
// take the whole app down -- no listeners, no dimmed cards -- with every test
// still green, and `node --check` parsed it as CommonJS and passed. Importing
// each file as a data: URL makes Node parse it as a module: resolution errors
// are expected (relative imports have no base, and the browser bare specifiers
// are resolved by the import map), but a SyntaxError is a real failure.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");

function javascriptFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...javascriptFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("every source module parses as JavaScript", async () => {
  const files = javascriptFiles(src);
  assert.ok(files.length > 20, `expected to find the source tree, got ${files.length} files`);
  const broken = [];
  for (const file of files) {
    const code = fs.readFileSync(file, "utf8");
    const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    try {
      await import(url);
    } catch (err) {
      if (err instanceof SyntaxError) {
        broken.push(`${path.relative(src, file)}: ${err.message}`);
      }
    }
  }
  assert.deepEqual(broken, [], `syntax errors:\n${broken.join("\n")}`);
});
