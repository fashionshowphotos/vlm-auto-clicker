import { ocrDetector, screenWatcher } from './core_binary.mjs';


import sharp from 'sharp';
import fs from 'fs';

console.log('Capturing full screen...');
const screenshot = await screenWatcher.capture();
fs.writeFileSync('debug_full.png', screenshot);
console.log(`Full screenshot: ${screenshot.length} bytes, ${screenWatcher.screenWidth}x${screenWatcher.screenHeight}`);

// Crop bottom-right quarter
const region = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
const cropped = await screenWatcher.crop(screenshot, region);
fs.writeFileSync('debug_crop.png', cropped);
console.log(`Cropped: ${cropped.length} bytes`);

// Preprocess: removeAlpha + negate + greyscale + 3x upscale + normalise + sharpen
const meta = await sharp(cropped).metadata();
console.log(`Crop metadata: ${meta.width}x${meta.height}, channels=${meta.channels}, format=${meta.format}`);
const processed = await sharp(cropped)
  .removeAlpha()
  .negate()
  .greyscale()
  .resize(meta.width * 3, meta.height * 3, { kernel: 'lanczos3' })
  .normalise()
  .sharpen({ sigma: 1.5 })
  .toBuffer();
fs.writeFileSync('debug_inverted.png', processed);
console.log(`Processed: ${processed.length} bytes (saved as debug_inverted.png)`);

// Run OCR with blocks: true (v7 requires explicit opt-in for word-level data)
await ocrDetector.initialize();

const r = await ocrDetector.worker.recognize(processed, {}, { blocks: true });
console.log(`\nText: "${r.data.text?.trim().substring(0, 200)}"`);
console.log(`blocks is array: ${Array.isArray(r.data.blocks)}, length: ${r.data.blocks?.length}`);

// Extract words from blocks -> paragraphs -> lines -> words (v7 structure)
const words = [];
for (const block of (r.data.blocks || [])) {
  for (const para of (block.paragraphs || [])) {
    for (const line of (para.lines || [])) {
      for (const word of (line.words || [])) {
        if (word.text?.trim()) {
          words.push({
            text: word.text.trim(),
            confidence: word.confidence ?? 0,
            // Divide by 3 to undo the 3x upscale
            bbox: {
              x0: Math.round((word.bbox?.x0 || 0) / 3),
              y0: Math.round((word.bbox?.y0 || 0) / 3),
              x1: Math.round((word.bbox?.x1 || 0) / 3),
              y1: Math.round((word.bbox?.y1 || 0) / 3)
            }
          });
        }
      }
    }
  }
}
console.log(`\nExtracted ${words.length} words:`);
for (const w of words.slice(0, 30)) {
  console.log(`  "${w.text}" conf=${w.confidence.toFixed(1)} bbox=${JSON.stringify(w.bbox)}`);
}

// Check for matching button labels
const runWords = words.filter(w => /^(run|accept|apply|confirm|reject)/i.test(w.text));
console.log(`\nButton-like words: ${runWords.length}`);
for (const w of runWords) {
  console.log(`  "${w.text}" conf=${w.confidence.toFixed(1)} bbox=${JSON.stringify(w.bbox)}`);
}

const fullText = r.data.text || '';
console.log(`\nFull text contains "Run": ${fullText.includes('Run')}`);

// Now test the full detect() pipeline
const profile = {
  buttons: [{
    label: 'Run',
    labelVariants: ['Accept', 'Accept All', 'Apply', 'Run', 'Run All', 'Confirm'],
    region: { x: 0.75, y: 0.75, width: 0.1, height: 0.05 }
  }]
};
const detection = await ocrDetector.detect(cropped, profile, screenWatcher.screenWidth, screenWatcher.screenHeight, region);
console.log(`\nFull detect() result:`);
console.log(`  found=${detection.found}, confidence=${detection.confidence}, label="${detection.label}"`);
console.log(`  screenX=${detection.screenX}, screenY=${detection.screenY}`);
if (detection.details?.allWords) {
  console.log(`  allWords: ${detection.details.allWords.map(w => `"${w.text}"`).join(', ')}`);
}

await ocrDetector.terminate();
console.log('\nDone. Check debug_full.png, debug_crop.png, debug_inverted.png');
