import { SabreWulfGame } from "./game/sabreWulfGame";
import "./style.css";
import {
  CTRL_DOWN,
  CTRL_FIRE,
  CTRL_LEFT,
  CTRL_RIGHT,
  CTRL_UP,
} from "./zx/input";

const canvas = document.getElementById("zx-canvas") as HTMLCanvasElement;
const monitorFrame = document.getElementById("monitor-frame") as HTMLDivElement;
const crtOverlay = document.getElementById("crt-overlay") as HTMLDivElement;
const statusPill = document.getElementById("status-pill") as HTMLDivElement;

const btnMute = document.getElementById("btn-mute") as HTMLButtonElement;
const btnMuteLabel = document.getElementById(
  "btn-mute-label",
) as HTMLSpanElement;
const btnCrt = document.getElementById("btn-crt") as HTMLButtonElement;
const btnCrtLabel = document.getElementById("btn-crt-label") as HTMLSpanElement;
const btnPause = document.getElementById("btn-pause") as HTMLButtonElement;
const btnPauseLabel = document.getElementById(
  "btn-pause-label",
) as HTMLSpanElement;
const btnMenu = document.getElementById("btn-menu") as HTMLButtonElement;
const btnFullscreen = document.getElementById(
  "btn-fullscreen",
) as HTMLButtonElement;
const btnForceLandscape = document.getElementById(
  "btn-force-landscape",
) as HTMLButtonElement;

const mapDrawer = document.getElementById("map-drawer") as HTMLElement;
const mapCanvas = document.getElementById("map-canvas") as HTMLCanvasElement;
const mapPct = document.getElementById("map-pct") as HTMLSpanElement;
const mapCtx = mapCanvas.getContext("2d")!;

const game = new SabreWulfGame(canvas);

let crtEnabled = false;
let mapToggled = false; // desktop: M hotkey

// The map is shown while the options screen is open, or when toggled with the M hotkey
function isMapVisible(): boolean {
  return mapToggled || document.body.classList.contains("options-open");
}

function syncMapVisibility(): void {
  const visible = isMapVisible();
  mapDrawer.classList.toggle("hidden", !visible);
  if (visible) renderExplorerMap();
}

function toggleMute(): void {
  game.beeper.unlock();
  const next = !game.beeper.isMuted();
  game.beeper.setMuted(next);
  btnMuteLabel.textContent = next ? "MUTED" : "SOUND ON";
  btnMute.classList.toggle("active", !next);
  btnMute.classList.toggle("muted", next);
  game.refreshMenuIfActive();
}

function toggleCrt(): void {
  crtEnabled = !crtEnabled;
  crtOverlay.classList.toggle("hidden", !crtEnabled);
  btnCrtLabel.textContent = crtEnabled ? "CRT ON" : "CRT OFF";
  btnCrt.classList.toggle("active", crtEnabled);
  game.refreshMenuIfActive();
}

function toggleMap(): void {
  mapToggled = !mapToggled;
  syncMapVisibility();
}

function togglePause(): void {
  if (!isPausablePhase()) return;
  const next = !game.input.isPaused();
  game.input.setPaused(next);
  game.beeper.setPaused(next);
  if (!next) {
    game.beeper.unlock();
  }
}

btnMute.addEventListener("click", () => {
  btnMute.blur();
  toggleMute();
});
btnCrt.addEventListener("click", () => {
  btnCrt.blur();
  toggleCrt();
});
btnPause.addEventListener("click", () => {
  btnPause.blur();
  togglePause();
});
btnMenu.addEventListener("click", () => {
  btnMenu.blur();
  game.beeper.stopTune();
  setOptionsOpen(false);
  game.beeper.unlock();
  game.returnToMenu();
});
// Hidden zero-size probe to read raw CSS env(safe-area-inset-*) values on mobile fullscreen
const safeAreaProbe = document.createElement("div");
safeAreaProbe.setAttribute("aria-hidden", "true");
safeAreaProbe.style.cssText =
  "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
  "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) " +
  "env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
document.body.appendChild(safeAreaProbe);

let lastFsPadL = "0px";
let lastFsPadR = "0px";
let lastFrameW = 0;
let lastFrameH = 0;

