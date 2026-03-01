/**
 * Auto-Clicker — VLM-powered accept button clicker for IDE AI assistants
 *
 * Teacher-student architecture:
 *   - VLM (cloud) = teacher — called rarely, only to learn/re-learn button appearance
 *   - OCR (local) = student — runs every poll cycle, free, fast
 *
 * State machine:
 *   DISABLED → LEARNING → WATCHING → DETECTED → CLICKING → COOLDOWN → WATCHING
 *
 * Uses selfSchedulingLoop from loop_utils.js as the poll driver (prevents async overlap).
 * Publishes events to EventBus for logging and monitoring.
 */

import { selfSchedulingLoop, delay } from './loop_utils.js';
import { eventBus, EVENT_TYPES } from './event_bus.js';
import { screenWatcher } from './screen_watcher.js';
import { ocrDetector } from './ocr_detector.js';
import { vlmTeacher } from './vlm_teacher.js';
import { buttonProfileStore } from './button_profile_store.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── States ────────────────────────────────────────────────────────────────────

const STATES = {
  DISABLED: 'disabled',
  LEARNING: 'learning',
  WATCHING: 'watching',
  DETECTED: 'detected',
  CLICKING: 'clicking',
  COOLDOWN: 'cooldown'
};

// ─── Default Config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  enabled: false,
  ide: 'vscode',
  pollIntervalMs: 1500,
  confirmationDelayMs: 500,
  cooldownMs: 2000,
  vlm: {
    model: 'gpt-4o-mini',
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

// ─── Auto-Clicker Class ───────────────────────────────────────────────────────

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
      vlm: { ...DEFAULT_CONFIG.vlm, ...(opts.vlm || {}) },
      debug: { ...DEFAULT_CONFIG.debug, ...(opts.debug || {}) }
    };

    // Configure VLM teacher
    vlmTeacher.configure({
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

    console.log('[AutoClicker] Starting...');
    this.session.startedAt = Date.now();

    // Initialize OCR worker
    await ocrDetector.initialize();

    // Check if we have a learned profile for this IDE
    const ide = this.config.ide;
    if (buttonProfileStore.hasProfile(ide)) {
      console.log(`[AutoClicker] Profile found for ${ide}. Entering WATCHING.`);
      this._transition(STATES.WATCHING);
    } else {
      console.log(`[AutoClicker] No profile for ${ide}. Entering LEARNING.`);
      this._transition(STATES.LEARNING);
      await this._learn();
    }

    // Start the poll loop (only runs in WATCHING state)
    this.pollHandle = selfSchedulingLoop(
      () => this._pollCycle(),
      this.config.pollIntervalMs,
      { name: 'auto_clicker', autoStart: true, runImmediately: false }
    );
  }

  async stop() {
    if (this.state === STATES.DISABLED) return;

    console.log('[AutoClicker] Stopping...');
    if (this.pollHandle) {
      this.pollHandle.stop();
      this.pollHandle = null;
    }
    this._transition(STATES.DISABLED);
    console.log(`[AutoClicker] Stopped. Session: ${this.session.clicksExecuted} clicks, ${this.session.vlmCallsMade} VLM calls, ${this.session.ocrScansRun} OCR scans`);
  }

  async forceLearn() {
    if (this.state === STATES.DISABLED) {
      console.log('[AutoClicker] Cannot learn while disabled');
      return;
    }
    console.log('[AutoClicker] Force re-learn triggered');
    this._transition(STATES.LEARNING);
    await this._learn();
  }

  getStatus() {
    return {
      state: this.state,
      ide: this.config.ide,
      hasProfile: buttonProfileStore.hasProfile(this.config.ide),
      session: { ...this.session },
      vlmStats: vlmTeacher.getStats(),
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
    const ts = new Date().toLocaleTimeString();
    console.log(`[AutoClicker] [${ts}] ${old} → ${newState}`);
    eventBus.publish(EVENT_TYPES.AUTO_CLICK_STATE || 'auto_click_state', {
      module: 'auto_clicker', from: old, to: newState
    });
  }

  // ─── Learning (VLM Teacher) ──────────────────────────────────────────────────

  async _learn() {
    const ide = this.config.ide;
    console.log(`[AutoClicker] Learning: capturing screenshot for ${ide}...`);

    try {
      const fullScreenshot = await screenWatcher.capture();
      this.session.vlmCallsMade++;

      if (this.config.debug.saveScreenshots) {
        const debugDir = path.join(__dirname, '..', 'firejumper_state', 'debug');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, `learn_${Date.now()}.png`), fullScreenshot);
      }

      // Fix 6: Privacy — crop screenshot before sending to cloud VLM
      // Default crop: bottom-right ~70% x 60% where IDE action buttons typically appear
      const DEFAULT_PRIVACY_CROP = { x: 0.3, y: 0.4, width: 0.7, height: 0.6 };

      // One-time consent notice before first VLM call
      if (!buttonProfileStore.hasConsent()) {
        console.log('[AutoClicker] *** PRIVACY NOTICE ***');
        console.log('[AutoClicker] A cropped screenshot of your IDE will be sent to the configured VLM API');
        console.log(`[AutoClicker] for learning button locations. API: ${this.config.vlm.apiUrl || 'default'}`);
        console.log('[AutoClicker] This happens rarely (first run + occasional re-learns).');
        buttonProfileStore.setConsent(true);
      }

      // Check if we have a previous profile (re-learn vs first learn)
      const prevProfile = buttonProfileStore.getProfile(ide);
      let result;
      let privacyCrop = DEFAULT_PRIVACY_CROP;

      if (prevProfile && prevProfile.buttons && prevProfile.buttons.length > 0) {
        // Use expanded region from previous profile for re-learn crop
        const btn = prevProfile.buttons[0];
        privacyCrop = {
          x: Math.max(0, (btn.ocrSearchRegion?.x || 0.3) - 0.1),
          y: Math.max(0, (btn.ocrSearchRegion?.y || 0.4) - 0.1),
          width: Math.min(1, (btn.ocrSearchRegion?.width || 0.5) + 0.2),
          height: Math.min(1, (btn.ocrSearchRegion?.height || 0.5) + 0.2)
        };
        const croppedForVlm = await screenWatcher.crop(fullScreenshot, privacyCrop) || fullScreenshot;
        result = await vlmTeacher.relearn(croppedForVlm, ide, prevProfile);
      } else {
        const croppedForVlm = await screenWatcher.crop(fullScreenshot, privacyCrop) || fullScreenshot;
        result = await vlmTeacher.learn(croppedForVlm, ide);
      }

      // Adjust VLM-reported coordinates for the privacy crop offset
      if (result.buttons && result.buttons.length > 0) {
        const cropX = privacyCrop.x * screenWatcher.screenWidth;
        const cropY = privacyCrop.y * screenWatcher.screenHeight;
        for (const btn of result.buttons) {
          if (typeof btn.x === 'number') btn.x += cropX;
          if (typeof btn.y === 'number') btn.y += cropY;
        }
        result.screenWidth = screenWatcher.screenWidth;
        result.screenHeight = screenWatcher.screenHeight;
      }

      eventBus.publish(EVENT_TYPES.AUTO_CLICK_LEARN || 'auto_click_learn', {
        ide, success: result.success, buttonsFound: result.buttons?.length || 0
      });

      if (result.success && result.buttons && result.buttons.length > 0) {
        const profile = buttonProfileStore.updateFromVlm(ide, result);
        console.log(`[AutoClicker] Learned ${profile.buttons.length} button(s) for ${ide}`);
        this._transition(STATES.WATCHING);
      } else if (result.success && result.noButtonsFound) {
        console.log(`[AutoClicker] No accept buttons visible right now. Will watch with default patterns.`);
        // Create a default profile with common button patterns
        buttonProfileStore.setProfile(ide, {
          ide,
          learnedAt: Date.now(),
          learnCount: 1,
          lastSuccessfulClick: null,
          buttons: [{
            label: 'Run',
            labelVariants: ['Accept', 'Accept All', 'Apply', 'Apply All', 'Accept Changes', 'Accept Block', 'Run', 'Run All', 'Confirm', 'Checkout'],
            region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            colorHint: { bgColor: '#0078d4', textColor: '#ffffff' },
            context: 'bottom-right area of IDE, action buttons',
            ocrSearchRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
          }],
          confidence: { ocrThreshold: 0.70, relearnThreshold: 0.40, consecutiveFailsForRelearn: 5 }
        });
        this._transition(STATES.WATCHING);
      } else {
        console.log(`[AutoClicker] Learning failed: ${result.error || 'unknown'}`);
        // Fall back to default profile so we can still watch
        buttonProfileStore.setProfile(ide, {
          ide,
          learnedAt: Date.now(),
          learnCount: 0,
          lastSuccessfulClick: null,
          buttons: [{
            label: 'Run',
            labelVariants: ['Accept', 'Accept All', 'Apply', 'Apply All', 'Accept Changes', 'Run', 'Run All', 'Confirm', 'Checkout'],
            region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            colorHint: { bgColor: '#0078d4', textColor: '#ffffff' },
            context: 'bottom-right area of IDE',
            ocrSearchRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
          }],
          confidence: { ocrThreshold: 0.70, relearnThreshold: 0.40, consecutiveFailsForRelearn: 5 }
        });
        this._transition(STATES.WATCHING);
      }
    } catch (err) {
      console.error(`[AutoClicker] Learning error: ${err.message}`);
      this._transition(STATES.WATCHING); // Still try to watch with whatever we have
    }
  }

  // ─── Poll Cycle (the main detection loop) ────────────────────────────────────

  async _pollCycle() {
    if (this.state !== STATES.WATCHING) return;

    // Skip if user is actively using mouse
    if (screenWatcher.isUserActive()) return;

    const ide = this.config.ide;
    const profile = buttonProfileStore.getProfile(ide);
    if (!profile || !profile.buttons || !profile.buttons.length) return;

    try {
      // 1. Capture screenshot
      const screenshot = await screenWatcher.capture();

      // 2. For each button in profile, try to detect it
      for (const button of profile.buttons) {
        const cropRegion = button.ocrSearchRegion || { x: 0, y: 0, width: 1, height: 0.25 };

        // 3. Crop to search region
        const cropped = await screenWatcher.crop(screenshot, cropRegion);
        if (!cropped) continue;

        // 4. Color pre-filter (skip OCR if button color not present)
        const colorPass = await screenWatcher.colorPreFilter(cropped, button.colorHint);
        if (!colorPass) continue;

        // 5. OCR detect
        this.session.ocrScansRun++;
        const detection = await ocrDetector.detect(
          cropped, profile,
          screenWatcher.screenWidth, screenWatcher.screenHeight,
          cropRegion
        );

        if (this.config.debug.logOcrResults) {
          console.log(`[AutoClicker] OCR: ${detection.label || 'none'} conf=${detection.confidence} words=${detection.details?.allWords?.map(w => w.text).join(',')}`);
        }

        // 6. Evaluate confidence
        const threshold = profile.confidence?.ocrThreshold || 0.70;
        const relearnThreshold = profile.confidence?.relearnThreshold || 0.40;
        const maxFails = profile.confidence?.consecutiveFailsForRelearn || 5;

        if (detection.found && detection.confidence >= threshold) {
          // HIGH CONFIDENCE — proceed to click
          this.session.consecutiveLowConfidence = 0;
          this.session.lastDetection = {
            timestamp: Date.now(),
            label: detection.label,
            confidence: detection.confidence,
            screenX: detection.screenX,
            screenY: detection.screenY
          };

          console.log(`[AutoClicker] DETECTED: "${detection.label}" at (${detection.screenX}, ${detection.screenY}) conf=${detection.confidence}`);
          eventBus.publish(EVENT_TYPES.AUTO_CLICK_DETECTED || 'auto_click_detected', {
            label: detection.label, confidence: detection.confidence,
            x: detection.screenX, y: detection.screenY
          });

          // Confirmation: wait, then re-check
          this._transition(STATES.DETECTED);
          await delay(this.config.confirmationDelayMs);

          // Re-scan to confirm button is still there
          const confirmShot = await screenWatcher.capture();
          const confirmCrop = await screenWatcher.crop(confirmShot, cropRegion);
          if (confirmCrop) {
            const confirm = await ocrDetector.detect(
              confirmCrop, profile,
              screenWatcher.screenWidth, screenWatcher.screenHeight,
              cropRegion
            );

            if (confirm.found && confirm.confidence >= threshold * 0.8) {
              // Still there — click it
              await this._executeClick(detection.screenX, detection.screenY, detection.label);
              return; // Exit poll cycle after click
            } else {
              // Button disappeared — false positive
              console.log('[AutoClicker] Button disappeared during confirmation. Resuming watch.');
              this.session.falsePositives++;
              this._transition(STATES.WATCHING);
            }
          } else {
            this._transition(STATES.WATCHING);
          }
        } else if (detection.confidence < relearnThreshold && detection.details?.reason !== 'no_words') {
          // LOW CONFIDENCE with some words visible — maybe time to re-learn
          // (Skip re-learn when OCR found nothing at all — that just means no button is on screen)
          this.session.consecutiveLowConfidence++;
          if (this.session.consecutiveLowConfidence >= maxFails) {
            console.log(`[AutoClicker] ${maxFails} consecutive low-confidence cycles. Triggering re-learn.`);
            eventBus.publish(EVENT_TYPES.AUTO_CLICK_CONFIDENCE_DROP || 'auto_click_confidence_drop', {
              consecutive: this.session.consecutiveLowConfidence
            });
            this.session.consecutiveLowConfidence = 0;
            this._transition(STATES.LEARNING);
            await this._learn();
            return;
          }
        }
        // MEDIUM CONFIDENCE (0.40-0.70) — ignore, keep watching
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
      eventBus.publish(EVENT_TYPES.AUTO_CLICK_EXECUTED || 'auto_click_executed', {
        label, x, y, dryRun: true
      });
    } else {
      try {
        const result = await screenWatcher.click(x, y);
        console.log(`[AutoClicker] CLICKED "${label}" at (${result.x}, ${result.y})`);
        eventBus.publish(EVENT_TYPES.AUTO_CLICK_EXECUTED || 'auto_click_executed', {
          label, x: result.x, y: result.y, dryRun: false
        });
        buttonProfileStore.recordClick(this.config.ide);
      } catch (err) {
        console.error(`[AutoClicker] Click failed: ${err.message}`);
        this._transition(STATES.WATCHING);
        return;
      }
    }

    this.session.clicksExecuted++;
    this.session.lastClick = { timestamp: Date.now(), label, x, y };

    // Cooldown
    this._transition(STATES.COOLDOWN);
    await delay(this.config.cooldownMs);
    this._transition(STATES.WATCHING);
  }
}

export const autoClicker = new AutoClicker();
export { AutoClicker, STATES };
export default autoClicker;
