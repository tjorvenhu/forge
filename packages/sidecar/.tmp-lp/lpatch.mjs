import { readFileSync, writeFileSync } from "node:fs";

// usage: node lpatch.mjs <target> <patchfile>
// patch format: "@@ <start>[-<end>] | <expected snippet on first line>" followed by replacement lines.
// Line numbers refer to the original file; hunks are applied bottom to top.
const [, , target, patchFile] = process.argv;
let text = readFileSync(target, "utf8");
const crlf = text.includes("\r\n");
if (crlf) text = text.replace(/\r\n/g, "\n");
const lines = text.split("\n");
const hunks = [];
let cur = null;
for (const raw of readFileSync(patchFile, "utf8").replace(/\r\n/g, "\n").split("\n")) {
  const h = /^@@ (\d+)(?:-(\d+))? \| (.*)$/.exec(raw);
  if (h) {
    cur = { start: Number(h[1]), end: Number(h[2] ?? h[1]), snippet: h[3], body: [] };
    hunks.push(cur);
  } else if (raw === "@@END") cur = null;
  else if (cur) cur.body.push(raw);
}
hunks.sort((a, b) => b.start - a.start);
let bad = 0;
for (const h of hunks) {
  const first = lines[h.start - 1] ?? "";
  if (!first.includes(h.snippet)) {
    console.log(`MISMATCH at ${h.start}: expected "${h.snippet}" in: ${first.slice(0, 120)}`);
    bad++;
  }
}
if (bad) {
  console.log(`aborted, ${bad} mismatches, nothing written`);
  process.exit(1);
}
for (const h of hunks) lines.splice(h.start - 1, h.end - h.start + 1, ...h.body);
writeFileSync(target, crlf ? lines.join("\n").replace(/\n/g, "\r\n") : lines.join("\n"), "utf8");
console.log(`applied ${hunks.length} hunks`);