function syncViewportMetrics(): void {
  const probeStyle = window.getComputedStyle(safeAreaProbe);
  const safeL = parseFloat(probeStyle.paddingLeft) || 0;
  const safeR = parseFloat(probeStyle.paddingRight) || 0;

  let fsPadL = "0px";
  const fsPadR = "0px";

  // Fallback for Android OEM/Chrome configurations where fullscreen pillarboxes a right-side
  // camera cutout outside the webview (safeL=0, safeR=0, innerWidth < physical screen width)
  if (
    document.fullscreenElement &&
    window.innerWidth > window.innerHeight &&
    safeL === 0 &&
    safeR === 0
  ) {
    const physW = Math.max(window.screen.width, window.screen.height);
    const gap = physW - window.innerWidth;
    const angle = window.screen.orientation?.angle;
    const orientType = window.screen.orientation?.type ?? "";
    if (
      gap >= 12 &&
      gap <= 96 &&
      (angle === 270 || orientType === "landscape-secondary")
    ) {
      fsPadL = `${gap}px`;
    }
  }

  const rootStyle = document.documentElement.style;
  if (fsPadL !== lastFsPadL) {
    lastFsPadL = fsPadL;
    rootStyle.setProperty("--fs-pad-l", fsPadL);
  }
  if (fsPadR !== lastFsPadR) {
    lastFsPadR = fsPadR;
    rootStyle.setProperty("--fs-pad-r", fsPadR);
  }

  const rect = monitorFrame.getBoundingClientRect();
  if (
    rect.width > 0 &&
    rect.height > 0 &&
    (Math.abs(rect.width - lastFrameW) > 0.25 ||
      Math.abs(rect.height - lastFrameH) > 0.25)
  ) {
    lastFrameW = rect.width;
    lastFrameH = rect.height;
    monitorFrame.style.setProperty("--frame-w", `${rect.width}px`);
    monitorFrame.style.setProperty("--frame-h", `${rect.height}px`);
  }
}

function scheduleViewportResync(): void {
  syncViewportMetrics();
  for (const delayMs of [60, 200, 500, 900]) {
    window.setTimeout(syncViewportMetrics, delayMs);
  }
}

syncViewportMetrics();
window.addEventListener("resize", syncViewportMetrics);
window.addEventListener("orientationchange", scheduleViewportResync);
window.screen.orientation?.addEventListener?.("change", scheduleViewportResync);
window.visualViewport?.addEventListener("resize", syncViewportMetrics);
window.visualViewport?.addEventListener("scroll", syncViewportMetrics);
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => syncViewportMetrics()).observe(monitorFrame);
}

// Fullscreen is unavailable on some browsers (e.g. iPhone Safari) and unnecessary when
// launched as an installed standalone/fullscreen PWA. Note that `(display-mode: fullscreen)`
// also matches inside a normal browser tab while `requestFullscreen()` is active, so check
// launch-time app-fullscreen (when `document.fullscreenElement` is null) separately from
// `(display-mode: standalone)` so the button never disappears when toggling fullscreen in-browser!
const standaloneModeQuery = window.matchMedia("(display-mode: standalone)");
const launchedInAppFullscreen =
  window.matchMedia("(display-mode: fullscreen)").matches &&
  !document.fullscreenElement;

function isInstalledStandaloneApp(): boolean {
  return (
    launchedInAppFullscreen ||
    standaloneModeQuery.matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
function canUseFullscreenApi(): boolean {
  const doc = document as Document & { webkitFullscreenEnabled?: boolean };
  return Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}
async function tryLockLandscape(): Promise<void> {
  const orient = window.screen.orientation as ScreenOrientation & {
    lock?: (orientation: string) => Promise<void>;
  };
  try {
    await orient?.lock?.("landscape");
  } catch {
    // Ignored when browser denies orientation lock outside fullscreen/WebAPK.
  }
}
async function enterFullscreenLandscape(): Promise<void> {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.({
        navigationUI: "hide",
      });
    }
    await tryLockLandscape();
  } catch {
    // Request denied — ignore.
  }
}
function syncFullscreenButtonVisibility(): void {
  const hideFs = isInstalledStandaloneApp() || !canUseFullscreenApi();
  btnFullscreen.hidden = hideFs;
  btnForceLandscape.hidden = hideFs;
  game.refreshMenuIfActive();
}
syncFullscreenButtonVisibility();
standaloneModeQuery.addEventListener?.("change", syncFullscreenButtonVisibility);
if (isInstalledStandaloneApp()) {
  void tryLockLandscape();
}

