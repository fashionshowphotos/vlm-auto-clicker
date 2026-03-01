/**
 * loop_utils.js — Safe recurring loop primitives for Pandora.
 *
 * Prevents: silent interval death, async overlap, zombie timers after stop,
 * unhandled promise rejections, double-start bugs.
 *
 * Optionally integrates with loop_registry.js for observability.
 */

let registry = null;
import('./loop_registry.js')
    .then((mod) => {
        registry = mod;
    })
    .catch(() => {
        // Registry not available — loops still work, just not tracked
    });

function validateInterval(intervalMs, name) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
        throw new Error(`Invalid intervalMs (${intervalMs}) for loop "${name}"`);
    }
}

function makeErrorHandler(name, onError) {
    return function handleError(err) {
        registry?.recordError(name, err);
        if (typeof onError === 'function') {
            try {
                onError(err);
            } catch (e) {
                console.error(`[Loop:${name}] Error in onError handler:`, e);
            }
        } else {
            console.error(`[Loop:${name}] Error:`, err);
        }
    };
}

/**
 * A protected setInterval that wraps fn in try/catch, prevents silent death,
 * and allows clean shutdown.
 *
 * @param {Function} fn - Sync or async function to call each interval
 * @param {number} intervalMs - Interval in milliseconds
 * @param {Object} [options]
 * @param {string} [options.name='unnamed'] - Loop name for logging
 * @param {Function} [options.onError] - Custom error handler
 * @param {boolean} [options.autoStart=true] - Start immediately
 * @param {boolean} [options.preventOverlap=false] - Skip tick if previous async call still running
 * @returns {LoopHandle}
 */
export function safeInterval(fn, intervalMs, options = {}) {
    const { name = 'unnamed', onError, autoStart = true, preventOverlap = false } = options;
    validateInterval(intervalMs, name);

    let timerId = null;
    let active = false;
    let running = false;
    const handleError = makeErrorHandler(name, onError);

    async function tick() {
        if (!active) return;
        if (preventOverlap && running) return;
        running = true;
        try {
            await fn();
            registry?.recordRun(name);
        } catch (err) {
            handleError(err);
        } finally {
            running = false;
        }
    }

    const handle = {
        start() {
            if (active) return;
            active = true;
            running = false;
            timerId = setInterval(tick, intervalMs);
            if (timerId.unref) timerId.unref();
            registry?.registerLoop(name, 'safeInterval', handle);
        },
        stop() {
            active = false;
            running = false;
            if (timerId !== null) {
                clearInterval(timerId);
                timerId = null;
            }
            registry?.unregisterLoop(name);
        },
        isRunning() {
            return active;
        },
        getName() {
            return name;
        }
    };

    if (autoStart) handle.start();
    return handle;
}

/**
 * Self-scheduling async loop that never overlaps.
 * Runs asyncFn immediately, waits for completion, then schedules next run after intervalMs.
 *
 * @param {Function} asyncFn - Async function to call each cycle
 * @param {number} intervalMs - Delay between end of one run and start of next
 * @param {Object} [options]
 * @param {string} [options.name='unnamed'] - Loop name for logging
 * @param {Function} [options.onError] - Custom error handler
 * @param {boolean} [options.autoStart=true] - Start immediately
 * @param {boolean} [options.runImmediately=true] - Run first execution immediately (false = wait one interval)
 * @returns {LoopHandle}
 */
export function selfSchedulingLoop(asyncFn, intervalMs, options = {}) {
    const { name = 'unnamed', onError, autoStart = true, runImmediately = true } = options;
    validateInterval(intervalMs, name);

    let timerId = null;
    let active = false;
    let generation = 0;
    const handleError = makeErrorHandler(name, onError);

    async function run(gen) {
        if (!active || gen !== generation) return;
        try {
            await asyncFn();
            registry?.recordRun(name);
        } catch (err) {
            handleError(err);
        }
        if (!active || gen !== generation) return;
        timerId = setTimeout(() => run(gen), intervalMs);
        if (timerId.unref) timerId.unref();
    }

    const handle = {
        start() {
            if (active) return;
            active = true;
            generation++;
            const gen = generation;
            registry?.registerLoop(name, 'selfSchedulingLoop', handle);
            if (runImmediately) {
                run(gen);
            } else {
                timerId = setTimeout(() => run(gen), intervalMs);
                if (timerId.unref) timerId.unref();
            }
        },
        stop() {
            active = false;
            generation++;
            if (timerId !== null) {
                clearTimeout(timerId);
                timerId = null;
            }
            registry?.unregisterLoop(name);
        },
        isRunning() {
            return active;
        },
        getName() {
            return name;
        }
    };

    if (autoStart) handle.start();
    return handle;
}

/**
 * Simple delay utility.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
