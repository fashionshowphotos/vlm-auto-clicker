/**
 * OCR Detector — Tesseract.js OCR + heuristic button finder + confidence scoring
 *
 * The "student" in the teacher-student pattern.
 * Runs locally, free, fast. Detects accept/apply buttons by:
 *   1. OCR text extraction on a small screen region
 *   2. Fuzzy matching against learned label variants
 *   3. Weighted confidence score (text + OCR confidence + position + size)
 *
 * Thresholds:
 *   >= 0.70 → click (high confidence)
 *   0.40-0.70 → ignore (log, increment low-confidence counter)
 *   < 0.40 for N consecutive cycles → trigger VLM re-learn
 */

import Tesseract from 'tesseract.js';
import sharp from 'sharp';

class OcrDetector {
  constructor() {
    this.worker = null;
    this.ready = false;
    this._initializing = false;
  }

  async initialize() {
    if (this.ready || this._initializing) return;
    this._initializing = true;

    try {
      this.worker = await Tesseract.createWorker('eng');
      this.ready = true;
      console.log('[OcrDetector] Tesseract worker ready');
    } catch (err) {
      console.error(`[OcrDetector] Init failed: ${err.message}`);
      this._initializing = false;
      throw err;
    }
  }

  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }

  /**
   * Detect accept buttons in a cropped screenshot.
   *
   * @param {Buffer} imageBuffer - Cropped PNG of the expected button region
   * @param {Object} profile - Button profile with labelVariants, region, etc.
   * @param {number} screenWidth - Full screen width (for coordinate translation)
   * @param {number} screenHeight - Full screen height
   * @param {Object} cropRegion - The fractional region that was cropped {x, y, width, height}
   * @returns {{ found: boolean, confidence: number, label: string, screenX: number, screenY: number, details: Object }}
   */
  async detect(imageBuffer, profile, screenWidth, screenHeight, cropRegion) {
    if (!this.ready) await this.initialize();

    try {
      // Preprocess for Tesseract: dark themes need inversion, small text needs upscaling
      // 1. Remove alpha (negate would invert alpha → invisible)
      // 2. Negate (invert colors: light-on-dark → dark-on-light)
      // 3. Greyscale + normalise (stretch contrast to full 0-255 range)
      // 4. Resize 3x (small IDE text is often too tiny for Tesseract)
      // 5. Sharpen for crisp edges
      const meta = await sharp(imageBuffer).metadata();
      const processed = await sharp(imageBuffer)
        .removeAlpha()
        .negate()
        .greyscale()
        .resize(meta.width * 3, meta.height * 3, { kernel: 'lanczos3' })
        .normalise()
        .sharpen({ sigma: 1.5 })
        .toBuffer();

      // Tesseract.js v7: must request blocks output explicitly, then extract words
      const result = await this.worker.recognize(processed, {}, { blocks: true });
      const words = extractWords(result.data.blocks, 3); // scale=3 because we upscaled 3x

      if (!words.length) {
        return { found: false, confidence: 0, label: null, screenX: 0, screenY: 0, details: { reason: 'no_words' } };
      }

      // Collect all label variants from all buttons in the profile
      const allVariants = [];
      for (const btn of (profile.buttons || [])) {
        for (const v of (btn.labelVariants || [btn.label])) {
          allVariants.push(v);
        }
      }

      // Default variants if profile has none yet
      const variants = allVariants.length > 0
        ? allVariants
        : ['Accept', 'Accept All', 'Apply', 'Apply All', 'Accept Changes', 'Accept Block', 'Run', 'Run All', 'Confirm', 'Checkout'];

      // Build candidate list: individual words + consecutive pairs
      const candidates = [];

      for (const word of words) {
        const text = word.text.trim();
        if (text.length < 2) continue;
        const textScore = fuzzyMatch(text, variants);
        if (textScore >= 0.3) {
          candidates.push({ word, textScore });
        }
      }

      // Consecutive word pairs (e.g., "Accept" + "All")
      for (let i = 0; i < words.length - 1; i++) {
        const phrase = (words[i].text + ' ' + words[i + 1].text).trim();
        const textScore = fuzzyMatch(phrase, variants);
        if (textScore >= 0.3) {
          candidates.push({
            word: {
              text: phrase,
              confidence: (words[i].confidence + words[i + 1].confidence) / 2,
              bbox: {
                x0: words[i].bbox.x0,
                y0: Math.min(words[i].bbox.y0, words[i + 1].bbox.y0),
                x1: words[i + 1].bbox.x1,
                y1: Math.max(words[i].bbox.y1, words[i + 1].bbox.y1)
              }
            },
            textScore
          });
        }
      }

      if (!candidates.length) {
        return { found: false, confidence: 0, label: null, screenX: 0, screenY: 0, details: { reason: 'no_match', words: words.map(w => w.text) } };
      }

      // Score ALL candidates with full weighted confidence, then pick the best
      const textWeight = 0.30;
      const confWeight = 0.20;
      const posWeight = 0.25;   // Position matters most — prefer words at expected button location
      const sizeWeight = 0.10;
      const contextWeight = 0.15;

      let bestMatch = null;
      let bestConfidence = 0;

      for (const candidate of candidates) {
        const wordConf = (candidate.word.confidence || 0) / 100;

        // Position: how close is this word to the expected button location?
        let posScore = 0.5;
        if (profile.buttons?.[0]?.region) {
          const expected = profile.buttons[0].region;
          const wordCenterX = (candidate.word.bbox.x0 + candidate.word.bbox.x1) / 2;
          const wordCenterY = (candidate.word.bbox.y0 + candidate.word.bbox.y1) / 2;
          // Convert crop-relative pixel coords to screen fractional coords
          const cropPixelW = screenWidth * cropRegion.width;
          const cropPixelH = screenHeight * cropRegion.height;
          const detectedX = cropRegion.x + (wordCenterX / cropPixelW) * cropRegion.width;
          const detectedY = cropRegion.y + (wordCenterY / cropPixelH) * cropRegion.height;
          const dx = Math.abs(detectedX - (expected.x + expected.width / 2));
          const dy = Math.abs(detectedY - (expected.y + expected.height / 2));
          posScore = Math.max(0, 1 - (dx + dy) * 5);
        }

        let sizeScore = 0.5;
        if (profile.buttons?.[0]?.region) {
          const expectedW = profile.buttons[0].region.width * screenWidth;
          const detectedW = candidate.word.bbox.x1 - candidate.word.bbox.x0;
          const ratio = detectedW / Math.max(1, expectedW);
          sizeScore = ratio > 0.5 && ratio < 2 ? 1 - Math.abs(1 - ratio) : 0.2;
        }

        const contextScore = posScore > 0.3 ? 0.8 : 0.4;

        const confidence = (candidate.textScore * textWeight) +
          (wordConf * confWeight) +
          (posScore * posWeight) +
          (sizeScore * sizeWeight) +
          (contextScore * contextWeight);

        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestMatch = { ...candidate, posScore, sizeScore, contextScore, wordConf };
        }
      }

      const confidence = bestConfidence;

      // Translate word bbox back to absolute screen coordinates
      const wordBbox = bestMatch.word.bbox;
      const cropPixelX = cropRegion.x * screenWidth;
      const cropPixelY = cropRegion.y * screenHeight;
      const screenX = Math.round(cropPixelX + (wordBbox.x0 + wordBbox.x1) / 2);
      const screenY = Math.round(cropPixelY + (wordBbox.y0 + wordBbox.y1) / 2);

      return {
        found: confidence >= 0.40,
        confidence: Math.round(confidence * 1000) / 1000,
        label: bestMatch.word.text,
        screenX,
        screenY,
        details: {
          textScore: bestMatch.textScore,
          wordConfidence: bestMatch.wordConf,
          posScore: bestMatch.posScore,
          sizeScore: bestMatch.sizeScore,
          contextScore: bestMatch.contextScore,
          bbox: wordBbox,
          candidateCount: candidates.length,
          allWords: words.map(w => ({ text: w.text, conf: w.confidence }))
        }
      };
    } catch (err) {
      console.error(`[OcrDetector] Detection error: ${err.message}`);
      return { found: false, confidence: 0, label: null, screenX: 0, screenY: 0, details: { reason: 'error', error: err.message } };
    }
  }
}