function toggleFullscreenMode(): void {
  if (!document.fullscreenElement) {
    void enterFullscreenLandscape();
  } else {
    void document.exitFullscreen?.();
  }
}

function quitStandaloneApp(): void {
  try {
    window.close();
  } catch {
    // Ignore if blocked by OS/browser container
  }
}

game.setExternalUiHooks({
  isStandaloneApp: isInstalledStandaloneApp,
  canFullscreen: canUseFullscreenApi,
  isFullscreen: () => Boolean(document.fullscreenElement),
  toggleFullscreen: toggleFullscreenMode,
  isCrtEnabled: () => crtEnabled,
  toggleCrt,
  toggleMute,
  quitApp: quitStandaloneApp,
});

btnFullscreen.addEventListener("click", () => {
  btnFullscreen.blur();
  toggleFullscreenMode();
});
btnForceLandscape.addEventListener("click", () => {
  btnForceLandscape.blur();
  game.beeper.unlock();
  void enterFullscreenLandscape();
});
document.addEventListener("fullscreenchange", () => {
  btnFullscreen.classList.toggle("active", Boolean(document.fullscreenElement));
  game.refreshMenuIfActive();
  scheduleViewportResync();
});

canvas.addEventListener("pointerdown", (ev) => {
  const rect = canvas.getBoundingClientRect();
  game.handleScreenTap(
    (ev.clientX - rect.left) / rect.width,
    (ev.clientY - rect.top) / rect.height,
  );
});
monitorFrame.addEventListener("pointerdown", (ev) => {
  game.beeper.unlock();
  const isMobile = window.matchMedia(
    "(pointer: coarse), (max-width: 760px)",
  ).matches;
  if (
    ev.target !== canvas &&
    (game.getPhase() === "LOADING" ||
      (!isMobile && game.getPhase() === "HALL_OF_FAME"))
  ) {
    game.triggerPrimaryAction();
  }
});

// Browsers only allow audio to start from a touch on release (pointerup / touchend / click),
// not on pointerdown, so also (re)try unlocking the audio context there. A tune queued by the
// first tap then starts as soon as the context resumes.
for (const type of ["pointerup", "touchend", "click"] as const) {
  window.addEventListener(
    type,
    () => {
      if (!document.hidden) {
        game.beeper.setBackgroundSuspended(false);
      }
      game.beeper.unlock();
    },
    { capture: true },
  );
}

// Global UI convenience hotkeys (M = Map, C = CRT, Esc = Menu, F = Fullscreen)
window.addEventListener("keydown", (e) => {
  game.beeper.unlock();
  if (game.getPhase() === "ENTER_INITIALS") return;

  if (e.code === "KeyM") {
    toggleMap();
  } else if (e.code === "KeyC") {
    toggleCrt();
  } else if (e.code === "Escape") {
    setOptionsOpen(false);
    game.returnToMenu();
  } else if (e.code === "KeyF") {
    if (!btnFullscreen.hidden) {
      btnFullscreen.click();
    }
  }
});

// Touch controls wiring
const DIR_MASK = CTRL_LEFT | CTRL_RIGHT | CTRL_UP | CTRL_DOWN;
const touchControls = document.querySelector(".touch-controls") as HTMLElement;
const joystick = document.getElementById("joystick") as HTMLDivElement;
const joystickKnob = document.getElementById("joystick-knob") as HTMLDivElement;
const initialsControls = document.getElementById(
  "initials-controls",
) as HTMLDivElement;
const btnInitPrev = document.getElementById(
  "btn-init-prev",
) as HTMLButtonElement;
const btnInitNext = document.getElementById(
  "btn-init-next",
) as HTMLButtonElement;
const btnInitDel = document.getElementById("btn-init-del") as HTMLButtonElement;
const btnInitOk = document.getElementById("btn-init-ok") as HTMLButtonElement;

function isGameplayPadPhase(): boolean {
  const phase = game.getPhase();
  return phase === "STARTUP_TUNE" || phase === "PLAYING";
}

function areActionPadsVisible(): boolean {
  return (
    isGameplayPadPhase() && !document.body.classList.contains("options-open")
  );
}

