#include <emscripten/wasm_worker.h>
#include <emscripten/webaudio.h>
#include <assert.h>

// Build with emcc -sAUDIO_WORKLET -sWASM_WORKERS -sNO_EXIT_RUNTIME --shell-file=shell.html -pthread -O1 -g -o index.html lock-bug.c

// Internal, found in 'system/lib/pthread/threading_internal.h' (and requires building with -pthread)
int _emscripten_thread_supports_atomics_wait(void);

// Marks a function to be kept in the Module and exposed to script (instead of adding to EXPORTED_FUNCTIONS)
#ifndef KEEP_IN_MODULE
#define KEEP_IN_MODULE __attribute__((used, visibility("default")))
#endif

typedef enum {
	TEST_LOADING,           // The page is still loading
	TEST_NOT_STARTED,       // The test hasn't yet started
	TEST_TRY_ACQUIRE,       // Acquired in main, fail in process()
	TEST_WAIT_ACQUIRE_FAIL, // Keep acquired so time-out
	TEST_WAIT_ACQUIRE,      // Release in main, succeed in process()
	TEST_RELEASE,           // Release in process() after above
	TEST_DONE               // Test finished
} Test;

typedef enum {
	BROWSER_UNKNOWN = 0, // Unknown or unable to determine
	BROWSER_FIREFOX = 1, // Firefox (plus Firefox-derived, such as Iceweasel)
	BROWSER_CHROME  = 2, // Chrome (desktop, Chromebook and mobile, plus Chrome-derived, such as Opera)
	BROWSER_SAFARI  = 3, // Safari (desktop and mobile)
	BROWSER_IE      = 4, // IE11 (and earlier if WebGL is not required)
	BROWSER_EDGE    = 5, // Edge (the original pre-2019 legacy Edge)
} Browser;

// Style for the mainLoop log (magenta)
const char* STYLE_MAIN = "\x1B[95m";
// Style for the process() log (green)
const char* STYLE_PROC = "\x1B[32m\t";

// Lock used in all the tests (pointer to have parity with the JS code)
emscripten_lock_t* const testLock = &(emscripten_lock_t){};
// Which test is running (sometimes in the worklet, sometimes in the main thread)
Test* const whichTest = &(Test){};

// Time at which the test starts taken in runTest()
double startTime = 0;
// Has TEST_WAIT_ACQUIRE unlocked testLock?
bool waitAcquireUnlocked = false;
// How many runs through has this done?
unsigned runCount = 0;

// Global audio context
EMSCRIPTEN_WEBAUDIO_T audioContext = 0;
// AudioWorkletNode attached to the audio context (to query or post a message)
EMSCRIPTEN_AUDIO_WORKLET_NODE_T workletNode = 0;
// AW stack
char* workletStack[1024];

// Borrowed from Xplat (overkill but the order counts)
EM_JS(Browser, getBrowser, (), {
	if (navigator) {
		var ua = String(navigator.userAgent);
		if (/Firefox\\\\/\\\\d+\\\\.\\\\d+/.test(ua)) {
			return /*BROWSER_FIREFOX*/ 1;
		} else {
			if (/Edge\\\\/\\\\d+\\\\.\\\\d+/.test(ua)) {
				return /*BROWSER_EDGE*/ 5;
			} else {
				if (/^((?!Chrome).)*Safari\\\\/\\\\d+\\\\.\\\\d+/.test(ua)) {
					return /*BROWSER_SAFARI*/ 3;
				} else {
					if (/Chrome\\\\/\\\\d+\\\\.\\\\d+/.test(ua)) {
						return /*BROWSER_CHROME*/ 2;
					} else {
						if (/Trident\\\\/\\\\d+\\\\.\\\\d+/.test(ua)) {
							return /*BROWSER_IE*/ 4;
						}
					}
				}
			}
		}
	}
	return /*BROWSER_UNKNOWN*/ 0;
});

// Missing from console.h
EM_JS(void, console_clear, (), {
	console.clear();
});

