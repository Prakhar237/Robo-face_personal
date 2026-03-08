// public/audio-processor.worklet.js
class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input && input[0]) {
            // Send raw Float32 audio data to the main thread
            this.port.postMessage(input[0]);
        }
        return true; // Keep processor alive
    }
}
registerProcessor('pcm-processor', PCMProcessor);