function areInitialsControlsVisible(): boolean {
  return (
    game.getPhase() === "ENTER_INITIALS" &&
    !document.body.classList.contains("options-open")
  );
}
// Every finger currently on the stick; the most recently active one drives it. This way a
// stray or ghost contact can neither take the stick over for good nor lock out the real thumb.
interface StickPointer {
  x: number;
  y: number;
  t: number;
  t0: number;
}
const stickPointers = new Map<number, StickPointer>();
// Pointers that started on the stick and have not ended yet. A pointer in here that is not
// in stickPointers was dropped by mistake and is re-adopted as soon as it moves again.
const stickOrigin = new Set<number>();
let joystickDir = 0;

// Opt-in diagnostics: open the page with ?debug to trace stick events on screen
const debugEl = new URLSearchParams(location.search).has("debug")
  ? document.body.appendChild(document.createElement("pre"))
  : null;
const debugLines: string[] = [];
let pinnedLoss = "";
function renderDebug(): void {
  if (!debugEl) return;
  debugEl.textContent =
    (pinnedLoss ? `LAST LOSS: ${pinnedLoss}\n---\n` : "") +
    debugLines.join("\n");
}
function debugLog(msg: string): void {
  if (!debugEl) return;
  debugLines.push(`${(performance.now() / 1000).toFixed(1)} ${msg}`);
  if (debugLines.length > 10) debugLines.shift();
  renderDebug();
}
// Stays on screen until the next loss, so it can be read after the fact
function debugLoss(msg: string): void {
  pinnedLoss = `${(performance.now() / 1000).toFixed(1)} ${msg}`;
  debugLog(msg);
}
if (debugEl) {
  debugEl.style.cssText =
    "position:fixed;top:0;left:0;margin:0;padding:4px;z-index:99;pointer-events:none;" +
    "font:11px monospace;color:#0f0;background:rgba(0,0,0,0.6);max-width:70vw;white-space:pre-wrap";
  for (const type of ["touchstart", "touchend", "touchcancel"]) {
    window.addEventListener(
      type,
      (ev) => debugLog(`${type} touches=${(ev as TouchEvent).touches.length}`),
      { capture: true, passive: true },
    );
  }
  for (const type of ["resize", "blur", "focus", "scroll"]) {
    window.addEventListener(type, () => debugLog(`window ${type}`));
  }
  document.addEventListener("visibilitychange", () =>
    debugLog(`visibility ${document.visibilityState}`),
  );
}
let lastDriver: number | null = null;

function setJoystickDirection(dirMask: number): void {
  joystickDir = dirMask;
  game.input.touchControlsMask =
    (game.input.touchControlsMask & ~DIR_MASK) | dirMask;
  joystick.classList.toggle("dir-left", (dirMask & CTRL_LEFT) !== 0);
  joystick.classList.toggle("dir-right", (dirMask & CTRL_RIGHT) !== 0);
  joystick.classList.toggle("dir-up", (dirMask & CTRL_UP) !== 0);
  joystick.classList.toggle("dir-down", (dirMask & CTRL_DOWN) !== 0);
}

// While a finger is on the stick, keep the game's direction bits in sync with it, so
// anything that clears the shared mask (e.g. a window blur) cannot silently drop it
function resyncJoystick(): void {
  if (stickPointers.size > 0) setJoystickDirection(joystickDir);
}

function applyStick(
  clientX: number,
  clientY: number,
  id: number | null = null,
): void {
  const rect = joystick.getBoundingClientRect();
  const travel = rect.width * 0.32;
  let dx = clientX - (rect.left + rect.width / 2);
  let dy = clientY - (rect.top + rect.height / 2);
  const dist = Math.hypot(dx, dy);
  if (id !== lastDriver) {
    debugLog(
      `drive ${lastDriver}->${id} d=${Math.round(dist)}/${Math.round(travel)} of ${stickPointers.size} ptrs`,
    );
    lastDriver = id;
  }

  let dirMask = 0;
  if (dist > travel * 0.3) {
    // 8-way with wide cardinal zones: a diagonal needs 30-60 degrees, so
    // aiming roughly straight at a gap stays purely horizontal or vertical
    const nx = dx / dist;
    const ny = dy / dist;
    if (nx < -0.5) dirMask |= CTRL_LEFT;
    if (nx > 0.5) dirMask |= CTRL_RIGHT;
    if (ny < -0.5) dirMask |= CTRL_UP;
    if (ny > 0.5) dirMask |= CTRL_DOWN;
  }
  setJoystickDirection(dirMask);

  if (dist > travel) {
    dx = (dx / dist) * travel;
    dy = (dy / dist) * travel;
  }
  joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
}

