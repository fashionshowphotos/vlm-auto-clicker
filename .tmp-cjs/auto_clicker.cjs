var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var auto_clicker_exports = {};
__export(auto_clicker_exports, {
  AutoClicker: () => AutoClicker,
  STATES: () => STATES,
  autoClicker: () => autoClicker,
  default: () => auto_clicker_default
});
module.exports = __toCommonJS(auto_clicker_exports);
var import_loop_utils = require("./loop_utils.js");
var import_event_bus = require("./event_bus.js");
var import_screen_watcher = require("./screen_watcher.js");
var import_ocr_detector = require("./ocr_detector.js");
var import_vlm_teacher = require("./vlm_teacher.js");
var import_button_profile_store = require("./button_profile_store.js");
var import_fs = __toESM(require("fs"), 1);
var import_path = __toESM(require("path"), 1);
var import_url = require("url");
const import_meta = {};
const __filename = (0, import_url.fileURLToPath)(import_meta.url);
const __dirname = import_path.default.dirname(__filename);
const STATES = {
  DISABLED: "disabled",
  LEARNING: "learning",
  WATCHING: "watching",
  DETECTED: "detected",
  CLICKING: "clicking",
  COOLDOWN: "cooldown"
};
const DEFAULT_CONFIG = {
  enabled: false,
  ide: "vscode",
  pollIntervalMs: 1500,
  confirmationDelayMs: 500,
  cooldownMs: 2e3,
  vlm: {
    model: "gpt-4o-mini",
    apiKey: null,
    maxCallsPerDay: 10,
    maxCallsPerSession: 5
  },
  debug: {
    dryRun: false,
    saveScreenshots: false,
    logOcrResults: false
  }
};
class AutoClicker {
  constructor() {
    this.state = STATES.DISABLED;
    this.config = { ...DEFAULT_CONFIG };
    this.pollHandle = null;
    this.session = {
      startedAt: null,
      clicksExecuted: 0,
      vlmCallsMade: 0,
      ocrScansRun: 0,
      falsePositives: 0,
      lastDetection: null,
      lastClick: null,
      consecutiveLowConfidence: 0
    };
  }
  // ─── Public API ──────────────────────────────────────────────────────────────
  configure(opts = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...opts,
      vlm: { ...DEFAULT_CONFIG.vlm, ...opts.vlm || {} },
      debug: { ...DEFAULT_CONFIG.debug, ...opts.debug || {} }
    };
    import_vlm_teacher.vlmTeacher.configure({
      model: this.config.vlm.model,
      apiKey: this.config.vlm.apiKey,
      apiUrl: this.config.vlm.apiUrl,
      maxCallsPerDay: this.config.vlm.maxCallsPerDay,
      maxCallsPerSession: this.config.vlm.maxCallsPerSession
    });
    console.log(`[AutoClicker] Configured: ide=${this.config.ide}, poll=${this.config.pollIntervalMs}ms, dryRun=${this.config.debug.dryRun}`);
  }
  async start() {
    if (this.state !== STATES.DISABLED) {
      console.log(`[AutoClicker] Already running (state=${this.state})`);
      return;
    }
    console.log("[AutoClicker] Starting...");
    this.session.startedAt = Date.now();
    await import_ocr_detector.ocrDetector.initialize();
    const ide = this.config.ide;
    if (import_button_profile_store.buttonProfileStore.hasProfile(ide)) {
      console.log(`[AutoClicker] Profile found for ${ide}. Entering WATCHING.`);
      this._transition(STATES.WATCHING);
    } else {
      console.log(`[AutoClicker] No profile for ${ide}. Entering LEARNING.`);
      this._transition(STATES.LEARNING);
      await this._learn();
    }
    this.pollHandle = (0, import_loop_utils.selfSchedulingLoop)(
      () => this._pollCycle(),
      this.config.pollIntervalMs,
      { name: "auto_clicker", autoStart: true, runImmediately: false }
    );
  }
  async stop() {
    if (this.state === STATES.DISABLED) return;
    console.log("[AutoClicker] Stopping...");
    if (this.pollHandle) {
      this.pollHandle.stop();
      this.pollHandle = null;
    }
    this._transition(STATES.DISABLED);
    console.log(`[AutoClicker] Stopped. Session: ${this.session.clicksExecuted} clicks, ${this.session.vlmCallsMade} VLM calls, ${this.session.ocrScansRun} OCR scans`);
  }
  async forceLearn() {
    if (this.state === STATES.DISABLED) {
      console.log("[AutoClicker] Cannot learn while disabled");
      return;
    }
    console.log("[AutoClicker] Force re-learn triggered");
    this._transition(STATES.LEARNING);
    await this._learn();
  }
  getStatus() {
    return {
      state: this.state,
      ide: this.config.ide,
      hasProfile: import_button_profile_store.buttonProfileStore.hasProfile(this.config.ide),
      session: { ...this.session },
      vlmStats: import_vlm_teacher.vlmTeacher.getStats(),
      config: {
        pollIntervalMs: this.config.pollIntervalMs,
        dryRun: this.config.debug.dryRun,
        vlmModel: this.config.vlm.model
      }
    };
  }
  // ─── State Transitions ───────────────────────────────────────────────────────
  _transition(newState) {
    const old = this.state;
    this.state = newState;
    const ts = (/* @__PURE__ */ new Date()).toLocaleTimeString();
    console.log(`[AutoClicker] [${ts}] ${old} \u2192 ${newState}`);
    import_event_bus.eventBus.publish(import_event_bus.EVENT_TYPES.AUTO_CLICK_STATE || "auto_click_state", {
      module: "auto_clicker",
      from: old,
      to: newState
    });
  }
  // ─── Learning (VLM Teacher) ──────────────────────────────────────────────────
  async _learn() {
    const ide = this.config.ide;
    console.log(`[AutoClicker] Learning: capturing screenshot for ${ide}...`);
    try {
      const screenshot = await import_screen_watcher.screenWatcher.capture();
      this.session.vlmCallsMade++;
      if (this.config.debug.saveScreenshots) {
        const debugDir = import_path.default.join(__dirname, "..", "firejumper_state", "debug");
        if (!import_fs.default.existsSync(debugDir)) import_fs.default.mkdirSync(debugDir, { recursive: true });
        import_fs.default.writeFileSync(import_path.default.join(debugDir, `learn_${Date.now()}.png`), screenshot);
      }
      const prevProfile = import_button_profile_store.buttonProfileStore.getProfile(ide);
      let result;
      if (prevProfile && prevProfile.buttons && prevProfile.buttons.length > 0) {
        result = await import_vlm_teacher.vlmTeacher.relearn(screenshot, ide, prevProfile);
      } else {
        result = await import_vlm_teacher.vlmTeacher.learn(screenshot, ide);
      }
      import_event_bus.eventBus.publish(import_event_bus.EVENT_TYPES.AUTO_CLICK_LEARN || "auto_click_learn", {
        ide,
        success: result.success,
        buttonsFound: result.buttons?.length || 0
      });
      if (result.success && result.buttons && result.buttons.length > 0) {
        const profile = import_button_profile_store.buttonProfileStore.updateFromVlm(ide, result);
        console.log(`[AutoClicker] Learned ${profile.buttons.length} button(s) for ${ide}`);
        this._transition(STATES.WATCHING);
      } else if (result.success && result.noButtonsFound) {
        console.log(`[AutoClicker] No accept buttons visible right now. Will watch with default patterns.`);
        import_button_profile_store.buttonProfileStore.setProfile(ide, {
          ide,
          learnedAt: Date.now(),
          learnCount: 1,
          lastSuccessfulClick: null,
          buttons: [{
            label: "Run",
            labelVariants: ["Accept", "Accept All", "Apply", "Apply All", "Accept Changes", "Accept Block", "Run", "Run All", "Confirm", "Checkout"],
            region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            colorHint: { bgColor: "#0078d4", textColor: "#ffffff" },
            context: "bottom-right area of IDE, action buttons",
            ocrSearchRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
          }],
          confidence: { ocrThreshold: 0.5, relearnThreshold: 0.25, consecutiveFailsForRelearn: 15 }
        });
        this._transition(STATES.WATCHING);
      } else {
        console.log(`[AutoClicker] Learning failed: ${result.error || "unknown"}`);
        import_button_profile_store.buttonProfileStore.setProfile(ide, {
          ide,
          learnedAt: Date.now(),
          learnCount: 0,
          lastSuccessfulClick: null,
          buttons: [{
            label: "Run",
            labelVariants: ["Accept", "Accept All", "Apply", "Apply All", "Accept Changes", "Run", "Run All", "Confirm", "Checkout"],
            region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            colorHint: { bgColor: "#0078d4", textColor: "#ffffff" },
            context: "bottom-right area of IDE",
            ocrSearchRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
          }],
          confidence: { ocrThreshold: 0.5, relearnThreshold: 0.25, consecutiveFailsForRelearn: 15 }
        });
        this._transition(STATES.WATCHING);
      }
    } catch (err) {
      console.error(`[AutoClicker] Learning error: ${err.message}`);
      this._transition(STATES.WATCHING);
    }
  }
  // ─── Poll Cycle (the main detection loop) ────────────────────────────────────
  async _pollCycle() {
    if (this.state !== STATES.WATCHING) return;
    if (import_screen_watcher.screenWatcher.isUserActive()) return;
    const ide = this.config.ide;
    const profile = import_button_profile_store.buttonProfileStore.getProfile(ide);
    if (!profile || !profile.buttons || !profile.buttons.length) return;
    try {
      const screenshot = await import_screen_watcher.screenWatcher.capture();
      for (const button of profile.buttons) {
        const cropRegion = button.ocrSearchRegion || { x: 0, y: 0, width: 1, height: 0.25 };
        const cropped = await import_screen_watcher.screenWatcher.crop(screenshot, cropRegion);
        if (!cropped) continue;
        const colorPass = await import_screen_watcher.screenWatcher.colorPreFilter(cropped, button.colorHint);
        if (!colorPass) continue;
        this.session.ocrScansRun++;
        const detection = await import_ocr_detector.ocrDetector.detect(
          cropped,
          profile,
          import_screen_watcher.screenWatcher.screenWidth,
          import_screen_watcher.screenWatcher.screenHeight,
          cropRegion
        );
        if (this.config.debug.logOcrResults) {
          console.log(`[AutoClicker] OCR: ${detection.label || "none"} conf=${detection.confidence} words=${detection.details?.allWords?.map((w) => w.text).join(",")}`);
        }
        const threshold = profile.confidence?.ocrThreshold || 0.7;
        const relearnThreshold = profile.confidence?.relearnThreshold || 0.4;
        const maxFails = profile.confidence?.consecutiveFailsForRelearn || 5;
        if (detection.found && detection.confidence >= threshold) {
          this.session.consecutiveLowConfidence = 0;
          this.session.lastDetection = {
            timestamp: Date.now(),
            label: detection.label,
            confidence: detection.confidence,
            screenX: detection.screenX,
            screenY: detection.screenY
          };
          console.log(`[AutoClicker] DETECTED: "${detection.label}" at (${detection.screenX}, ${detection.screenY}) conf=${detection.confidence}`);
          import_event_bus.eventBus.publish(import_event_bus.EVENT_TYPES.AUTO_CLICK_DETECTED || "auto_click_detected", {
            label: detection.label,
            confidence: detection.confidence,
            x: detection.screenX,
            y: detection.screenY
          });
          this._transition(STATES.DETECTED);
          await (0, import_loop_utils.delay)(this.config.confirmationDelayMs);
          const confirmShot = await import_screen_watcher.screenWatcher.capture();
          const confirmCrop = await import_screen_watcher.screenWatcher.crop(confirmShot, cropRegion);
          if (confirmCrop) {
            const confirm = await import_ocr_detector.ocrDetector.detect(
              confirmCrop,
              profile,
              import_screen_watcher.screenWatcher.screenWidth,
              import_screen_watcher.screenWatcher.screenHeight,
              cropRegion
            );
            if (confirm.found && confirm.confidence >= threshold * 0.8) {
              await this._executeClick(detection.screenX, detection.screenY, detection.label);
              return;
            } else {
              console.log("[AutoClicker] Button disappeared during confirmation. Resuming watch.");
              this.session.falsePositives++;
              this._transition(STATES.WATCHING);
            }
          } else {
            this._transition(STATES.WATCHING);
          }
        } else if (detection.confidence < relearnThreshold && detection.details?.reason !== "no_words") {
          this.session.consecutiveLowConfidence++;
          if (this.session.consecutiveLowConfidence >= maxFails) {
            console.log(`[AutoClicker] ${maxFails} consecutive low-confidence cycles. Triggering re-learn.`);
            import_event_bus.eventBus.publish(import_event_bus.EVENT_TYPES.AUTO_CLICK_CONFIDENCE_DROP || "auto_click_confidence_drop", {
              consecutive: this.session.consecutiveLowConfidence
            });
            this.session.consecutiveLowConfidence = 0;
            this._transition(STATES.LEARNING);
            await this._learn();
            return;
          }
        }
      }
    } catch (err) {
      console.error(`[AutoClicker] Poll error: ${err.message}`);
    }
  }
  // ─── Click Execution ─────────────────────────────────────────────────────────
  async _executeClick(x, y, label) {
    this._transition(STATES.CLICKING);
    if (this.config.debug.dryRun) {
      console.log(`[AutoClicker] DRY RUN: Would click "${label}" at (${x}, ${y})`);
      import_event_bus.eventBus.publish(import_event_bus.EVENT_TYPES.AUTO_CLICK_EXECUTED || "auto_click_executed", {
        label,
        x,
        y,
        dryRun: true
      });
    } else {
      try {
        const result = await import_screen_watcher.screenWatcher.click(x, y);
        console.log(`[AutoClicker] CLICKED "${label}" at (${result.x}, ${result.y})`);
        import_event_bus.eventBus.publish(import_event_bus.EVENT_TYPES.AUTO_CLICK_EXECUTED || "auto_click_executed", {
          label,
          x: result.x,
          y: result.y,
          dryRun: false
        });
        import_button_profile_store.buttonProfileStore.recordClick(this.config.ide);
      } catch (err) {
        console.error(`[AutoClicker] Click failed: ${err.message}`);
        this._transition(STATES.WATCHING);
        return;
      }
    }
    this.session.clicksExecuted++;
    this.session.lastClick = { timestamp: Date.now(), label, x, y };
    this._transition(STATES.COOLDOWN);
    await (0, import_loop_utils.delay)(this.config.cooldownMs);
    this._transition(STATES.WATCHING);
  }
}
const autoClicker = new AutoClicker();
var auto_clicker_default = autoClicker;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AutoClicker,
  STATES,
  autoClicker
});
