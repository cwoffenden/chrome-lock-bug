import {
	assert,
	emscripten_outf,
	emscripten_atomic_load_u32,
	emscripten_atomic_store_u32,
	emscripten_lock_busyspin_wait_acquire,
	emscripten_lock_try_acquire,
	emscripten_lock_release
} from "./emscripten-api.js";

// Style for the process() log (green)
const CSS = "color: #0F0";

class TestProcessor extends AudioWorkletProcessor {
	constructor(args) {
		super();
		if (args && args.processorOptions) {
			// Push vars into the AWP's scope
			for (var opt in args.processorOptions) {
				globalThis[opt] = args.processorOptions[opt];
			}
			// Then signal to the main thread to start the test
			emscripten_atomic_store_u32(whichTest, Test.TEST_NOT_STARTED);
		}
		this.port.onmessage = (e) => {
			emscripten_outf("AWP message: %s", e.data);
		};
	}

	process(inputs, outputs, params) {
		var runAgain = true;
		emscripten_outf("%c*** enter process()", CSS);
		var result = 0;
		switch (emscripten_atomic_load_u32(whichTest)) {
		case Test.TEST_LOADING:
		case Test.TEST_NOT_STARTED:
			emscripten_outf("%cTEST_NOT_STARTED: should not been called", CSS);
			break;
		case Test.TEST_TRY_ACQUIRE:
			// Was locked after init, should fail to acquire
			result = emscripten_lock_try_acquire(testLock);
			emscripten_outf("%cTEST_TRY_ACQUIRE: %d (expect: 0)", CSS, result);
			assert(!result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_WAIT_ACQUIRE_FAIL);
			break;
		case Test.TEST_WAIT_ACQUIRE_FAIL:
			// Still locked so we fail to acquire
    		emscripten_outf("%cTEST_WAIT_ACQUIRE_FAIL: spin for 100ms!", CSS);
			result = emscripten_lock_busyspin_wait_acquire(testLock, 100);
			emscripten_outf("%cTEST_WAIT_ACQUIRE_FAIL: %d (expect: 0)", CSS, result);
			assert(!result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_WAIT_ACQUIRE);
    		/*
    		 * Fall through here so the worker/main has a chance to unlock
    		 * whilst spinning (otherwise the lock has a chance to be released
    		 * before spinning).
    		 */
    	case Test.TEST_WAIT_ACQUIRE:
    		// Will get unlocked in worker/main, so should quickly acquire
    		emscripten_outf("%cTEST_WAIT_ACQUIRE: start spinning!", CSS);
    		result = emscripten_lock_busyspin_wait_acquire(testLock, 1000);
    		emscripten_outf("%cTEST_WAIT_ACQUIRE: %d (expect: 1)", CSS, result);
    		assert(result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_RELEASE);
			break;
		case Test.TEST_RELEASE:
			// Unlock, check the result
			emscripten_outf("%cTEST_RELEASE: unlocking", CSS);
			emscripten_lock_release(testLock);
			result = emscripten_lock_try_acquire(testLock);
			emscripten_outf("%cTEST_RELEASE: %d (expect: 1)", CSS, result);
			assert(result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_DONE);
			break;
		default:
			// Finished, exit from the audio thread
			emscripten_outf("%cTEST_DONE in process()", CSS);
			runAgain = false;
		}
		emscripten_outf("%c*** exit process()", CSS);
		return runAgain;
	}
}

registerProcessor("test-processor", TestProcessor);
