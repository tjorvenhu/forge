// FORGE setup UI. Talks to the Rust side through window.__TAURI__ (withGlobalTauri); without it (a plain
// browser) it runs a demo, so the screens can be checked with ?installed=1|same, ?offline=1, ?fail=1, ?lang=de.
"use strict";

const LICENSE_URL = "https://github.com/vanturis/forge/blob/main/LICENSE.md";
const VANTURIS_URL = "https://vanturis.de";

const ICONS = {
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  hammer: '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  tick: '<path d="M20 6 9 17l-5-5"/>',
};

const TEXT = {
  en: {
    setup: "FORGE Setup",
    stepOf: (n) => `Step ${n} of 5`,
    titleResolving: "Install FORGE",
    title: (v) => `Install FORGE ${v}`,
    titleUpdate: (v) => `Update to FORGE ${v}`,
    titleSame: (v) => `FORGE ${v} is already installed`,
    lead: "The desktop app for Claude Code. Git, Node.js, GitHub CLI and Python are included.",
    leadUpdate: (old) => `FORGE ${old} is installed. Projects and settings are kept.`,
    leadSame: "Reinstalling replaces the program files. Projects and settings are kept.",
    downloadSize: (mb) => `Downloads ${mb} MB from GitHub.`,
    resolveFailed: "GitHub cannot be reached. Check the internet connection.",
    folder: "Install folder",
    change: "Change",
    otherFolder: (dir) => `FORGE is currently installed in ${dir}. The old folder stays as it is.`,
    install: "Install",
    update: "Update",
    reinstall: "Reinstall",
    installing: "Installing",
    titles: { download: "Downloading FORGE", verify: "Checking the signature", install: "Installing FORGE", finish: "Finishing" },
    leads: {
      download: "From the FORGE releases on GitHub.",
      verify: "The signature shows that the files are unchanged.",
      install: (dir) => `Into ${dir}`,
      finish: "Applying the newest update.",
    },
    received: (x, y) => `${x} of ${y} MB`,
    steps: [
      ["Prepare", "Version and folder"],
      ["Download", "From GitHub"],
      ["Check signature", "Files unchanged"],
      ["Install", "Into the chosen folder"],
      ["Done", "Start FORGE"],
    ],
    doneCaption: "Done",
    doneTitle: "FORGE is ready",
    doneLead: "FORGE is now in the Start menu.",
    installedIn: "Installed in",
    launch: "Start FORGE",
    close: "Close",
    minimize: "Minimize",
    errorCaption: "Error",
    errorTitle: "Installation failed",
    errorLead: "FORGE was not installed. You can try again.",
    errorUnknown: "Unknown error.",
    retry: "Try again",
    licenseLink: "License AGPL-3.0",
    productBy: "a product by",
    language: "Language",
    steps_label: "Steps",
  },
  de: {
    setup: "FORGE Setup",
    stepOf: (n) => `Schritt ${n} von 5`,
    titleResolving: "FORGE installieren",
    title: (v) => `FORGE ${v} installieren`,
    titleUpdate: (v) => `Auf FORGE ${v} aktualisieren`,
    titleSame: (v) => `FORGE ${v} ist schon installiert`,
    lead: "Die Desktop-App für Claude Code. Git, Node.js, GitHub CLI und Python sind dabei.",
    leadUpdate: (old) => `FORGE ${old} ist installiert. Projekte und Einstellungen bleiben erhalten.`,
    leadSame: "Neu installieren ersetzt die Programmdateien. Projekte und Einstellungen bleiben erhalten.",
    downloadSize: (mb) => `Lädt ${mb} MB von GitHub.`,
    resolveFailed: "GitHub ist nicht erreichbar. Prüfe die Internetverbindung.",
    folder: "Zielordner",
    change: "Ändern",
    otherFolder: (dir) => `FORGE ist bisher in ${dir} installiert. Der alte Ordner bleibt, wie er ist.`,
    install: "Installieren",
    update: "Aktualisieren",
    reinstall: "Neu installieren",
    installing: "Installiere",
    titles: { download: "FORGE wird heruntergeladen", verify: "Signatur wird geprüft", install: "FORGE wird installiert", finish: "Wird abgeschlossen" },
    leads: {
      download: "Aus den FORGE-Releases auf GitHub.",
      verify: "Die Signatur zeigt, dass die Dateien unverändert sind.",
      install: (dir) => `Nach ${dir}`,
      finish: "Das neueste Update wird eingespielt.",
    },
    received: (x, y) => `${x} von ${y} MB`,
    steps: [
      ["Vorbereiten", "Version und Ordner"],
      ["Herunterladen", "Von GitHub"],
      ["Signatur prüfen", "Dateien unverändert"],
      ["Installieren", "In den gewählten Ordner"],
      ["Fertig", "FORGE starten"],
    ],
    doneCaption: "Fertig",
    doneTitle: "FORGE ist bereit",
    doneLead: "FORGE steht jetzt im Startmenü.",
    installedIn: "Installiert in",
    launch: "FORGE starten",
    close: "Schließen",
    minimize: "Minimieren",
    errorCaption: "Fehler",
    errorTitle: "Installation fehlgeschlagen",
    errorLead: "FORGE wurde nicht installiert. Du kannst es erneut versuchen.",
    errorUnknown: "Unbekannter Fehler.",
    retry: "Erneut versuchen",
    licenseLink: "Lizenz AGPL-3.0",
    productBy: "ein Produkt von",
    language: "Sprache",
    steps_label: "Schritte",
  },
};

