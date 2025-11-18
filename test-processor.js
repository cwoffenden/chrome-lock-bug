import {
	assert,
	emscripten_get_now,
	emscripten_atomic_cas_u32,
	emscripten_atomic_load_u32,
	emscripten_atomic_store_u32,
	emscripten_lock_init,
	emscripten_lock_busyspin_wait_acquire,
	emscripten_lock_try_acquire,
	emscripten_lock_release
} from "./emscripten-api.js";

class TestProcessor extends AudioWorkletProcessor {
	constructor(args) {
		super();
		if (args && args.processorOptions) {
			for (var opt in args.processorOptions) {
				globalThis[opt] = args.processorOptions[opt];
			}
			emscripten_atomic_store_u32(whichTest, Test.TEST_NOT_STARTED);
		}
		this.port.onmessage = (e) => {
			console.log(e.data);
		};
	}

	process(inputs, outputs, params) {
		return true;
	}
}

registerProcessor("test-processor", TestProcessor);
