const fs = require('fs');
const path = require('path');

function countTests(dir) {
  let total = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countTests(fullPath);
      continue;
    }
    if (/\.test\.(?:c|m)?js$/i.test(entry.name)) {
      total += 1;
    }
  }

  return total;
}

const testsDir = path.join(process.cwd(), 'tests');
if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory()) {
  console.error('[test-precheck] Missing tests/ directory.');
  process.exit(1);
}

const testCount = countTests(testsDir);
if (testCount === 0) {
  console.error('[test-precheck] No test files found under tests/.');
  process.exit(1);
}

console.log(`[test-precheck] Found ${testCount} test file(s).`);
