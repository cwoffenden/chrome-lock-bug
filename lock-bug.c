#include <emscripten/wasm_worker.h>
#include <emscripten/webaudio.h>
#include <assert.h>

// Build with emcc -sAUDIO_WORKLET -sWASM_WORKERS -pthread -o index.html lock-bug.c

// Internal, found in 'system/lib/pthread/threading_internal.h' (and requires building with -pthread)
int _emscripten_thread_supports_atomics_wait(void);

typedef enum {
  TEST_LOADING,           // The page is still loading
  TEST_NOT_STARTED,       // The test hasn't yet started
  TEST_TRY_ACQUIRE,       // Acquired in main, fail in process()
  TEST_WAIT_ACQUIRE_FAIL, // Keep acquired so time-out
  TEST_WAIT_ACQUIRE,      // Release in main, succeed in process()
  TEST_RELEASE,           // Release in process() after above
  TEST_DONE               // Test finished
} Test;

// Lock used in all the tests
emscripten_lock_t testLock = EMSCRIPTEN_LOCK_T_STATIC_INITIALIZER;
// Which test is running (sometimes in the worklet, sometimes in the main thread)
_Atomic Test whichTest = TEST_LOADING;

// Time at which the test starts taken in main()
double startTime = 0;
// Has TEST_WAIT_ACQUIRE unlocked testLock?
bool waitAcquireUnlocked = false;

// Global audio context
EMSCRIPTEN_WEBAUDIO_T audioContext = 0;

void doExit() {
	emscripten_outf("*** doExit()");
	emscripten_destroy_audio_context(audioContext);
	emscripten_force_exit(0);
}

bool process(int numInputs, const AudioSampleFrame *inputs, int numOutputs, AudioSampleFrame *outputs, int numParams, const AudioParamFrame *params, void *userData) {
	emscripten_out("\t*** enter process()");
	assert(emscripten_current_thread_is_audio_worklet()
		&& !_emscripten_thread_supports_atomics_wait());
	bool runAgain = true;
	int result = 0;
	switch (emscripten_atomic_load_u32(&whichTest)) {
	case TEST_LOADING:
		emscripten_atomic_store_u32(&whichTest, TEST_NOT_STARTED);
		break;
	case TEST_NOT_STARTED:
		emscripten_outf("\tTEST_NOT_STARTED: should not been called");
		break;
	case TEST_TRY_ACQUIRE:
		// Was locked after init, should fail to acquire
		result = emscripten_lock_try_acquire(&testLock);
		emscripten_outf("\tTEST_TRY_ACQUIRE: %d (expect: 0)", result);
		assert(!result);
		emscripten_atomic_store_u32(&whichTest, TEST_WAIT_ACQUIRE_FAIL);
		break;
	case TEST_WAIT_ACQUIRE_FAIL:
		// Still locked so we fail to acquire
    	emscripten_out("\tTEST_WAIT_ACQUIRE_FAIL: spin for 100ms (count 'em!)");
		result = emscripten_lock_busyspin_wait_acquire(&testLock, 100);
		emscripten_outf("\tTEST_WAIT_ACQUIRE_FAIL: %d (expect: 0)", result);
		assert(!result);
		emscripten_atomic_store_u32(&whichTest, TEST_WAIT_ACQUIRE);
    	/*
    	 * Fall through here so the worker/main has a chance to unlock
    	 * whilst spinning (otherwise the lock has a chance to be released
    	 * before spinning).
    	 */
    case TEST_WAIT_ACQUIRE:
    	// Will get unlocked in worker/main, so should quickly acquire
		emscripten_out("\tTEST_WAIT_ACQUIRE: start spinning!");
		result = emscripten_lock_busyspin_wait_acquire(&testLock, 1000);
		emscripten_outf("\tTEST_WAIT_ACQUIRE: %d (expect: 1)", result);
		assert(result);
		emscripten_atomic_store_u32(&whichTest, TEST_RELEASE);
		break;
	case TEST_RELEASE:
		// Unlock, check the result
		emscripten_outf("\tTEST_RELEASE: unlocking");
		emscripten_lock_release(&testLock);
		result = emscripten_lock_try_acquire(&testLock);
		emscripten_outf("\tTEST_RELEASE: %d (expect: 1)", result);
		assert(result);
		emscripten_atomic_store_u32(&whichTest, TEST_DONE);
		break;
	default:
		// Finished, exit from the audio thread
		emscripten_out("\tTEST_DONE in process()");
		runAgain = false;
	}
	emscripten_out("*** exit process()");
	return runAgain;
}