// ---------------------------------------------------------------- backend (Tauri or demo)

const tauri = window.__TAURI__;
const backend = tauri ? tauriBackend() : demoBackend();

function tauriBackend() {
  return {
    invoke: (cmd, args) => tauri.core.invoke(cmd, args),
    listen: (event, fn) => tauri.event.listen(event, (e) => fn(e.payload)),
  };
}

function demoBackend() {
  const q = new URLSearchParams(location.search);
  const listeners = {};
  const emit = (event, payload) => (listeners[event] || []).forEach((fn) => fn(payload));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const version = "0.1.104";
  const total = 109_400_000;
  const dir = "C:\\Users\\Demo\\AppData\\Local\\FORGE";
  const installed = q.get("installed") === "same" ? { version, dir } : q.get("installed") ? { version: "0.1.103", dir } : null;
  const de = q.get("lang") === "de";
  const picks = ["D:\\Programme\\FORGE", "C:\\Tools\\FORGE", dir];
  let attempt = 0;
  let pick = 0;

  async function run() {
    const fail = q.get("fail") && attempt++ === 0;
    const steps = [
      ["download", 0, 72, 5200],
      ["verify", 72, 76, 900],
      ["install", 76, 97, 3000],
      ["finish", 97, 100, 700],
    ];
    for (const [step, from, to, ms] of steps) {
      const t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const payload = { step, percent: from + (to - from) * k };
        if (step === "download") Object.assign(payload, { received: Math.round(total * k), total });
        emit("setup-progress", payload);
        if (fail && step === "download" && k > 0.55) {
          emit("setup-done", { ok: false, message: de ? "Download fehlgeschlagen: Die Verbindung zu GitHub wurde getrennt." : "Download failed: the connection to GitHub was lost." });
          return;
        }
        if (k >= 1) break;
        await wait(80);
      }
    }
    emit("setup-done", { ok: true, message: null });
  }

  return {
    async invoke(cmd) {
      switch (cmd) {
        case "info":
          await wait(350);
          // Like the Rust side: English unless switched.
          return { lang: de ? "de" : "en", defaultDir: dir, installed };
        case "resolve":
          await wait(1100);
          if (q.get("offline")) throw de ? "GitHub ist nicht erreichbar. Prüfe die Internetverbindung." : "GitHub cannot be reached. Check the internet connection.";
          return { version, downloadBytes: total };
        case "pick_dir":
          return picks[pick++ % picks.length];
        case "install":
          run();
          return null;
        default:
          return null;
      }
    },
    async listen(event, fn) {
      (listeners[event] ||= []).push(fn);
    },
  };
}

// ---------------------------------------------------------------- state and rendering

const $ = (id) => document.getElementById(id);
const app = $("app");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ORDER = ["download", "verify", "install", "finish"];

