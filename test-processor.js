class TestProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
	}

	process(inputs, outputs, params) {
		console.log("Here!");
		return true;
	}
}

registerProcessor("test-processor", TestProcessor);
