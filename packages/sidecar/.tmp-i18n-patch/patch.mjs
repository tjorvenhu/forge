import { readFileSync, writeFileSync } from "node:fs";

const [, , target, patchFile] = process.argv;
let text = readFileSync(target, "utf8");
const crlf = text.includes("\r\n");
if (crlf) text = text.replace(/\r\n/g, "\n");
const lines = readFileSync(patchFile, "utf8").replace(/\r\n/g, "\n").split("\n");
const blocks = [];
let mode = null;
let cur = null;
for (const line of lines) {
  if (line === "@@@OLD" || line === "@@@OLDALL") {
    cur = { old: [], neu: [], all: line === "@@@OLDALL" };
    mode = "old";
  } else if (line === "@@@NEW" && cur) mode = "new";
  else if (line === "@@@END" && cur) {
    blocks.push(cur);
    cur = null;
    mode = null;
  } else if (cur) (mode === "old" ? cur.old : cur.neu).push(line);
}
let ok = 0;
let bad = 0;
blocks.forEach((b, i) => {
  const o = b.old.join("\n");
  const n = b.neu.join("\n");
  const count = text.split(o).length - 1;
  if (count === 0 || (count > 1 && !b.all)) {
    bad++;
    console.log(`BLOCK ${i + 1}: ${count === 0 ? "not found" : `${count} matches`}: ${o.slice(0, 100).replace(/\n/g, "\\n")}`);
    return;
  }
  text = text.split(o).join(n);
  ok++;
});
writeFileSync(target, crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");
console.log(`applied ${ok}, failed ${bad}`);
