/**
 * Screen Watcher — Screenshot capture, crop, color pre-filter, mouse & click
 *
 * Security: Uses -EncodedCommand instead of temp .ps1 files to prevent
 * TOCTOU script replacement attacks (Fix 2).
 *
 * Uses:
 *   - PowerShell + .NET System.Drawing: full screen capture (no native npm deps)
 *   - sharp: crop to expected button region (~10ms)
 *   - PowerShell + user32.dll: mouse position + click
 */

import sharp from 'sharp';
import { execSync, exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// PowerShell script that captures the full screen to a PNG file using .NET
// %OUTPUT% is replaced at runtime with the actual temp file path
const CAPTURE_PS_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$allScreens = [System.Windows.Forms.Screen]::AllScreens
[int]$minX = ($allScreens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum
[int]$minY = ($allScreens | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum
[int]$maxX = ($allScreens | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum
[int]$maxY = ($allScreens | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum
[int]$totalW = $maxX - $minX
[int]$totalH = $maxY - $minY
if ($totalW -le 0 -or $totalH -le 0) { [int]$totalW = 1920; [int]$totalH = 1080; [int]$minX = 0; [int]$minY = 0 }
$bmp = New-Object System.Drawing.Bitmap($totalW, $totalH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$sz = New-Object System.Drawing.Size($totalW, $totalH)
$g.CopyFromScreen($minX, $minY, 0, 0, $sz)
$g.Dispose()
$bmp.Save('%OUTPUT%', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$totalW,$totalH"
`;

// PowerShell script that gets cursor position using .NET
const MOUSE_PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
Write-Output "$($p.X),$($p.Y)"
`;

/**
 * Encode a PowerShell script as UTF-16LE base64 for -EncodedCommand.
 * This eliminates the need for temp .ps1 files (prevents TOCTOU attacks).
 */
function encodePS(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

class ScreenWatcher {
  constructor() {
    this.lastMousePos = null;
    this.lastMouseCheckTime = 0;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this._screenDetected = false;
    this._tempDir = path.join(os.tmpdir(), 'firejumper_screen');
  }

  _ensureTempDir() {
    if (!fs.existsSync(this._tempDir)) {
      fs.mkdirSync(this._tempDir, { recursive: true });
    }
  }

  /**
   * Capture full screen (all monitors) as PNG buffer.
   * Uses -EncodedCommand to avoid temp script files.
   * Still needs a temp file for the PNG output (random filename).
   */
  async capture() {
    this._ensureTempDir();
    // Random filename prevents prediction
    const outFile = path.join(this._tempDir, `cap_${crypto.randomUUID()}.png`);
    const script = CAPTURE_PS_SCRIPT.replace('%OUTPUT%', outFile);
    const encoded = encodePS(script);

    try {
      const result = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
        { timeout: 10000, encoding: 'utf8' }
      ).trim();

      // Parse screen dimensions from output
      if (!this._screenDetected && result) {
        const parts = result.split(',').map(Number);
        if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
          this.screenWidth = parts[0];
          this.screenHeight = parts[1];
          this._screenDetected = true;
          console.log(`[ScreenWatcher] Screen: ${this.screenWidth}x${this.screenHeight}`);
        }
      }

      const buffer = fs.readFileSync(outFile);
      // Clean up temp PNG (best effort)
      try { fs.unlinkSync(outFile); } catch (e) {}
      return buffer;
    } catch (err) {
      try { fs.unlinkSync(outFile); } catch (e) {}
      throw new Error(`Screenshot failed: ${err.message}`);
    }
  }

  /**
   * Crop a PNG buffer to a fractional region (0-1 coords).
   * Returns cropped PNG buffer.
   */
  async crop(buffer, region) {
    const left = Math.round(region.x * this.screenWidth);
    const top = Math.round(region.y * this.screenHeight);
    const width = Math.min(
      Math.round(region.width * this.screenWidth),
      this.screenWidth - left
    );
    const height = Math.min(
      Math.round(region.height * this.screenHeight),
      this.screenHeight - top
    );

    if (width <= 0 || height <= 0) return null;

    return sharp(buffer)
      .extract({ left, top, width, height })
      .toBuffer();
  }

  /**
   * Quick color pre-filter: check if any pixels in a region match an expected color.
   * Returns true if potential button-colored pixels found.
   */
  async colorPreFilter(buffer, colorHint) {
    if (!colorHint || (!colorHint.bgColor && !colorHint.textColor)) {
      return true; // No color info — proceed to OCR
    }

    try {
      const { dominant } = await sharp(buffer).stats();
      if (colorHint.bgColor) {
        const target = hexToRgb(colorHint.bgColor);
        if (target) {
          const dist = colorDistance(dominant, target);
          if (dist < 100) return true;
        }
      }
      // Typical button colors (blue/green) = proceed
      if (dominant.r < 100 && dominant.g > 100 && dominant.b > 150) return true;
      if (dominant.r < 100 && dominant.g > 150 && dominant.b < 100) return true;
    } catch (e) {}

    return true; // When in doubt, proceed to OCR
  }

  /**
   * Check if user is actively moving their mouse.
   * Returns true if mouse moved more than 5px since last check.
   */
  isUserActive() {
    try {
      const result = execSync(
        `powershell -NoProfile -Command "${MOUSE_PS_SCRIPT.replace(/\r?\n/g, '; ').replace(/"/g, '\\"')}"`,
        { timeout: 3000, encoding: 'utf8' }
      ).trim();

      const [x, y] = result.split(',').map(Number);
      if (isNaN(x) || isNaN(y)) return false;

      const now = Date.now();
      const pos = { x, y };

      if (this.lastMousePos) {
        const dx = pos.x - this.lastMousePos.x;
        const dy = pos.y - this.lastMousePos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const dt = now - this.lastMouseCheckTime;

        this.lastMousePos = pos;
        this.lastMouseCheckTime = now;

        return dist > 5 && dt < 3000;
      }

      this.lastMousePos = pos;
      this.lastMouseCheckTime = now;
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get current mouse position.
   */
  getMousePosition() {
    try {
      const result = execSync(
        `powershell -NoProfile -Command "${MOUSE_PS_SCRIPT.replace(/\r?\n/g, '; ').replace(/"/g, '\\"')}"`,
        { timeout: 3000, encoding: 'utf8' }
      ).trim();
      const [x, y] = result.split(',').map(Number);
      if (isNaN(x) || isNaN(y)) return null;
      return { x, y };
    } catch (e) {
      return null;
    }
  }

  /**
   * Click at screen coordinates using PowerShell + user32.dll.
   * Uses -EncodedCommand to avoid temp script files (prevents TOCTOU).
   */
  async click(x, y, jitter = 3) {
    const jx = x + Math.round((Math.random() - 0.5) * jitter * 2);
    const jy = y + Math.round((Math.random() - 0.5) * jitter * 2);

    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
'@
[WinInput]::ClickAt(${jx}, ${jy})
`;

    const encoded = encodePS(script);

    return new Promise((resolve, reject) => {
      exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
        { timeout: 5000 },
        (err) => {
          if (err) reject(err);
          else resolve({ x: jx, y: jy });
        }
      );
    });
  }
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

function colorDistance(a, b) {
  return Math.sqrt(
    Math.pow(a.r - b.r, 2) +
    Math.pow(a.g - b.g, 2) +
    Math.pow(a.b - b.b, 2)
  );
}

export const screenWatcher = new ScreenWatcher();
export { ScreenWatcher };
export default screenWatcher;