bool mainLoop(double time, void* data) {
	emscripten_out("*** enter mainLoop()");
	assert(!emscripten_current_thread_is_audio_worklet()
		&& !_emscripten_thread_supports_atomics_wait());
	bool runAgain = true;
	double timeTook = 0;
	switch (emscripten_atomic_load_u32(&whichTest)) {
	case TEST_LOADING:
		// Wait until the AudioWorkletProcessor (AWP) has loaded
		emscripten_out("TEST_LOADING: Still loading");
		break;
	case TEST_NOT_STARTED:
		// We're loaded, let the AWP know to start
		emscripten_out("TEST_NOT_STARTED: Staring test");
		emscripten_atomic_store_u32(&whichTest, TEST_TRY_ACQUIRE);
		break;
	case TEST_TRY_ACQUIRE:
		emscripten_out("TEST_TRY_ACQUIRE: main nothing to do (waiting on AW starting)");
		break;
	case TEST_WAIT_ACQUIRE_FAIL:
		emscripten_out("TEST_WAIT_ACQUIRE_FAIL: main nothing to do");
		break;
	case TEST_WAIT_ACQUIRE:
		if (!waitAcquireUnlocked) {
			// Release here to acquire in process()
			emscripten_out("TEST_WAIT_ACQUIRE: main releasing lock");
			emscripten_lock_release(&testLock);
			emscripten_out("TEST_WAIT_ACQUIRE: main released");
			waitAcquireUnlocked = true;
		} else {
			emscripten_out("TEST_WAIT_ACQUIRE: main already unlocked");
		}
		break;
	case TEST_RELEASE:
		emscripten_out("TEST_RELEASE: main nothing to do");
		break;
	default:
		// Finished, exit from the main thread
		timeTook = emscripten_get_now() - startTime;
		emscripten_outf("TEST_DONE: %dms (expect: > 100)", (int) timeTook);
		runAgain = false;
		doExit();
	}
	emscripten_out("*** exit mainLoop()");
	return runAgain;
}

void workletCreated(EMSCRIPTEN_WEBAUDIO_T audioContext, bool success, void *userData) {
	int outputChannelCounts[1] = { 1 };
	EmscriptenAudioWorkletNodeCreateOptions options = {
		.numberOfInputs = 0,
		.numberOfOutputs = 1,
		.outputChannelCounts = outputChannelCounts
	};
	EMSCRIPTEN_AUDIO_WORKLET_NODE_T workletNode = emscripten_create_wasm_audio_worklet_node(audioContext, "locks-test", &options, &process, NULL);
	emscripten_audio_node_connect(workletNode, audioContext, 0, 0);
}

void workletInited(EMSCRIPTEN_WEBAUDIO_T audioContext, bool success, void *userData) {
	WebAudioWorkletProcessorCreateOptions opts = {
		.name = "locks-test"
	};
	emscripten_create_wasm_audio_worklet_processor_async(audioContext, &opts, workletCreated, NULL);
}

EM_JS(void, addButton, (EMSCRIPTEN_WEBAUDIO_T ctx), {
	var button = document.createElement('button');
	button.innerHTML = "Start Test";
	document.body.appendChild(button);

	ctx = emscriptenGetAudioObject(ctx);
	button.onclick = () => {
		ctx.resume();
		document.body.removeChild(button);
	};
});

uint8_t wasmAudioWorkletStack[2048];

int main() {
	if (audioContext) {
		emscripten_out("This was designed to run once, reload the page");
		return 0;
	}
	/*
	 * The basics: do locks work?
	 */
	emscripten_lock_init(&testLock);
	int hasLock = emscripten_lock_busyspin_wait_acquire(&testLock, 0);
	assert(hasLock);
	/*
	 * Then prepare to run,
	 */
	emscripten_atomic_store_u32(&whichTest, TEST_LOADING);
	startTime = emscripten_get_now();
	/*
	 * Audio worklet creation (which differs massively from the JS version).
	 */
	audioContext = emscripten_create_audio_context(NULL);
	assert(audioContext);
	addButton(audioContext);
	emscripten_start_wasm_audio_worklet_thread_async(audioContext, wasmAudioWorkletStack, sizeof(wasmAudioWorkletStack), workletInited, NULL);
	/*
	 * Timout callback every 10ms.
	 */
	emscripten_set_timeout_loop(mainLoop, 10, NULL);
	emscripten_exit_with_live_runtime();
	return 0;
}
