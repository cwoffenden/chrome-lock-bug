import {
	assert,
	emscripten_outf,
	emscripten_atomic_load_u32,
	emscripten_atomic_store_u32,
	emscripten_lock_busyspin_wait_acquire,
	emscripten_lock_try_acquire,
	emscripten_lock_release
} from "./emscripten-api.js";

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
		var result = 0;
		switch (emscripten_atomic_load_u32(whichTest)) {
		case Test.TEST_TRY_ACQUIRE:
			// Was locked after init, should fail to acquire
			result = emscripten_lock_try_acquire(testLock);
			emscripten_outf("TEST_TRY_ACQUIRE: %d (expect: 0)", result);
			assert(!result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_WAIT_ACQUIRE_FAIL);
			break;
		case Test.TEST_WAIT_ACQUIRE_FAIL:
			// Still locked so we fail to acquire
			result = emscripten_lock_busyspin_wait_acquire(testLock, 100);
			emscripten_outf("TEST_WAIT_ACQUIRE_FAIL: %d (expect: 0)", result);
			assert(!result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_WAIT_ACQUIRE);
    		/*
    		 * Fall through here so the worker/main has a chance to unlock
    		 * whilst spinning (otherwise the lock has a chance to be released
    		 * before spinning).
    		 */
    	case Test.TEST_WAIT_ACQUIRE:
    		// Will get unlocked in worker/main, so should quickly acquire
    		result = emscripten_lock_busyspin_wait_acquire(testLock, 1000);
    		emscripten_outf("TEST_WAIT_ACQUIRE: %d  (expect: 1)", result);
    		assert(result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_RELEASE);
			break;
		case Test.TEST_RELEASE:
			// Unlock, check the result
			emscripten_lock_release(testLock);
			result = emscripten_lock_try_acquire(testLock);
			emscripten_outf("TEST_RELEASE: %d (expect: 1)", result);
			assert(result);
			emscripten_atomic_store_u32(whichTest, Test.TEST_DONE);
			break;
		case Test.TEST_DONE:
			return false;
		default:
			break;
		}
		return true;
	}
}

registerProcessor("test-processor", TestProcessor);