// Re-point the stick at the most recently active remaining finger, or neutral if none
function refreshStick(): void {
  let best: StickPointer | null = null;
  let bestId: number | null = null;
  for (const [id, p] of stickPointers) {
    if (!best || p.t > best.t) {
      best = p;
      bestId = id;
    }
  }
  if (best) {
    joystick.classList.add("stick-active");
    applyStick(best.x, best.y, bestId);
  } else {
    debugLog("stick neutral (no pointers)");
    lastDriver = null;
    joystick.classList.remove("stick-active");
    setJoystickDirection(0);
    joystickKnob.style.transform = "";
  }
}

function releaseJoystick(ev: PointerEvent): void {
  stickOrigin.delete(ev.pointerId);
  const p = stickPointers.get(ev.pointerId);
  if (!p) return;
  const msg =
    `${ev.type} id=${ev.pointerId} ${ev.pointerType} ` +
    `contact=${Math.round(ev.width)}x${Math.round(ev.height)} ` +
    `held=${Math.round(ev.timeStamp - p.t0)}ms left=${stickPointers.size - 1}`;
  if (ev.type === "pointercancel") debugLoss(msg);
  else debugLog(msg);
  stickPointers.delete(ev.pointerId);
  refreshStick();
}

joystick.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  game.beeper.unlock();
  debugLog(
    `pointerdown id=${ev.pointerId} contact=${Math.round(ev.width)}x${Math.round(ev.height)} others=${stickPointers.size}`,
  );
  stickOrigin.add(ev.pointerId);
  stickPointers.set(ev.pointerId, {
    x: ev.clientX,
    y: ev.clientY,
    t: ev.timeStamp,
    t0: ev.timeStamp,
  });
  joystick.classList.add("stick-active");
  joystick.setPointerCapture(ev.pointerId);
  applyStick(ev.clientX, ev.clientY, ev.pointerId);
});
// The touch hardware can swap a held finger for a new touch id mid-drag. If the thumb has
// slid past the edge of the stick, the replacement lands outside the element and would never
// reach it, so adopt any new touch that lands in a generous zone around the stick.
window.addEventListener("pointerdown", (ev) => {
  if (stickPointers.has(ev.pointerId)) return;
  if (ev.pointerType !== "touch") return;
  if (!areActionPadsVisible()) return;
  const target = ev.target as Element | null;
  if (
    target &&
    (joystick.contains(target) ||
      target.closest(".fire-btn") ||
      target.closest(".options-btn"))
  )
    return;
  const rect = joystick.getBoundingClientRect();
  const dist = Math.hypot(
    ev.clientX - (rect.left + rect.width / 2),
    ev.clientY - (rect.top + rect.height / 2),
  );
  debugLog(
    `pointerdown OUTSIDE id=${ev.pointerId} d=${Math.round(dist)} ` +
      `zone=${Math.round(rect.width)} target=${target?.id || target?.tagName}`,
  );
  if (dist > rect.width) return;
  stickOrigin.add(ev.pointerId);
  stickPointers.set(ev.pointerId, {
    x: ev.clientX,
    y: ev.clientY,
    t: ev.timeStamp,
    t0: ev.timeStamp,
  });
  joystick.classList.add("stick-active");
  applyStick(ev.clientX, ev.clientY, ev.pointerId);
});
// Track fingers on window so the stick follows them even if pointer capture is lost;
// only a real pointerup / pointercancel releases one (not lostpointercapture)
window.addEventListener("pointermove", (ev) => {
  let p = stickPointers.get(ev.pointerId);
  if (!p) {
    if (!stickOrigin.has(ev.pointerId)) return;
    // Still moving, so the finger is still down: it was dropped wrongly
    p = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp, t0: ev.timeStamp };
    stickPointers.set(ev.pointerId, p);
    debugLoss(`re-adopted id=${ev.pointerId} (was dropped while still down)`);
  }
  p.x = ev.clientX;
  p.y = ev.clientY;
  p.t = ev.timeStamp;
  applyStick(ev.clientX, ev.clientY, ev.pointerId);
});
window.addEventListener("pointerup", releaseJoystick);
window.addEventListener("pointercancel", releaseJoystick);
// Drop pointers whose release was lost: after any touch ends, no more fingers can be on
// the stick than there are touches that started on it
function reconcileStickTouches(ev: TouchEvent): void {
  if (stickPointers.size === 0) return;
  let count = 0;
  for (const touch of Array.from(ev.touches)) {
    if (touch.target instanceof Node && joystick.contains(touch.target))
      count++;
  }
  let removed = false;
  while (stickPointers.size > count) {
    let oldestId: number | null = null;
    let oldestT = Infinity;
    for (const [id, p] of stickPointers) {
      if (p.t < oldestT) {
        oldestT = p.t;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    stickPointers.delete(oldestId);
    removed = true;
    debugLoss(`reconcile dropped id=${oldestId} (touches on stick=${count})`);
  }
  if (removed) refreshStick();
}
window.addEventListener("touchend", reconcileStickTouches, { passive: true });
window.addEventListener("touchcancel", reconcileStickTouches, {
  passive: true,
});
// Stop the browser from taking over touches on the controls (scroll / gesture handling
// would otherwise cancel the pointer mid-drag)
for (const id of ["joystick", "touch-fire"]) {
  for (const type of ["touchstart", "touchmove"] as const) {
    document
      .getElementById(id)
      ?.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
  }
}
// Suppress long-press menus / selection anywhere on touch devices; they cancel
// the active pointer and would drop the stick while a finger is still down
if (window.matchMedia("(pointer: coarse)").matches) {
  window.addEventListener("contextmenu", (ev) => ev.preventDefault());
  document.addEventListener("selectstart", (ev) => ev.preventDefault());
}

const touchFire = document.getElementById("touch-fire");
if (touchFire) {
  touchFire.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    game.beeper.unlock();
    touchFire.classList.add("pressed");
    game.input.touchControlsMask |= CTRL_FIRE;
  });
  const releaseFire = (e: Event) => {
    e.preventDefault();
    touchFire.classList.remove("pressed");
    game.input.touchControlsMask &= ~CTRL_FIRE;
  };
  touchFire.addEventListener("pointerup", releaseFire);
  touchFire.addEventListener("pointercancel", releaseFire);
  touchFire.addEventListener("pointerleave", releaseFire);
}