// AW callback (called approx 375x per second)
bool process(int numInputs, const AudioSampleFrame *inputs, int numOutputs, AudioSampleFrame *outputs, int numParams, const AudioParamFrame *params, void *userData) {
	emscripten_outf("%s*** enter process()", STYLE_PROC);
	bool runAgain = true;
	int result;
	double waitMs;
	switch (emscripten_atomic_load_u32(whichTest)) {
	case TEST_LOADING:
		assert(emscripten_current_thread_is_audio_worklet()
			&& !_emscripten_thread_supports_atomics_wait());
		// AWP has been loaded, tell the main thread
		emscripten_outf("%sTEST_LOADING (is AW: %d, has wait: %d, expect: 1 & 0)",
			STYLE_PROC, emscripten_current_thread_is_audio_worklet(),
				_emscripten_thread_supports_atomics_wait());
		emscripten_atomic_store_u32(whichTest, TEST_NOT_STARTED);
		break;
	case TEST_NOT_STARTED:
		// Waiting on the main thread to acknowledge
		emscripten_outf("%sTEST_NOT_STARTED (may spam a lot)", STYLE_PROC);
		break;
	case TEST_TRY_ACQUIRE:
		// Was locked after init, should fail to acquire
		result = emscripten_lock_try_acquire(testLock);
		emscripten_outf("%sTEST_TRY_ACQUIRE: %d (expect: 0)", STYLE_PROC, result);
		assert(!result);
		emscripten_atomic_store_u32(whichTest, TEST_WAIT_ACQUIRE_FAIL);
		break;
	case TEST_WAIT_ACQUIRE_FAIL:
		// Still locked so we fail to acquire
		emscripten_outf("%sTEST_WAIT_ACQUIRE_FAIL: spin for 100ms (count 'em!)", STYLE_PROC);
		waitMs = emscripten_get_now();
		result = emscripten_lock_busyspin_wait_acquire(testLock, 100);
		waitMs = emscripten_get_now() - waitMs;
		emscripten_outf("%sTEST_WAIT_ACQUIRE_FAIL: %d (expect: 0, spinning for %dms)", STYLE_PROC, result, (int) waitMs);
		assert(!result);
		emscripten_atomic_store_u32(whichTest, TEST_WAIT_ACQUIRE);
		/*
		 * Fall through here so the main has a chance to unlock whilst
		 * spinning (otherwise the lock has a chance to be released before
		 * spinning).
		 */
	case TEST_WAIT_ACQUIRE:
		// Will get unlocked in the main, so should quickly acquire
		emscripten_outf("%sTEST_WAIT_ACQUIRE: start spinning!", STYLE_PROC);
		waitMs = emscripten_get_now();
		result = emscripten_lock_busyspin_wait_acquire(testLock, 1000);
		waitMs = emscripten_get_now() - waitMs;
		emscripten_outf("%sTEST_WAIT_ACQUIRE: %d (expect: 1, spinning for %dms)", STYLE_PROC, result, (int) waitMs);
		// Assert after, since this is where it can fail and kill the callback
		emscripten_atomic_store_u32(whichTest, (result) ? TEST_RELEASE : TEST_DONE);
		assert(result);
		break;
	case TEST_RELEASE:
		// Unlock, check the result
		emscripten_outf("%sTEST_RELEASE: unlocking", STYLE_PROC);
		emscripten_lock_release(testLock);
		result = emscripten_lock_try_acquire(testLock);
		emscripten_outf("%sTEST_RELEASE: %d (expect: 1)", STYLE_PROC, result);
		assert(result);
		emscripten_atomic_store_u32(whichTest, TEST_NOT_STARTED);
		break;
	default:
		// Finished, exit from the audio thread
		emscripten_outf("%sTEST_DONE in process", STYLE_PROC);
		runAgain = false;
	}
	emscripten_outf("%s*** exit process()", STYLE_PROC);
	return runAgain;
}