const state = {
  screen: "loading",
  lang: "en",
  info: null,
  resolved: null, // { version, downloadBytes }
  resolveError: null,
  resolving: false,
  dir: "",
  progress: { step: "download", percent: 0 },
  error: null,
  failedAt: 1,
};

const t = () => TEXT[state.lang];

function mb(bytes) {
  const v = bytes / 1_000_000;
  return new Intl.NumberFormat(state.lang === "de" ? "de-DE" : "en-US", { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v);
}

const norm = (p) => (p || "").replace(/[\\/]+$/, "").toLowerCase();

/** The installation the chosen folder replaces, if any. */
function replaces() {
  const inst = state.info?.installed;
  return inst && norm(inst.dir) === norm(state.dir) ? inst : null;
}

/** "older" when an older version is in the chosen folder, "same" when this one, null for a new installation. */
function installKind() {
  const inst = replaces();
  if (!inst) return null;
  return state.resolved && inst.version === state.resolved.version ? "same" : "older";
}

function stepIndex() {
  if (state.screen === "installing") return Math.min(3, ORDER.indexOf(state.progress.step) + 1) || 1;
  if (state.screen === "done") return 5;
  if (state.screen === "error") return state.failedAt;
  return 0;
}

function setScreen(name) {
  state.screen = name;
  app.dataset.screen = name;
  render();
}

function setIcon(name, tone) {
  $("tile-icon").innerHTML = ICONS[name];
  if (tone) $("tile").dataset.tone = tone;
  else delete $("tile").dataset.tone;
}

function render() {
  const tx = t();
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const v = tx[el.dataset.i18n];
    if (typeof v === "string") el.textContent = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-label]")) {
    el.title = tx[el.dataset.i18nLabel];
    el.setAttribute("aria-label", tx[el.dataset.i18nLabel]);
  }
  $("lang").setAttribute("aria-label", tx.language);
  $("steps").setAttribute("aria-label", tx.steps_label);
  for (const b of document.querySelectorAll("#lang button")) b.setAttribute("aria-checked", String(b.dataset.lang === state.lang));

  renderSteps();
  renderHead();
  renderStart();
  renderProgress();
  renderFoot();
  $("done-path").textContent = state.dir;
  $("error-message").textContent = state.error || tx.errorUnknown;
  $("btn-close").disabled = state.screen === "installing";
}

function renderSteps() {
  const tx = t();
  const at = stepIndex();
  for (const li of $("steps").children) {
    const i = Number(li.dataset.index);
    const st = i < at ? "done" : i === at ? (state.screen === "error" ? "failed" : "current") : "todo";
    li.dataset.state = st;
    if (st === "current") li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
    const [label, hint] = tx.steps[i];
    const mark = st === "done" ? `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.tick}</svg>` : st === "failed" ? "!" : String(i + 1);
    li.innerHTML = `<span class="dot">${mark}</span><span class="step-text"><span class="step-label"></span><span class="step-hint"></span></span>`;
    li.querySelector(".step-label").textContent = label;
    li.querySelector(".step-hint").textContent = hint;
  }
}

function renderHead() {
  const tx = t();
  const v = state.resolved?.version;
  let caption = tx.setup;
  let title = "";
  let lead = "";
  switch (state.screen) {
    case "loading":
    case "start": {
      const kind = installKind();
      setIcon("download");
      caption = tx.stepOf(1);
      title = !v ? tx.titleResolving : kind === "same" ? tx.titleSame(v) : kind === "older" ? tx.titleUpdate(v) : tx.title(v);
      lead = kind === "same" ? tx.leadSame : kind === "older" && replaces().version ? tx.leadUpdate(replaces().version) : tx.lead;
      break;
    }
    case "installing": {
      const step = ORDER.includes(state.progress.step) ? state.progress.step : "install";
      setIcon(step === "download" ? "download" : step === "verify" ? "shield" : "hammer");
      caption = tx.stepOf(stepIndex() + 1);
      title = tx.titles[step];
      lead = step === "install" ? tx.leads.install(state.dir) : tx.leads[step];
      break;
    }
    case "done":
      setIcon("check", "success");
      caption = tx.doneCaption;
      title = tx.doneTitle;
      lead = tx.doneLead;
      break;
    case "error":
      setIcon("alert", "danger");
      caption = tx.errorCaption;
      title = tx.errorTitle;
      lead = tx.errorLead;
      break;
  }
  $("head-caption").textContent = caption;
  $("head-title").textContent = title;
  $("head-lead").textContent = lead;
}