// Hall of Fame Initials Entry rubber keys (tap or hold ◀ / ▶ to cycle letters, DEL / ENTER)
let initRepeatDelayTimer: number | null = null;
let initRepeatIntervalTimer: number | null = null;

function stopInitialStepperRepeat(): void {
  if (initRepeatDelayTimer !== null) {
    window.clearTimeout(initRepeatDelayTimer);
    initRepeatDelayTimer = null;
  }
  if (initRepeatIntervalTimer !== null) {
    window.clearInterval(initRepeatIntervalTimer);
    initRepeatIntervalTimer = null;
  }
  btnInitPrev.classList.remove("pressed");
  btnInitNext.classList.remove("pressed");
}

function bindInitialStepperButton(
  btn: HTMLButtonElement,
  delta: -1 | 1,
): void {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    game.beeper.unlock();
    stopInitialStepperRepeat();
    btn.classList.add("pressed");
    game.stepInitialLetter(delta);
    initRepeatDelayTimer = window.setTimeout(() => {
      initRepeatIntervalTimer = window.setInterval(() => {
        if (game.getPhase() !== "ENTER_INITIALS") {
          stopInitialStepperRepeat();
          return;
        }
        game.stepInitialLetter(delta);
      }, 95);
    }, 280);
  });
  for (const evName of ["pointerup", "pointercancel", "pointerleave"] as const) {
    btn.addEventListener(evName, (e) => {
      e.preventDefault();
      stopInitialStepperRepeat();
    });
  }
}

bindInitialStepperButton(btnInitPrev, -1);
bindInitialStepperButton(btnInitNext, 1);

btnInitDel.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  game.beeper.unlock();
  game.backspaceInitialLetter();
});
btnInitOk.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  game.beeper.unlock();
  game.confirmInitialLetter();
});
for (const el of [btnInitPrev, btnInitNext, btnInitDel, btnInitOk]) {
  for (const type of ["touchstart", "touchmove"] as const) {
    el.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
  }
}

// Options screen (mobile): the toolbar and map live behind a gear button
const btnOptions = document.getElementById("btn-options") as HTMLButtonElement;
const btnOptionsClose = document.getElementById(
  "btn-options-close",
) as HTMLButtonElement;
const optionsBackdrop = document.getElementById(
  "options-backdrop",
) as HTMLDivElement;
let pausedByOptions = false;
let wasInputPausedBeforeOptions = false;

