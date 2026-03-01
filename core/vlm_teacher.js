/**
 * VLM Teacher — Cloud vision model for learning what accept buttons look like
 *
 * The "teacher" in the teacher-student pattern.
 * Called RARELY — only on first run and when the local OCR detector loses confidence.
 * Uses GPT-4o-mini vision (or any OpenAI-compatible vision API).
 *
 * Cost: ~$0.0001 per call (image at detail:low = 85 tokens)
 * Budget caps: max calls per day and per session
 */

class VlmTeacher {
  constructor() {
    this.config = {
      model: 'gpt-4o-mini',
      apiKey: null,
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      maxCallsPerDay: 10,
      maxCallsPerSession: 5,
      imageDetail: 'low'
    };
    this.session = {
      callsToday: 0,
      callsThisSession: 0,
      lastCallDate: null,
      totalCalls: 0
    };
  }

  configure(opts = {}) {
    if (opts.model) this.config.model = opts.model;
    if (opts.apiKey) this.config.apiKey = opts.apiKey;
    if (opts.apiUrl) this.config.apiUrl = opts.apiUrl;
    if (opts.maxCallsPerDay) this.config.maxCallsPerDay = opts.maxCallsPerDay;
    if (opts.maxCallsPerSession) this.config.maxCallsPerSession = opts.maxCallsPerSession;
  }

