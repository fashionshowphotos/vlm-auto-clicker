/**
 * Button Profile Store — Learned button profile persistence
 *
 * Stores per-IDE profiles of what the "Accept" button looks like.
 * VLM teaches once, local OCR uses forever.
 *
 * Security:
 *   - HMAC-SHA256 integrity on saved profiles (Fix 4)
 *   - Label allowlist / blocklist for VLM responses (Fix 3)
 *   - Minimum threshold enforcement on load (Fix 1)
 *
 * Profile data:
 *   - label variants ("Accept", "Apply", "Accept All")
 *   - screen region (fractional 0-1 coordinates)
 *   - color hints (HSL ranges)
 *   - OCR search region (narrowed area for fast detection)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILES_DIR = path.join(__dirname, '..', 'firejumper_state');
const PROFILES_FILE = path.join(PROFILES_DIR, 'button_profiles.json');
const PROFILE_VERSION = 1;

// ─── Fix 3: Label Safety ────────────────────────────────────────────────────────

const SAFE_LABELS = new Set([
  'accept', 'accept all', 'apply', 'apply all', 'accept changes',
  'accept block', 'run', 'run all', 'confirm', 'checkout',
  'ok', 'yes', 'continue', 'proceed', 'save', 'keep',
  'merge', 'allow', 'approve', 'insert', 'add'
]);

const DANGEROUS_LABELS = [
  'delete', 'remove', 'erase', 'format', 'drop', 'destroy',
  'uninstall', 'reset', 'clear', 'purge', 'wipe', 'cancel',
  'reject', 'deny', 'discard', 'revert', 'undo'
];

function isLabelSafe(label) {
  const lower = label.toLowerCase().trim();
  // Block if it contains any dangerous keyword
  for (const d of DANGEROUS_LABELS) {
    if (lower.includes(d)) return false;
  }
  // Allow if it contains or matches any safe keyword
  for (const s of SAFE_LABELS) {
    if (lower.includes(s) || s.includes(lower)) return true;
  }
  return false;
}

function clampFractional(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

// ─── Fix 4: HMAC Integrity ──────────────────────────────────────────────────────

function deriveHmacKey() {
  const material = `${os.hostname()}:${os.userInfo().username}:vlm-auto-clicker-integrity`;
  return crypto.createHash('sha256').update(material).digest();
}

function computeHmac(jsonPayload, key) {
  return crypto.createHmac('sha256', key).update(jsonPayload).digest('hex');
}

const HMAC_KEY = deriveHmacKey();

// ─── Fix 1: Minimum Thresholds ──────────────────────────────────────────────────

function enforceMinThresholds(store) {
  for (const ide of Object.keys(store.profiles || {})) {
    const p = store.profiles[ide];
    if (p.confidence) {
      if (p.confidence.ocrThreshold < 0.60) p.confidence.ocrThreshold = 0.70;
      if (p.confidence.relearnThreshold < 0.30) p.confidence.relearnThreshold = 0.40;
      if (p.confidence.consecutiveFailsForRelearn > 10) p.confidence.consecutiveFailsForRelearn = 5;
    }
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────────

function emptyStore() {
  return { version: PROFILE_VERSION, profiles: {} };
}

function defaultProfile(ide) {
  return {
    ide,
    learnedAt: null,
    learnCount: 0,
    lastSuccessfulClick: null,
    buttons: [],
    confidence: {
      ocrThreshold: 0.70,
      relearnThreshold: 0.40,
      consecutiveFailsForRelearn: 5
    }
  };
}

class ButtonProfileStore {
  constructor() {
    this.store = emptyStore();
    this.dirty = false;
  }

  load() {
    try {
      if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
      }
      if (fs.existsSync(PROFILES_FILE)) {
        const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
        const envelope = JSON.parse(raw);

        if (envelope.signature && envelope.payload) {
          // Signed format — verify HMAC
          const expectedSig = computeHmac(envelope.payload, HMAC_KEY);
          if (envelope.signature !== expectedSig) {
            console.log('[ProfileStore] HMAC verification failed — profiles may have been tampered with. Starting fresh.');
            this.store = emptyStore();
            return this;
          }
          const data = JSON.parse(envelope.payload);
          if (data.version === PROFILE_VERSION) {
            this.store = data;
          } else {
            console.log('[ProfileStore] Version mismatch, starting fresh');
            this.store = emptyStore();
          }
        } else if (envelope.version === PROFILE_VERSION && envelope.profiles) {
          // Legacy unsigned format — accept but will re-sign on next save
          console.log('[ProfileStore] Migrating unsigned profile to signed format');
          this.store = envelope;
        } else {
          console.log('[ProfileStore] Unrecognized format, starting fresh');
          this.store = emptyStore();
        }
      }
    } catch (err) {
      console.error(`[ProfileStore] Load error: ${err.message}`);
      this.store = emptyStore();
    }

    // Fix 1: enforce minimum thresholds on loaded profiles
    enforceMinThresholds(this.store);

    return this;
  }

  save() {
    try {
      if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
      }
      const payload = JSON.stringify(this.store, null, 2);
      const signature = computeHmac(payload, HMAC_KEY);
      const envelope = JSON.stringify({ version: PROFILE_VERSION, signature, payload }, null, 2);
      const tmp = PROFILES_FILE + '.tmp';
      fs.writeFileSync(tmp, envelope);
      fs.renameSync(tmp, PROFILES_FILE);
      this.dirty = false;
    } catch (err) {
      console.error(`[ProfileStore] Save error: ${err.message}`);
    }
  }

  getProfile(ide) {
    return this.store.profiles[ide] || null;
  }

  hasProfile(ide) {
    const p = this.store.profiles[ide];
    return p && p.buttons && p.buttons.length > 0;
  }

  setProfile(ide, profile) {
    this.store.profiles[ide] = profile;
    this.dirty = true;
    this.save();
  }

  // Fix 3: validate VLM response before storing
  updateFromVlm(ide, vlmResult) {
    let profile = this.store.profiles[ide] || defaultProfile(ide);

    profile.learnedAt = Date.now();
    profile.learnCount = (profile.learnCount || 0) + 1;

    if (vlmResult.buttons && vlmResult.buttons.length > 0) {
      const screenW = vlmResult.screenWidth || 1920;
      const screenH = vlmResult.screenHeight || 1080;

      profile.buttons = vlmResult.buttons
        .map(b => {
          // Filter labelVariants against safety allowlist
          const rawVariants = b.labelVariants || [b.label];
          const safeVariants = rawVariants.filter(v => isLabelSafe(v));

          if (safeVariants.length === 0) {
            console.log(`[ProfileStore] Skipping button "${b.label}" — no safe label variants`);
            return null;
          }

          return {
            label: isLabelSafe(b.label) ? b.label : safeVariants[0],
            labelVariants: safeVariants,
            region: {
              x: clampFractional(b.x / screenW),
              y: clampFractional(b.y / screenH),
              width: clampFractional(b.width / screenW),
              height: clampFractional(b.height / screenH)
            },
            colorHint: {
              bgColor: b.bgColor || null,
              textColor: b.textColor || null
            },
            context: typeof b.context === 'string' ? b.context.slice(0, 200) : '',
            ocrSearchRegion: {
              x: clampFractional(Math.max(0, (b.x - b.width * 2) / screenW)),
              y: clampFractional(Math.max(0, (b.y - b.height * 2) / screenH)),
              width: clampFractional((b.width * 5) / screenW),
              height: clampFractional((b.height * 5) / screenH)
            }
          };
        })
        .filter(Boolean);

      // If all buttons were filtered out, reject VLM result
      if (profile.buttons.length === 0) {
        console.log('[ProfileStore] VLM result rejected: no buttons with safe labels');
        return this.store.profiles[ide] || defaultProfile(ide);
      }
    }

    this.store.profiles[ide] = profile;
    this.dirty = true;
    this.save();
    return profile;
  }

  recordClick(ide) {
    const profile = this.store.profiles[ide];
    if (profile) {
      profile.lastSuccessfulClick = Date.now();
      this.dirty = true;
      this.save();
    }
  }

  deleteProfile(ide) {
    delete this.store.profiles[ide];
    this.dirty = true;
    this.save();
  }

  listProfiles() {
    return Object.keys(this.store.profiles);
  }

  // Fix 6: consent tracking for VLM screenshot sends
  hasConsent() {
    return this.store._vlmConsentGiven === true;
  }

  setConsent(value) {
    this.store._vlmConsentGiven = !!value;
    this.save();
  }
}

export const buttonProfileStore = new ButtonProfileStore().load();
export { ButtonProfileStore, isLabelSafe, clampFractional, SAFE_LABELS, DANGEROUS_LABELS };
export default buttonProfileStore;
