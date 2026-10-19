// Renders the link previews (Open Graph, 1200 x 630) to src/assets/og-<lang>.png:
// blurred page background, wordmark, title of the landing page and the app screenshot.
// Run in services/stats: node scripts/og-images.mjs (text uses the system fonts, Segoe UI on Windows).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// sharp is no direct dependency; Next brings it along.
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("next/package.json"))("sharp");

sharp.cache(false);
const assets = fileURLToPath(new URL("../src/assets/", import.meta.url));
const W = 1200;
const H = 630;

const TEXT = {
  de: { title: ["Deine AI", "Entwicklungszentrale"], lead: ["Die Desktop-App für Claude Code:", "Projekte, Sessions, Agenten und Git", "in einem Fenster."], facts: "Windows 10/11 · Open Source · Kostenlos" },
  en: { title: ["Your AI", "Development Hub"], lead: ["The desktop app for Claude Code:", "projects, sessions, agents and Git", "in one window."], facts: "Windows 10/11 · Open Source · Free" },
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function render(lang) {
  const t = TEXT[lang];
  const background = await sharp(readFileSync(`${assets}background.webp`)).resize(W + 80, H + 80, { fit: "cover" }).blur(14).extract({ left: 40, top: 40, width: W, height: H }).toBuffer();
  const shade = Buffer.from(
    `<svg width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#111418" stop-opacity="0.92"/><stop offset="0.55" stop-color="#111418" stop-opacity="0.7"/><stop offset="1" stop-color="#111418" stop-opacity="0.35"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`,
  );

  // The screenshot leaves the card at the right and bottom edge.
  const shotW = 700;
  const shot = await sharp(readFileSync(`${assets}app-${lang}-1600.webp`)).resize(shotW).toBuffer();
  const shotH = (await sharp(shot).metadata()).height;
  const radius = 14;
  const mask = Buffer.from(`<svg width="${shotW}" height="${shotH}"><rect width="${shotW}" height="${shotH}" rx="${radius}" ry="${radius}"/></svg>`);
  const rounded = await sharp(shot).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const frame = Buffer.from(
    `<svg width="${shotW + 2}" height="${shotH + 2}"><rect x="0.5" y="0.5" width="${shotW + 1}" height="${shotH + 1}" rx="${radius + 1}" fill="none" stroke="#3c444f" stroke-width="1"/></svg>`,
  );
  const shadow = Buffer.from(
    `<svg width="${shotW + 120}" height="${shotH + 120}"><defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="24"/></filter></defs><rect x="60" y="70" width="${shotW}" height="${shotH}" rx="${radius}" fill="#000" fill-opacity="0.55" filter="url(#b)"/><rect x="40" y="40" width="${shotW + 40}" height="${shotH + 40}" rx="40" fill="#ff7a1a" fill-opacity="0.10" filter="url(#b)"/></svg>`,
  );
  const shotX = 640;
  const shotY = 140;

  const logoH = 44;
  const logo = await sharp(readFileSync(`${assets}forge-wordmark.png`)).resize({ height: logoH }).toBuffer();

  const font = "Segoe UI, Inter, Arial, sans-serif";
  const text = Buffer.from(
    `<svg width="${W}" height="${H}">
      <text x="64" y="210" font-family="${font}" font-size="52" font-weight="700" fill="#e5e7eb">${esc(t.title[0])}</text>
      <text x="64" y="270" font-family="${font}" font-size="52" font-weight="700" fill="#ff7a1a">${esc(t.title[1])}</text>
      ${t.lead.map((line, i) => `<text x="64" y="${336 + i * 34}" font-family="${font}" font-size="24" fill="#a9aeb6">${esc(line)}</text>`).join("")}
      <text x="64" y="540" font-family="${font}" font-size="20" font-weight="600" fill="#e5e7eb">${esc(t.facts)}</text>
      <text x="64" y="574" font-family="${font}" font-size="18" fill="#ff7a1a">forge.vanturis.de</text>
    </svg>`,
  );

  // The screenshot reaches past the card; sharp only takes overlays that fit, so they are cut first.
  const fit = async (input, left, top) => {
    const img = sharp(input);
    const { width, height } = await img.metadata();
    const w = Math.min(width, W - left);
    const h = Math.min(height, H - top);
    return { input: w < width || h < height ? await img.extract({ left: 0, top: 0, width: w, height: h }).png().toBuffer() : input, left, top };
  };

  const out = await sharp(background)
    .composite([
      { input: shade, left: 0, top: 0 },
      await fit(shadow, shotX - 60, shotY - 60),
      await fit(rounded, shotX, shotY),
      await fit(frame, shotX - 1, shotY - 1),
      { input: logo, left: 64, top: 64 },
      { input: text, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(`${assets}og-${lang}.png`, out);
  console.log(`og-${lang}.png`, out.length);
}

for (const lang of Object.keys(TEXT)) await render(lang);