  _resetDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.session.lastCallDate !== today) {
      this.session.callsToday = 0;
      this.session.lastCallDate = today;
    }
  }

  _checkBudget() {
    this._resetDailyIfNeeded();
    if (this.session.callsToday >= this.config.maxCallsPerDay) {
      return { allowed: false, reason: `Daily VLM limit reached (${this.config.maxCallsPerDay})` };
    }
    if (this.session.callsThisSession >= this.config.maxCallsPerSession) {
      return { allowed: false, reason: `Session VLM limit reached (${this.config.maxCallsPerSession})` };
    }
    if (!this.config.apiKey) {
      return { allowed: false, reason: 'No VLM API key configured' };
    }
    return { allowed: true };
  }

  /**
   * Initial learning: send screenshot, discover all accept/apply buttons.
   *
   * @param {Buffer} screenshotBuffer - Full screen PNG
   * @param {string} ide - IDE name ("vscode", "cursor", "windsurf")
   * @returns {Object} VLM result with buttons array, or error
   */
  async learn(screenshotBuffer, ide) {
    const budget = this._checkBudget();
    if (!budget.allowed) {
      console.log(`[VlmTeacher] Blocked: ${budget.reason}`);
      return { success: false, error: budget.reason };
    }

    const prompt = `You are analyzing a screenshot of the ${ide} IDE editor.

The user is using an AI coding assistant (like Copilot, Cursor AI, or Windsurf AI) that generates code changes and shows diff views with accept/apply buttons.

Find ALL buttons or clickable elements that would accept or apply AI-generated code changes. These typically have labels like "Accept", "Accept All", "Apply", "Apply All", "Accept Changes", "Accept Block", or similar.

Return ONLY valid JSON with this exact structure:
{
  "ide": "${ide}",
  "screenWidth": <detected or estimated screen width>,
  "screenHeight": <detected or estimated screen height>,
  "buttons": [
    {
      "label": "<exact button text>",
      "labelVariants": ["<all similar labels you can see or expect>"],
      "x": <center x pixel>,
      "y": <center y pixel>,
      "width": <button width pixels>,
      "height": <button height pixels>,
      "bgColor": "<approximate background color as hex>",
      "textColor": "<approximate text color as hex>",
      "context": "<describe what surrounds this button>"
    }
  ],
  "noButtonsFound": false,
  "reason": null
}

If no accept/apply buttons are visible right now (which is normal when no AI code changes are pending), return:
{
  "noButtonsFound": true,
  "reason": "No AI-generated changes visible",
  "buttons": [],
  "expectedLocation": "<describe where these buttons typically appear in ${ide}>"
}

CRITICAL: Return ONLY the JSON object. No markdown, no code fences, no explanation.`;

    return this._callVlm(screenshotBuffer, prompt);
  }

  /**
   * Re-learn: update profile after confidence dropped.
   * Includes previous profile context so VLM can identify changes.
   *
   * @param {Buffer} screenshotBuffer - Full screen PNG
   * @param {string} ide - IDE name
   * @param {Object} prevProfile - Previous button profile
   * @returns {Object} VLM result
   */
  async relearn(screenshotBuffer, ide, prevProfile) {
    const budget = this._checkBudget();
    if (!budget.allowed) {
      console.log(`[VlmTeacher] Blocked: ${budget.reason}`);
      return { success: false, error: budget.reason };
    }

    const prevButtons = (prevProfile.buttons || []).map(b => ({
      label: b.label,
      region: b.region,
      context: b.context
    }));

    const prompt = `You are analyzing a screenshot of the ${ide} IDE editor. A previous profile for accept/apply buttons exists but is no longer matching correctly. The UI may have changed.

Previous profile expected:
${JSON.stringify(prevButtons, null, 2)}

Please locate the current accept/apply buttons for AI-generated code changes. If the UI has changed, describe what changed.

Return ONLY valid JSON:
{
  "ide": "${ide}",
  "screenWidth": <width>,
  "screenHeight": <height>,
  "buttons": [
    {
      "label": "<exact button text>",
      "labelVariants": ["<variants>"],
      "x": <center x pixel>,
      "y": <center y pixel>,
      "width": <button width pixels>,
      "height": <button height pixels>,
      "bgColor": "<hex>",
      "textColor": "<hex>",
      "context": "<surroundings>"
    }
  ],
  "uiChanged": true,
  "changeDescription": "<what changed>"
}

CRITICAL: Return ONLY the JSON object. No markdown, no code fences, no explanation.`;

    return this._callVlm(screenshotBuffer, prompt);
  }

  /**
   * Internal: make the actual VLM API call.
   * Fix 6: Cap image size at 500KB to prevent sending huge screenshots.
   */
  async _callVlm(screenshotBuffer, prompt) {
    // Cap image size — prevents accidentally sending multi-MB full-screen captures
    const MAX_IMAGE_BYTES = 500 * 1024;
    if (screenshotBuffer.length > MAX_IMAGE_BYTES) {
      try {
        const sharp = (await import('sharp')).default;
        screenshotBuffer = await sharp(screenshotBuffer)
          .resize({ width: 800, withoutEnlargement: true })
          .png()
          .toBuffer();
        console.log(`[VlmTeacher] Image resized to ${screenshotBuffer.length} bytes (was over 500KB cap)`);
      } catch (resizeErr) {
        console.warn(`[VlmTeacher] Image resize failed: ${resizeErr.message}, sending original`);
      }
    }

    const base64 = screenshotBuffer.toString('base64');

    try {
      console.log(`[VlmTeacher] Calling ${this.config.model}...`);
      const startTime = Date.now();

      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 30000);
      let response;
      try {
        response = await fetch(this.config.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'HTTP-Referer': 'https://coherentlightdesigns.com',
            'X-Title': 'VLM Auto-Clicker'
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${base64}`,
                    detail: this.config.imageDetail
                  }
                }
              ]
            }],
            max_tokens: 800,
            temperature: 0.1
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(fetchTimeout);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`API ${response.status}: ${body.substring(0, 200)}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      const elapsed = Date.now() - startTime;

      // Track budget
      this._resetDailyIfNeeded();
      this.session.callsToday++;
      this.session.callsThisSession++;
      this.session.totalCalls++;

      console.log(`[VlmTeacher] Response in ${elapsed}ms (${content.length} chars). Budget: ${this.session.callsToday}/${this.config.maxCallsPerDay} today`);

      // Parse JSON from response (strip markdown fences if present)
      const parsed = parseVlmJson(content);
      if (!parsed) {
        return { success: false, error: 'Failed to parse VLM JSON response', raw: content };
      }

      return { success: true, ...parsed };
    } catch (err) {
      console.error(`[VlmTeacher] API error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  getStats() {
    return { ...this.session, config: { model: this.config.model, maxPerDay: this.config.maxCallsPerDay } };
  }
}

/**
 * Parse JSON from VLM response, handling markdown code fences.
 * Fix 3: Validates schema — buttons must be array with numeric x/y/width/height.
 */
function parseVlmJson(text) {
  if (!text) return null;

  let parsed = null;

  // Try direct parse first
  try { parsed = JSON.parse(text.trim()); } catch (e) {}

  // Strip markdown fences
  if (!parsed) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try { parsed = JSON.parse(fenceMatch[1].trim()); } catch (e) {}
    }
  }

  // Try to find JSON object in the text
  if (!parsed) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {}
    }
  }

  if (!parsed) return null;

  // Schema validation: buttons must be an array if present
  if (parsed.buttons !== undefined && !Array.isArray(parsed.buttons)) {
    console.log('[VlmTeacher] Invalid response: buttons is not an array');
    return null;
  }

  // Validate each button has required numeric fields
  if (parsed.buttons) {
    parsed.buttons = parsed.buttons.filter(b => {
      if (!b || typeof b !== 'object') return false;
      if (typeof b.x !== 'number' || typeof b.y !== 'number') return false;
      if (typeof b.width !== 'number' || typeof b.height !== 'number') return false;
      if (b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0) return false;
      return true;
    });
  }

  return parsed;
}

export const vlmTeacher = new VlmTeacher();
export { VlmTeacher };
export default vlmTeacher;