function isPausablePhase(): boolean {
  const phase = game.getPhase();
  return (
    phase === "STARTUP_TUNE" ||
    phase === "PLAYING" ||
    phase === "SHOW_AMULET"
  );
}

function clearTouchPadState(): void {
  game.input.touchControlsMask = 0;
  stickPointers.clear();
  stickOrigin.clear();
  lastDriver = null;
  joystick.classList.remove("stick-active");
  touchFire?.classList.remove("pressed");
  setJoystickDirection(0);
  joystickKnob.style.transform = "";
  stopInitialStepperRepeat();
}

function setOptionsOpen(open: boolean): void {
  if (document.body.classList.contains("options-open") === open) return;
  document.body.classList.toggle("options-open", open);
  if (open) {
    clearTouchPadState();
    if (isPausablePhase()) {
      wasInputPausedBeforeOptions = game.input.isPaused();
      game.setUiPaused(true);
      pausedByOptions = true;
    }
  } else if (pausedByOptions) {
    pausedByOptions = false;
    game.setUiPaused(false);
    if (wasInputPausedBeforeOptions) {
      game.input.setPaused(true);
      game.beeper.setPaused(true);
    }
    wasInputPausedBeforeOptions = false;
  }
  syncMapVisibility();
}

btnOptions.addEventListener("click", () => {
  game.beeper.unlock();
  setOptionsOpen(true);
});
btnOptionsClose.addEventListener("click", () => setOptionsOpen(false));
optionsBackdrop.addEventListener("click", () => setOptionsOpen(false));

// Silence all audio (including menu/cutscene music) & auto-pause gameplay when minimizing
// the app, opening the OS app switcher, or turning the phone display off.
function suspendForBackground(): void {
  clearTouchPadState();
  game.beeper.setBackgroundSuspended(true);
  if (!isPausablePhase()) return;
  if (window.matchMedia("(pointer: coarse)").matches) {
    setOptionsOpen(true);
  } else {
    game.input.setPaused(true);
    game.beeper.setPaused(true);
  }
}

function resumeFromBackgroundIfActive(): void {
  if (document.hidden) return;
  game.beeper.setBackgroundSuspended(false);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    suspendForBackground();
  } else {
    resumeFromBackgroundIfActive();
  }
});
window.addEventListener("pagehide", suspendForBackground);
window.addEventListener("pageshow", resumeFromBackgroundIfActive);
document.addEventListener("freeze", suspendForBackground);
document.addEventListener("resume", resumeFromBackgroundIfActive);
window.addEventListener("blur", () => {
  if (
    window.matchMedia("(pointer: coarse)").matches ||
    isInstalledStandaloneApp()
  ) {
    suspendForBackground();
  }
});
window.addEventListener("focus", resumeFromBackgroundIfActive);

function renderExplorerMap(): void {
  const snap = game.getMapSnapshot();
  mapPct.textContent = `${snap.percentage}%`;
  mapCtx.imageSmoothingEnabled = false;

  const cell = 12; // 16 * 12 = 192
  // Pure ZX Spectrum PAPER 0 black background
  mapCtx.fillStyle = "#000000";
  mapCtx.fillRect(0, 0, 192, 192);

  for (let room = 0; room < 256; room++) {
    const col = room & 0x0f;
    const row = (room >>> 4) & 0x0f;
    const x = col * cell;
    const y = row * cell;
    const visited = (snap.visitedRooms[room >> 3] & (1 << (room & 7))) !== 0;

    if (visited) {
      if (room === 0x88) {
        // Underwurlde Cave room $88 in crisp ZX Cyan
        mapCtx.fillStyle = "#00d7d7";
        mapCtx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        mapCtx.fillStyle = "#00ffff";
        mapCtx.fillRect(x + 3, y + 3, cell - 6, cell - 6);
      } else {
        // Explored jungle room in ZX Green ($00D700) with crisp inner pixel highlight
        mapCtx.fillStyle = "#009800";
        mapCtx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        mapCtx.fillStyle = "#00d700";
        mapCtx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      }
    } else {
      // Unexplored sector: subtle 1-bit pixel grid marker
      mapCtx.fillStyle = "#181e28";
      mapCtx.fillRect(x + 1, y + 1, cell - 2, 1);
      mapCtx.fillRect(x + 1, y + 1, 1, cell - 2);
      mapCtx.fillStyle = "#252e3d";
      mapCtx.fillRect(x + 5, y + 5, 2, 2);
    }
  }

  if (snap.isPlaying) {
    const pCol = snap.playerRoom & 0x0f;
    const pRow = (snap.playerRoom >>> 4) & 0x0f;
    const px = pCol * cell;
    const py = pRow * cell;
    // Authentic ~320ms (16 frames @ 50Hz) ZX Spectrum FLASH attribute alternation
    const flashOn = Math.floor(performance.now() / 320) % 2 === 0;
    mapCtx.fillStyle = flashOn ? "#ffff00" : "#ffffff";
    mapCtx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
    mapCtx.fillStyle = flashOn ? "#000000" : "#ff0000";
    mapCtx.fillRect(px + 4, py + 4, cell - 8, cell - 8);
  }
}