// Called every 10ms-ish using a timeout
bool mainLoop(double time, void* data) {
	emscripten_outf("%s*** enter mainLoop()", STYLE_MAIN);
	bool runAgain = true;
	switch (emscripten_atomic_load_u32(whichTest)) {
	case TEST_LOADING:
		// Wait until the AudioWorkletProcessor (AWP) has loaded
		emscripten_outf("%sTEST_LOADING: Still loading", STYLE_MAIN);
		break;
	case TEST_NOT_STARTED:
		assert(!emscripten_current_thread_is_audio_worklet()
			&& !_emscripten_thread_supports_atomics_wait());
		// Periodically clear the console (it gets sluggish otherwise)
		if (runCount > 0 && (runCount & 63) == 0) {
			console_clear();
		}
		// The AWP has loaded, so move to the first test
		emscripten_outf("%sTEST_NOT_STARTED: Staring test (is AW: %d, has wait: %d, expect 0 & 0)",
			STYLE_MAIN, emscripten_current_thread_is_audio_worklet(),
				_emscripten_thread_supports_atomics_wait());
		waitAcquireUnlocked = false;
		emscripten_atomic_store_u32(whichTest, TEST_TRY_ACQUIRE);
		break;
	case TEST_TRY_ACQUIRE:
		emscripten_outf("%sTEST_TRY_ACQUIRE: main nothing to do (waiting on AW starting)", STYLE_MAIN);
		break;
	case TEST_WAIT_ACQUIRE_FAIL:
		emscripten_outf("%sTEST_WAIT_ACQUIRE_FAIL: main waiting out 100ms", STYLE_MAIN);
		break;
	case TEST_WAIT_ACQUIRE:
		if (!waitAcquireUnlocked) {
			// Release here to acquire in process()
			emscripten_outf("%sTEST_WAIT_ACQUIRE: main releasing lock", STYLE_MAIN);
			emscripten_lock_release(testLock);
			emscripten_outf("%sTEST_WAIT_ACQUIRE: main lock released", STYLE_MAIN);
			waitAcquireUnlocked = true;
			runCount++;
		} else {
			emscripten_outf("%sTEST_WAIT_ACQUIRE: main already unlocked", STYLE_MAIN);
		}
		break;
	case TEST_RELEASE:
		emscripten_outf("%sTEST_RELEASE: main nothing to do", STYLE_MAIN);
		break;
	default:
		// Finished, exit from the main thread
		emscripten_outf("%sTEST_DONE: %dms (expect: > 100, runs: %d)", STYLE_MAIN,
			(int) (emscripten_get_now() - startTime), runCount);
		runAgain = false;
	}
	emscripten_outf("%s*** exit mainLoop()", STYLE_MAIN);
	return runAgain;
}

// Boilerplate AW creation #2
void workletCreated(EMSCRIPTEN_WEBAUDIO_T audioContext, bool success, void *userData) {
	if (workletNode) {
		emscripten_out("Already created");
		return;
	}
	int outputChannelCounts[1] = { 1 };
	EmscriptenAudioWorkletNodeCreateOptions options = {
		.numberOfOutputs = 1,
		.outputChannelCounts = outputChannelCounts
	};
	workletNode = emscripten_create_wasm_audio_worklet_node(audioContext, "locks-test", &options, &process, NULL);
	emscripten_audio_node_connect(workletNode, audioContext, 0, 0);
}

// Boilerplate AW creation #1
void workletInited(EMSCRIPTEN_WEBAUDIO_T audioContext, bool success, void *userData) {
	WebAudioWorkletProcessorCreateOptions opts = {
		.name = "locks-test"
	};
	emscripten_create_wasm_audio_worklet_processor_async(audioContext, &opts, workletCreated, NULL);
}

// Called on the button click
KEEP_IN_MODULE void runTest() {
	if (audioContext) {
		emscripten_out("This was designed to run once, reload the page");
		return;
	}
	if (getBrowser() != BROWSER_CHROME) {
		// No ANSI colours if this isn't Chrome
		STYLE_MAIN = "";
		STYLE_PROC = "\t";
	}
	/*
	 * The basics: do locks work?
	 */
	emscripten_lock_init(testLock);
	int hasLock = emscripten_lock_busyspin_wait_acquire(testLock, 0);
	assert(hasLock);
	/*
	 * Then prepare to run,
	 */
	emscripten_atomic_store_u32(whichTest, TEST_LOADING);
	startTime = emscripten_get_now();
	/*
	 * Audio worklet creation (which differs massively from the JS version).
	 */
	audioContext = emscripten_create_audio_context(NULL);
	assert(audioContext);
	emscripten_start_wasm_audio_worklet_thread_async(audioContext, workletStack, sizeof(workletStack), workletInited, NULL);
	/*
	 * Timout callback every 10ms.
	 */
	emscripten_set_timeout_loop(mainLoop, 10, NULL);
}

// Very dirty stop (mostly to read the log)
KEEP_IN_MODULE void stopTest() {
	emscripten_out("Stopping test, ignore any errors");
	emscripten_atomic_store_u32(whichTest, TEST_DONE);
}

// Adds the same UI to the page as the JS version
EM_JS(void, addUI, (), {
	var label = document.createElement("p");
	label.appendChild(document.createTextNode("Click to start the test, results are in the console."));
	document.body.appendChild(label);
	var button1 = document.createElement("button");
	button1.appendChild(document.createTextNode("Start Test"));
	button1.onclick = () => {
		if (globalThis._runTest) {
			_runTest();
		}
	};
	document.body.appendChild(button1);
	var button2 = document.createElement("button");
	button2.appendChild(document.createTextNode("Stop Test"));
	button2.onclick = () => {
		if (globalThis._stopTest) {
			_stopTest();
		}
	};
	document.body.appendChild(button2);
});

int main() {
	addUI();
	return 0;
}
