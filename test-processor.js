import {
	assert,
	emscripten_get_now,
	emscripten_outf,
	emscripten_atomic_load_u32,
	emscripten_atomic_store_u32,
	emscripten_lock_busyspin_wait_acquire,
	emscripten_lock_try_acquire,
	emscripten_lock_release,
	emscripten_current_thread_is_audio_worklet,
	_emscripten_thread_supports_atomics_wait,
	Browser,
	getBrowser,
} from "./emscripten-api.js";

// Style for the process() log (green)
var STYLE_PROC = "\x1B[32m\t";

class TestProcessor extends AudioWorkletProcessor {
	constructor(args) {
		super();
		if (args && args.processorOptions) {
			// Push vars into the AWP's scope
			for (var opt in args.processorOptions) {
				globalThis[opt] = args.processorOptions[opt];
			}
		}
		if (getBrowser() != Browser.BROWSER_CHROME) {
		// No ANSI colours if this isn't Chrome
			STYLE_PROC = "\t";
		}
		// Here just for testing
		this.port.onmessage = (e) => {
			emscripten_outf("%sAWP message: %s", STYLE_PROC, e.data);
		};
	}

	// AW callback (called approx 375x per second)
	process(inputs, outputs, params) {
		emscripten_outf("%s*** enter process()", STYLE_PROC);
		var runAgain = true;
		var result;
		var waitMs;
		switch (emscripten_atomic_load_u32(whichTest)) {
		case Test.TEST_LOADING:
			assert(emscripten_current_thread_is_audio_worklet()
				&& !_emscripten_thread_supports_atomics_wait());
			// AWP has been loaded, tell the main thread
			emscripten_outf("%sTEST_LOADING", STYLE_PROC);
			emscripten_atomic_store_u32(whichTest, Test.TEST_NOT_STARTED);
			break;
		case Test.TEST_NOT_STARTED:
			// Waiting on the main thread to acknowledge
			emscripten_outf("%sTEST_NOT_STARTED", STYLE_PROC);
			break;
		case Test.TEST_TRY_ACQUIRE:
			// Was locked after init, should fail to acquire
			result = emscripten_lock_try_acquire(testLock);
			emscripten_outf("%sTEST_TRY_ACQUIRE: %d (expect: 0)", STYLE_PROC, result);
			assert(!result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_WAIT_ACQUIRE_FAIL);
			break;
		case Test.TEST_WAIT_ACQUIRE_FAIL:
			// Still locked so we fail to acquire
			emscripten_outf("%sTEST_WAIT_ACQUIRE_FAIL: spin for 100ms (count 'em!)", STYLE_PROC);
			waitMs = emscripten_get_now();
			result = emscripten_lock_busyspin_wait_acquire(testLock, 100);
			waitMs = emscripten_get_now() - waitMs;
			emscripten_outf("%sTEST_WAIT_ACQUIRE_FAIL: %d (expect: 0, spinning for %dms)", STYLE_PROC, result, waitMs);
			assert(!result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_WAIT_ACQUIRE);
			/*
			 * Fall through here so the main has a chance to unlock whilst
			 * spinning (otherwise the lock has a chance to be released before
			 * spinning).
			 */
		case Test.TEST_WAIT_ACQUIRE:
			// Will get unlocked in the main, so should quickly acquire
			emscripten_outf("%sTEST_WAIT_ACQUIRE: start spinning!", STYLE_PROC);
			waitMs = emscripten_get_now();
			result = emscripten_lock_busyspin_wait_acquire(testLock, 1000);
			waitMs = emscripten_get_now() - waitMs;
			emscripten_outf("%sTEST_WAIT_ACQUIRE: %d (expect: 1, spinning for %dms)", STYLE_PROC, result, waitMs);
			// Assert after, since this is where it can fail and kill the callback
			emscripten_atomic_store_u32(whichTest, (result) ? Test.TEST_RELEASE : Test.TEST_DONE);
			assert(result);
			break;
		case Test.TEST_RELEASE:
			// Unlock, check the result
			emscripten_outf("%sTEST_RELEASE: unlocking", STYLE_PROC);
			emscripten_lock_release(testLock);
			result = emscripten_lock_try_acquire(testLock);
			emscripten_outf("%sTEST_RELEASE: %d (expect: 1)", STYLE_PROC, result);
			assert(result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_DONE);
			break;
		default:
			// Finished, exit from the audio thread
			emscripten_outf("%sTEST_DONE in process()", STYLE_PROC);
			runAgain = false;
		}
		emscripten_outf("%s*** exit process()", STYLE_PROC);
		return runAgain;
	}
}

registerProcessor("test-processor", TestProcessor);