function updateUiIndicators(): void {
  const phase = game.getPhase();
  // The loading image only fills the top 168 px of the display; the layout crops accordingly
  monitorFrame.classList.toggle("intro", phase === "LOADING");

  const hidePads = !areActionPadsVisible();
  if (hidePads !== touchControls.classList.contains("pads-hidden")) {
    touchControls.classList.toggle("pads-hidden", hidePads);
    if (hidePads) {
      clearTouchPadState();
    }
  }

  const showInitials = areInitialsControlsVisible();
  if (showInitials === initialsControls.classList.contains("hidden")) {
    initialsControls.classList.toggle("hidden", !showInitials);
    if (!showInitials) {
      stopInitialStepperRepeat();
    }
  }
  if (showInitials) {
    btnInitDel.disabled = !game.canBackspaceInitial();
  }

  const pausable = isPausablePhase();
  btnOptions.hidden = !pausable;
  if (!pausable && document.body.classList.contains("options-open")) {
    setOptionsOpen(false);
  }
  const pausedInGame = pausable && game.input.isPaused();
  btnPause.disabled = !pausable;
  btnPause.classList.toggle("active", pausedInGame);
  btnPauseLabel.textContent = pausedInGame ? "RESUME" : "PAUSE";

  if (pausedInGame) {
    statusPill.textContent = "PAUSED — PRESS ANY KEY TO RESUME";
    statusPill.classList.remove("hidden");
  } else {
    statusPill.classList.add("hidden");
  }

  if (isMapVisible()) {
    renderExplorerMap();
  }
}

const mobilePortraitQuery = window.matchMedia(
  "(pointer: coarse) and (orientation: portrait)",
);
let pausedByPortraitLock = false;

function syncPortraitLockPause(): void {
  if (mobilePortraitQuery.matches) {
    if (!pausedByPortraitLock) {
      pausedByPortraitLock = true;
      clearTouchPadState();
      game.beeper.setPaused(true);
    }
  } else if (pausedByPortraitLock) {
    pausedByPortraitLock = false;
    if (
      !document.body.classList.contains("options-open") &&
      !game.input.isPaused()
    ) {
      game.beeper.setPaused(false);
    }
  }
}
mobilePortraitQuery.addEventListener?.("change", syncPortraitLockPause);

// Fixed 50 Hz ZX Spectrum ULA frame loop (20 ms per interrupt)
const ZX_FRAME_MS = 1000 / 50;
let lastTime = performance.now();
let accumulator = 0;

function frameLoop(now: number): void {
  const dt = Math.min(100, now - lastTime);
  lastTime = now;
  syncPortraitLockPause();
  if (document.hidden || pausedByPortraitLock) {
    accumulator = 0;
    requestAnimationFrame(frameLoop);
    return;
  }
  accumulator += dt;

  resyncJoystick();
  while (accumulator >= ZX_FRAME_MS) {
    game.stepFrame();
    accumulator -= ZX_FRAME_MS;
  }

  updateUiIndicators();
  requestAnimationFrame(frameLoop);
}

requestAnimationFrame(frameLoop);

// PWA offline support (production builds)
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      const ready = await navigator.serviceWorker.ready;
      const urls = performance.getEntriesByType("resource").map((r) => r.name);
      (ready.active || reg.active)?.postMessage({ type: "CACHE_URLS", urls });
    } catch {
      // Service workers unavailable (e.g. non-HTTPS LAN dev) — game still runs normally.
    }
  });
}