function renderStart() {
  const tx = t();
  $("folder-text").textContent = state.dir;
  $("folder-path").title = state.dir;
  $("btn-change").disabled = state.screen !== "start";
  const inst = state.info?.installed;
  const other = inst && !replaces();
  const note = $("note");
  note.dataset.state = other ? "other" : state.resolved ? "ready" : state.resolveError ? "error" : "resolving";
  if (state.resolveError) note.dataset.state = "error";
  $("note-other").textContent = other ? tx.otherFolder(inst.dir) : "";
  $("note-ready").textContent = state.resolved ? tx.downloadSize(mb(state.resolved.downloadBytes)) : "";
  $("resolve-error").textContent = state.resolveError || "";
}

function renderProgress() {
  const tx = t();
  const p = state.progress;
  const pct = Math.max(0, Math.min(100, p.percent || 0));
  $("progress-fill").style.width = `${pct}%`;
  $("progress").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("percent").textContent = `${Math.floor(pct)} %`;
  const i = ORDER.indexOf(p.step);
  $("progress-detail").textContent = p.step === "download" && p.received != null && p.total ? tx.received(mb(p.received), mb(p.total)) : tx.steps[Math.min(3, i + 1)]?.[0] ?? "";
}

function renderFoot() {
  const tx = t();
  const primary = $("btn-primary");
  const cancel = $("btn-cancel");
  primary.removeAttribute("aria-busy");
  primary.dataset.arrow = "true";
  primary.disabled = false;
  cancel.disabled = false;
  let label = "";
  switch (state.screen) {
    case "loading":
    case "start": {
      const kind = installKind();
      label = kind === "same" ? tx.reinstall : kind === "older" ? tx.update : tx.install;
      primary.disabled = !state.resolved;
      break;
    }
    case "installing":
      label = tx.installing;
      primary.disabled = true;
      primary.setAttribute("aria-busy", "true");
      cancel.disabled = true;
      break;
    case "done":
      label = tx.launch;
      break;
    case "error":
      label = tx.retry;
      primary.dataset.arrow = "false";
      break;
  }
  $("btn-primary-text").textContent = label;
}

// ---------------------------------------------------------------- actions

async function resolve() {
  if (state.resolving) return;
  state.resolving = true;
  state.resolveError = null;
  state.resolved = null;
  render();
  try {
    state.resolved = await backend.invoke("resolve");
  } catch (e) {
    state.resolveError = (typeof e === "string" ? e : e?.message) || t().resolveFailed;
  } finally {
    state.resolving = false;
    render();
  }
}

async function startInstall() {
  if (!state.resolved) return;
  state.error = null;
  state.progress = { step: "download", percent: 0 };
  setScreen("installing");
  forge.work();
  try {
    await backend.invoke("install", { dir: state.dir });
  } catch (e) {
    fail((typeof e === "string" ? e : e?.message) || null);
  }
}

function fail(message) {
  state.error = message;
  state.failedAt = state.screen === "installing" ? stepIndex() : 1;
  setScreen("error");
  forge.idle();
}

function setLang(lang) {
  state.lang = lang;
  backend.invoke("set_lang", { lang }).catch(() => {});
  render();
}

async function init() {
  await backend.listen("setup-progress", (p) => {
    const before = state.progress.step;
    state.progress = p;
    if (p.step !== before) render();
    else renderProgress();
  });
  await backend.listen("setup-done", (d) => {
    if (d.ok) {
      state.progress = { step: "finish", percent: 100 };
      renderProgress();
      forge.finish(() => setScreen("done"));
    } else {
      fail(d.message);
    }
  });

  render();
  try {
    state.info = await backend.invoke("info");
  } catch {
    state.info = { lang: "en", defaultDir: "", installed: null };
  }
  state.dir = state.info.installed?.dir || state.info.defaultDir;
  setLang(state.info.lang === "de" ? "de" : "en");
  setScreen("start");
  resolve();
}