// ─── Word Extraction (Tesseract.js v7 nested blocks) ──────────────────────────

/**
 * Extract flat word array from Tesseract.js v7 blocks → paragraphs → lines → words.
 * Divides bbox coordinates by scale factor to undo preprocessing upscale.
 */
function extractWords(blocks, scale = 1) {
  const words = [];
  if (!blocks || !Array.isArray(blocks)) return words;
  for (const block of blocks) {
    for (const para of (block.paragraphs || [])) {
      for (const line of (para.lines || [])) {
        for (const word of (line.words || [])) {
          if (word.text && word.text.trim()) {
            words.push({
              text: word.text.trim(),
              confidence: word.confidence ?? 0,
              bbox: {
                x0: Math.round((word.bbox?.x0 || 0) / scale),
                y0: Math.round((word.bbox?.y0 || 0) / scale),
                x1: Math.round((word.bbox?.x1 || 0) / scale),
                y1: Math.round((word.bbox?.y1 || 0) / scale)
              }
            });
          }
        }
      }
    }
  }
  return words;
}

// ─── Fuzzy Text Matching ───────────────────────────────────────────────────────

function fuzzyMatch(ocrText, variants) {
  const normalized = ocrText.toLowerCase().trim();
  let best = 0;

  for (const variant of variants) {
    const target = variant.toLowerCase();

    // Exact match
    if (normalized === target) return 1.0;

    // Contains match
    if (normalized.includes(target)) {
      best = Math.max(best, 0.9);
      continue;
    }

    // Reversed contains (OCR grabbed extra chars around the button text)
    if (target.includes(normalized) && normalized.length >= target.length * 0.7) {
      best = Math.max(best, 0.85);
      continue;
    }

    // Character-level similarity (handles OCR corruption like "Accep+" for "Accept")
    const sim = charSimilarity(normalized, target);
    if (sim > 0.75) {
      best = Math.max(best, sim * 0.85);
    }
  }

  return best;
}

function charSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / maxLen;
}

export const ocrDetector = new OcrDetector();
export { OcrDetector };
export default ocrDetector;
