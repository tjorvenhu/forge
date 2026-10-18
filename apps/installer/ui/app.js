// FORGE setup UI. Talks to the Rust side through window.__TAURI__ (withGlobalTauri); without it (a plain
// browser) it runs a demo, so the screens can be checked with ?installed=1|same, ?offline=1, ?fail=1.
"use strict";

const LICENSE_URL = "https://github.com/vanturis/forge/blob/main/LICENSE.md";

const TEXT = {
  de: {
    eyebrow: "Setup",
    titleResolving: "FORGE<br>installieren",
    title: (v) => `FORGE <em>${v}</em><br>installieren`,
    titleUpdate: (v) => `Auf FORGE <em>${v}</em><br>aktualisieren`,
    titleSame: (v) => `FORGE <em>${v}</em><br>ist schon installiert`,
    lead: "Die Desktop-App für Claude Code. Git, Node.js, GitHub CLI und Python sind dabei.",
    leadUpdate: (old) => `FORGE ${old} ist installiert. Projekte und Einstellungen bleiben erhalten.`,
    leadSame: "Neu installieren ersetzt die Programmdateien. Projekte und Einstellungen bleiben erhalten.",
    resolving: "Suche die neueste Version",
    downloadSize: (mb) => `Lädt ${mb} MB von GitHub`,
    resolveFailed: "GitHub ist nicht erreichbar. Prüfe die Internetverbindung.",
    folder: "Zielordner",
    change: "Ändern",
    install: "Installieren",
    update: "Aktualisieren",
    reinstall: "Neu installieren",
    license: (link) => `Mit der Installation gilt die Lizenz ${link}.`,
    installingEyebrow: "Installation",
    installingTitle: "FORGE wird installiert",
    updatingTitle: "FORGE wird aktualisiert",
    steps: { download: "Lade FORGE herunter", verify: "Prüfe Signatur", install: "Installiere FORGE", finish: "Fast fertig" },
    stepList: { download: "Herunterladen", verify: "Signatur prüfen", install: "Installieren", finish: "Abschließen" },
    received: (x, y) => `${x} von ${y} MB`,
    doneEyebrow: "Fertig",
    doneTitle: "FORGE ist bereit",
    doneLead: "Du findest FORGE im Startmenü.",
    installedIn: "Installiert in",
    launch: "FORGE starten",
    close: "Schließen",
    minimize: "Minimieren",
    errorEyebrow: "Fehler",
    errorTitle: "Installation fehlgeschlagen",
    errorUnknown: "Unbekannter Fehler.",
    retry: "Erneut versuchen",
    productBy: "ein Produkt von",
  },
  en: {
    eyebrow: "Setup",
    titleResolving: "Install<br>FORGE",
    title: (v) => `Install<br>FORGE <em>${v}</em>`,
    titleUpdate: (v) => `Update to<br>FORGE <em>${v}</em>`,
    titleSame: (v) => `FORGE <em>${v}</em><br>is already installed`,
    lead: "The desktop app for Claude Code. Git, Node.js, GitHub CLI and Python are included.",
    leadUpdate: (old) => `FORGE ${old} is installed. Projects and settings are kept.`,
    leadSame: "Reinstalling replaces the program files. Projects and settings are kept.",
    resolving: "Looking for the latest version",
    downloadSize: (mb) => `Downloads ${mb} MB from GitHub`,
    resolveFailed: "GitHub cannot be reached. Check the internet connection.",
    folder: "Install folder",
    change: "Change",
    install: "Install",
    update: "Update",
    reinstall: "Reinstall",
    license: (link) => `Installing means accepting the ${link} license.`,
    installingEyebrow: "Installation",
    installingTitle: "Installing FORGE",
    updatingTitle: "Updating FORGE",
    steps: { download: "Downloading FORGE", verify: "Checking the signature", install: "Installing FORGE", finish: "Almost done" },
    stepList: { download: "Download", verify: "Check signature", install: "Install", finish: "Finish" },
    received: (x, y) => `${x} of ${y} MB`,
    doneEyebrow: "Done",
    doneTitle: "FORGE is ready",
    doneLead: "You find FORGE in the Start menu.",
    installedIn: "Installed in",
    launch: "Start FORGE",
    close: "Close",
    minimize: "Minimize",
    errorEyebrow: "Error",
    errorTitle: "Installation failed",
    errorUnknown: "Unknown error.",
    retry: "Try again",
    productBy: "a product by",
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
  const installed = q.get("installed") === "same" ? { version, dir: "C:\\Users\\Demo\\AppData\\Local\\FORGE" }
    : q.get("installed") ? { version: "0.1.103", dir: "C:\\Users\\Demo\\AppData\\Local\\FORGE" } : null;
  const lang = q.get("lang") === "en" ? "en" : "de";
  let attempt = 0;

  async function run() {
    const fail = q.get("fail") && attempt++ === 0;
    const steps = [
      ["download", 0, 72, 5200],
      ["verify", 72, 76, 700],
      ["install", 76, 97, 2600],
      ["finish", 97, 100, 600],
    ];
    for (const [step, from, to, ms] of steps) {
      const t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const payload = { step, percent: from + (to - from) * k };
        if (step === "download") Object.assign(payload, { received: Math.round(total * k), total });
        emit("setup-progress", payload);
        if (fail && step === "download" && k > 0.55) {
          emit("setup-done", { ok: false, message: lang === "de" ? "Download abgebrochen: Die Verbindung zu GitHub wurde getrennt." : "Download stopped: the connection to GitHub was lost." });
          return;
        }
        if (k >= 1) break;
        await wait(80);
      }
    }
    emit("setup-done", { ok: true, message: null });
  }

  return {
    async invoke(cmd, args) {
      switch (cmd) {
        case "info":
          await wait(250);
          return { lang, defaultDir: "C:\\Users\\Demo\\AppData\\Local\\FORGE", installed };
        case "resolve":
          await wait(1100);
          if (q.get("offline")) throw lang === "de" ? "GitHub ist nicht erreichbar. Prüfe die Internetverbindung." : "GitHub cannot be reached. Check the internet connection.";
          return { version, downloadBytes: total };
        case "pick_dir":
          return "D:\\Programme\\FORGE";
        case "install":
          run();
          return null;
        default:
          console.log("demo:", cmd, args);
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

const state = {
  lang: "de",
  info: null,
  resolved: null, // { version, downloadBytes }
  resolveError: null,
  resolving: false,
  dir: "",
  progress: { step: "download", percent: 0 },
  error: null,
};

const t = () => TEXT[state.lang];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function mb(bytes) {
  const v = bytes / 1_000_000;
  return new Intl.NumberFormat(state.lang === "de" ? "de-DE" : "en-US", { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v);
}

/** "older" when an older version is installed, "same" when this one, null for a new installation. */
function installKind() {
  const inst = state.info?.installed;
  if (!inst) return null;
  if (state.resolved && inst.version === state.resolved.version) return "same";
  return "older";
}

function setScreen(name) {
  app.dataset.screen = name;
  $("btn-close").disabled = name === "installing";
}

function render() {
  const tx = t();
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const v = tx[el.dataset.i18n];
    if (typeof v === "string") el.textContent = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = tx[el.dataset.i18nTitle];
  for (const b of document.querySelectorAll(".lang-btn")) b.setAttribute("aria-pressed", String(b.dataset.lang === state.lang));

  // start
  const kind = installKind();
  const v = state.resolved ? escapeHtml(state.resolved.version) : null;
  $("start-title").innerHTML = !v ? tx.titleResolving : kind === "same" ? tx.titleSame(v) : kind === "older" ? tx.titleUpdate(v) : tx.title(v);
  $("start-lead").textContent = kind === "same" ? tx.leadSame : kind === "older" && state.info.installed.version ? tx.leadUpdate(state.info.installed.version) : tx.lead;
  const line = $("version-line");
  line.dataset.state = state.resolved ? "ready" : state.resolveError ? "error" : "resolving";
  $("version-ready").textContent = state.resolved ? tx.downloadSize(mb(state.resolved.downloadBytes)) : "";
  $("resolve-error").textContent = state.resolveError || "";
  $("folder-path").textContent = state.dir;
  $("folder-path").title = state.dir;
  $("done-path").textContent = state.dir;
  $("folder").dataset.locked = String(!!state.info?.installed);
  const install = $("btn-install");
  install.textContent = kind === "same" ? tx.reinstall : kind === "older" ? tx.update : tx.install;
  install.disabled = !state.resolved;
  $("license").innerHTML = tx.license(`<button type="button" class="link" id="btn-license">AGPL-3.0</button>`);

  // installing
  $("installing-eyebrow").textContent = tx.installingEyebrow;
  $("installing-title").textContent = state.info?.installed ? tx.updatingTitle : tx.installingTitle;
  renderProgress();

  // error
  $("error-message").textContent = state.error || tx.errorUnknown;
}

function renderProgress() {
  const tx = t();
  const p = state.progress;
  const pct = Math.max(0, Math.min(100, p.percent || 0));
  $("step").textContent = tx.steps[p.step] || tx.steps.install;
  $("progress-fill").style.width = `${pct}%`;
  $("progress").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("percent").textContent = `${Math.floor(pct)} %`;
  const meta = p.step === "download" && p.received != null && p.total ? tx.received(mb(p.received), mb(p.total)) : state.dir;
  $("progress-dir").textContent = meta;
  const order = ["download", "verify", "install", "finish"];
  const at = pct >= 100 ? order.length : order.indexOf(p.step);
  for (const li of $("steps").children) {
    const i = order.indexOf(li.dataset.step);
    li.textContent = tx.stepList[li.dataset.step];
    li.dataset.state = i < at ? "done" : i === at ? "active" : "todo";
  }
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
  render();
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
  render();
  setScreen("error");
  forge.idle();
}

async function init() {
  await backend.listen("setup-progress", (p) => {
    state.progress = p;
    renderProgress();
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

  try {
    state.info = await backend.invoke("info");
  } catch {
    state.info = { lang: "de", defaultDir: "", installed: null };
  }
  state.lang = state.info.lang === "en" ? "en" : "de";
  state.dir = state.info.installed?.dir || state.info.defaultDir;
  render();
  setScreen("start");
  resolve();
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el || el.disabled) return;
  switch (el.id) {
    case "btn-min": return backend.invoke("minimize");
    case "btn-close":
    case "btn-done-close":
    case "btn-error-close": return backend.invoke("quit");
    case "btn-change": {
      const dir = await backend.invoke("pick_dir", { current: state.dir });
      if (dir) {
        state.dir = dir;
        render();
      }
      return;
    }
    case "btn-license": return backend.invoke("open_url", { url: LICENSE_URL });
    case "btn-install":
    case "btn-retry": return startInstall();
    case "btn-resolve-retry": return resolve();
    case "btn-launch": return backend.invoke("launch", { dir: state.dir });
  }
  if (el.dataset.lang) {
    state.lang = el.dataset.lang;
    render();
  }
});

// ---------------------------------------------------------------- hammer and anvil

const forge = createForge();

function createForge() {
  const art = $("art");
  const hammer = $("hammer");
  const heat = $("heat");
  const glow = $("anvil-glow");
  const face = $("anvil-face");
  const impactEl = $("impact");
  const canvas = $("sparks");
  const ctx = canvas.getContext("2d");
  const PIVOT = [1054, 246];
  const CYCLE = 1100;
  // [phase, angle]: hit at 0, rebound, raise, short hold, strike
  const SWING = [[0, 0], [0.07, 9], [0.15, 5], [0.62, 58], [0.72, 61], [1, 0]];

  let mode = "idle"; // idle | work | final | rest
  let t0 = performance.now();
  let lastCycle = -1;
  let final = null;
  let heatLevel = 0;
  let shake = 0;
  let angle = 46;
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
    const a = app.getBoundingClientRect();
    return [r.left + r.width / 2 - a.left, r.top + r.height / 2 - a.top];
  }

  function impact(strength) {
    heatLevel = Math.min(1.4, heatLevel + 0.75 * strength);
    shake = 2.2 * strength;
    if (reduceMotion) return;
    const [x, y] = impactPoint();
    const n = Math.round(34 * strength);
    for (let i = 0; i < n; i++) {
      // mostly up and to the sides, a few skidding along the anvil
      const dir = Math.random() < 0.85 ? -Math.PI * (0.06 + Math.random() * 0.88) : (Math.random() < 0.5 ? -0.08 : Math.PI + 0.08);
      const speed = (180 + Math.random() * 420) * Math.sqrt(strength);
      const life = 0.35 + Math.random() * 0.75 * Math.sqrt(strength);
      particles.push({
        x: x + (Math.random() - 0.5) * 24,
        y: y - 2,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        life,
        max: life,
        w: 1 + Math.random() * 1.8,
        hue: 22 + Math.random() * 28,
        ember: false,
      });
    }
  }

  function ember() {
    const [x, y] = impactPoint();
    const life = 1.6 + Math.random() * 1.6;
    particles.push({
      x: x + (Math.random() - 0.5) * 90,
      y: y + 4 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 14,
      vy: -(16 + Math.random() * 26),
      life,
      max: life,
      w: 1 + Math.random() * 1.4,
      hue: 20 + Math.random() * 20,
      ember: true,
    });
  }

  function step(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    let target = angle;

    if (reduceMotion) {
      target = mode === "rest" ? 0 : 40;
    } else if (mode === "idle") {
      target = 46 + Math.sin(now / 900) * 2.2;
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
      const RAISE = 520, HOLD = 160, STRIKE = 190;
      if (e < RAISE) target = final.from + (74 - final.from) * easeOut(e / RAISE);
      else if (e < RAISE + HOLD) target = 74 + Math.sin(((e - RAISE) / HOLD) * Math.PI) * 1.5;
      else if (e < RAISE + HOLD + STRIKE) target = 74 * (1 - easeIn((e - RAISE - HOLD) / STRIKE));
      else {
        if (!final.hit) {
          final.hit = true;
          impact(2.8);
          setTimeout(() => impact(1.2), 90);
          setTimeout(final.done, 650);
        }
        const r = (e - RAISE - HOLD - STRIKE) / 420;
        target = r < 1 ? Math.sin(r * Math.PI) * 11 * (1 - r) : 0;
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

    // heat on the anvil: flash after a hit, a slow breath otherwise
    heatLevel = Math.max(0, heatLevel - dt * 2.4);
    const breath = reduceMotion ? 0.7 : 0.62 + Math.sin(now / 1100) * 0.12;
    heat.setAttribute("opacity", Math.min(1, heatLevel).toFixed(3));
    glow.setAttribute("opacity", Math.min(1.6, breath + heatLevel * 0.9).toFixed(3));
    face.style.filter = heatLevel > 0.01 ? `brightness(${(1 + heatLevel * 0.35).toFixed(3)})` : "";

    shake = Math.max(0, shake - dt * 18);
    art.style.transform = shake > 0.05 ? `translate(${((Math.random() - 0.5) * shake).toFixed(2)}px, ${((Math.random() - 0.5) * shake).toFixed(2)}px)` : "";

    // embers drifting up from the anvil while it is warm
    if (!reduceMotion) {
      emberClock += dt * (mode === "work" ? 5 : mode === "rest" ? 1.2 : 2);
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
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0 || p.y > h + 20 || p.x < -20 || p.x > w + 20) {
        particles.splice(i, 1);
        continue;
      }
      const k = p.life / p.max;
      if (p.ember) {
        p.vx += (Math.random() - 0.5) * 40 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const flicker = 0.55 + Math.random() * 0.45;
        ctx.fillStyle = `hsla(${p.hue}, 100%, 62%, ${(Math.sin(k * Math.PI) * 0.75 * flicker).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.w, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      p.vy += 980 * dt;
      p.vx *= 1 - 0.9 * dt;
      const px = p.x;
      const py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const tail = 0.022;
      ctx.strokeStyle = `hsla(${p.hue}, 100%, ${(58 + 30 * k).toFixed(0)}%, ${Math.min(1, k * 1.4).toFixed(3)})`;
      ctx.lineWidth = p.w * (0.6 + 0.4 * k);
      ctx.beginPath();
      ctx.moveTo(px - p.vx * tail, py - p.vy * tail);
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