async function primaryAction() {
  if (state.screen === "start") return startInstall();
  if (state.screen === "error") {
    if (!state.resolved) {
      setScreen("start");
      return resolve();
    }
    return startInstall();
  }
  if (state.screen === "done") return backend.invoke("launch", { dir: state.dir });
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el || el.disabled) return;
  switch (el.id) {
    case "btn-min":
      return backend.invoke("minimize");
    case "btn-close":
    case "btn-cancel":
      return backend.invoke("quit");
    case "btn-change": {
      const dir = await backend.invoke("pick_dir", { current: state.dir });
      if (dir) {
        state.dir = dir;
        render();
      }
      return;
    }
    case "btn-license":
      return backend.invoke("open_url", { url: LICENSE_URL });
    case "btn-vanturis":
      return backend.invoke("open_url", { url: VANTURIS_URL });
    case "btn-primary":
      return primaryAction();
    case "btn-resolve-retry":
      return resolve();
  }
  if (el.dataset.lang && el.dataset.lang !== state.lang) setLang(el.dataset.lang);
});

// ---------------------------------------------------------------- hammer and anvil

const forge = createForge();

function createForge() {
  const stage = $("stage");
  const art = $("art");
  const hammer = $("hammer");
  const heat = $("heat");
  const glow = $("anvil-glow");
  const face = $("anvil-face");
  const impactEl = $("impact");
  const canvas = $("sparks");
  const ctx = canvas.getContext("2d");
  const PIVOT = [1054, 246];
  const CYCLE = 1150;
  // [phase, angle]: hit at 0, rebound, raise, short hold, strike
  const SWING = [[0, 0], [0.07, 8], [0.15, 5], [0.62, 52], [0.72, 54], [1, 0]];
  const REST = 40;

  let mode = "idle"; // idle | work | final | rest
  let t0 = performance.now();
  let lastCycle = -1;
  let final = null;
  let heatLevel = 0;
  let angle = REST;
  let blendFrom = null;
  const particles = [];
  let lastFrame = performance.now();
  let emberClock = 0;

  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  const easeIn = (k) => k * k * k;
  const easeOut = (k) => 1 - (1 - k) ** 3;

  function swingAngle(p) {
    for (let i = 1; i < SWING.length; i++) {
      const [p1, a1] = SWING[i];
      const [p0, a0] = SWING[i - 1];
      if (p <= p1) {
        const k = (p - p0) / (p1 - p0);
        const e = i === SWING.length - 1 ? easeIn(k) : i <= 2 ? easeOut(k) : easeInOut(k);
        return a0 + (a1 - a0) * e;
      }
    }
    return 0;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  function impactPoint() {
    const r = impactEl.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return [r.left + r.width / 2 - s.left, r.top + r.height / 2 - s.top];
  }

  // Few, short sparks: the card is small and the setup should stay calm.
  function impact(strength) {
    heatLevel = Math.min(1, heatLevel + 0.6 * strength);
    if (reduceMotion) return;
    const [x, y] = impactPoint();
    const n = Math.round(10 * strength);
    for (let i = 0; i < n; i++) {
      const dir = -Math.PI * (0.1 + Math.random() * 0.8);
      const speed = (70 + Math.random() * 150) * Math.sqrt(strength);
      const life = 0.25 + Math.random() * 0.4 * Math.sqrt(strength);
      particles.push({ x: x + (Math.random() - 0.5) * 10, y: y - 1, vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed, life, max: life, w: 0.8 + Math.random() * 0.9, hue: 24 + Math.random() * 22, ember: false });
    }
  }

  function ember() {
    const [x, y] = impactPoint();
    const life = 1.2 + Math.random() * 1.2;
    particles.push({ x: x + (Math.random() - 0.5) * 30, y: y + 2, vx: (Math.random() - 0.5) * 6, vy: -(8 + Math.random() * 12), life, max: life, w: 0.7 + Math.random() * 0.6, hue: 22 + Math.random() * 16, ember: true });
  }

  function step(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    let target = angle;

    if (reduceMotion) {
      target = mode === "rest" ? 0 : REST;
    } else if (mode === "idle") {
      target = REST + Math.sin(now / 1000) * 1.5;
    } else if (mode === "work") {
      const elapsed = now - t0;
      const cycle = Math.floor(elapsed / CYCLE);
      if (cycle !== lastCycle) {
        if (lastCycle >= 0) impact(1);
        lastCycle = cycle;
      }
      target = swingAngle((elapsed % CYCLE) / CYCLE);
    } else if (mode === "final") {
      const e = now - final.start;
      const RAISE = 480, HOLD = 140, STRIKE = 180;
      if (e < RAISE) target = final.from + (66 - final.from) * easeOut(e / RAISE);
      else if (e < RAISE + HOLD) target = 66;
      else if (e < RAISE + HOLD + STRIKE) target = 66 * (1 - easeIn((e - RAISE - HOLD) / STRIKE));
      else {
        if (!final.hit) {
          final.hit = true;
          impact(2);
          setTimeout(final.done, 550);
        }
        const r = (e - RAISE - HOLD - STRIKE) / 380;
        target = r < 1 ? Math.sin(r * Math.PI) * 8 * (1 - r) : 0;
      }
    } else if (mode === "rest") {
      target = 0;
    }

    if (blendFrom) {
      const k = Math.min(1, (now - blendFrom.start) / 260);
      angle = blendFrom.angle + (target - blendFrom.angle) * easeInOut(k);
      if (k >= 1) blendFrom = null;
    } else {
      angle = target;
    }
    hammer.setAttribute("transform", `rotate(${angle.toFixed(2)} ${PIVOT[0]} ${PIVOT[1]})`);

    // a short flash after a hit, a faint warmth otherwise
    heatLevel = Math.max(0, heatLevel - dt * 2.6);
    const warm = mode === "work" ? 0.32 : 0.22;
    heat.setAttribute("opacity", (heatLevel * 0.85).toFixed(3));
    glow.setAttribute("opacity", (warm + heatLevel * 0.45).toFixed(3));
    face.style.filter = heatLevel > 0.01 ? `brightness(${(1 + heatLevel * 0.25).toFixed(3)})` : "";
    art.style.transform = heatLevel > 0.7 && mode === "final" ? `translate(-50%, ${(Math.random() * 0.8).toFixed(2)}px)` : "";

    if (!reduceMotion && mode === "work") {
      emberClock += dt * 1.5;
      while (emberClock > 1) {
        emberClock -= 1;
        ember();
      }
    }

    drawSparks(dt);
    requestAnimationFrame(step);
  }

  function drawSparks(dt) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!particles.length) return;
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0 || p.y > h + 10 || p.x < -10 || p.x > w + 10) {
        particles.splice(i, 1);
        continue;
      }
      const k = p.life / p.max;
      if (p.ember) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.fillStyle = `hsla(${p.hue}, 100%, 62%, ${(Math.sin(k * Math.PI) * 0.55).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.w, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      p.vy += 520 * dt;
      p.vx *= 1 - 1.2 * dt;
      const px = p.x;
      const py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.strokeStyle = `hsla(${p.hue}, 100%, ${(60 + 25 * k).toFixed(0)}%, ${Math.min(1, k * 1.3).toFixed(3)})`;
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(px - p.vx * 0.018, py - p.vy * 0.018);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  requestAnimationFrame(step);

  const blend = () => (blendFrom = { angle, start: performance.now() });

  return {
    idle() {
      blend();
      mode = "idle";
    },
    work() {
      if (mode === "work") return;
      blend();
      mode = "work";
      // start at the top of a swing, so the first hit comes quickly
      t0 = performance.now() - 0.62 * CYCLE;
      lastCycle = 0;
    },
    finish(done) {
      if (reduceMotion) {
        mode = "rest";
        done();
        return;
      }
      blendFrom = null;
      final = { start: performance.now(), from: angle, hit: false, done: () => { mode = "rest"; done(); } };
      mode = "final";
    },
  };
}

init();
