/**
 * Audio Decoder Worker
 * Handles audio decoding in a separate thread to prevent main thread blocking
 * Note: Web Workers don't have access to Web Audio API, so we pass the decoding back to main thread
 */

// Handle decode requests
self.onmessage = async (e) => {
    const { arrayBuffer, id, trackLabel } = e.data;

    console.log(`[AudioDecoderWorker] Received request to process ${trackLabel} (${arrayBuffer.byteLength} bytes)`);

    try {
        // Send initial progress
        self.postMessage({
            type: 'progress',
            id,
            message: `Preparing ${trackLabel} for decoding...`,
            progress: 0.1
        });

        // Since we can't actually decode in the worker (no Web Audio API access),
        // we'll pass the data back to the main thread for decoding
        // But we can still offload some processing and provide progress updates

        // Check if this looks like a valid audio file
        const view = new DataView(arrayBuffer);
        let isValid = false;

        // Check for WAV header
        if (view.byteLength > 4) {
            const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
            if (riff === 'RIFF') {
                isValid = true;
                console.log(`[AudioDecoderWorker] Detected WAV file format`);
            }
        }

        // Check for other common audio formats (simplified check)
        if (!isValid && view.byteLength > 4) {
            // Check for MP3 (ID3 or MPEG sync)
            if ((view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) || // ID3
                (view.getUint8(0) === 0xFF && (view.getUint8(1) & 0xE0) === 0xE0)) { // MPEG sync
                isValid = true;
                console.log(`[AudioDecoderWorker] Detected MP3 file format`);
            }
        }

        if (!isValid) {
            console.warn(`[AudioDecoderWorker] Could not verify audio format, attempting decode anyway`);
        }

        // Send progress update
        self.postMessage({
            type: 'progress',
            id,
            message: `Processing ${trackLabel}...`,
            progress: 0.5
        });

        // Since we can't decode here, we'll send the buffer back for main thread decoding
        // But mark it as needing decode
        self.postMessage({
            type: 'needsDecode',
            id,
            arrayBuffer: arrayBuffer,
            trackLabel: trackLabel
        }, [arrayBuffer]); // Transfer the buffer back

        console.log(`[AudioDecoderWorker] Sent buffer back for main thread decoding`);

    } catch (error) {
        console.error(`[AudioDecoderWorker] Failed to process audio:`, error);

        self.postMessage({
            type: 'error',
            id,
            success: false,
            error: error.message || error
        });
    }
};

// Handle errors in the worker
self.onerror = (error) => {
    console.error('[AudioDecoderWorker] Worker error:', error);
    self.postMessage({
        type: 'error',
        id: 'unknown',
        success: false,
        error: `Worker error: ${error.message || error}`
    });
};

console.log('[AudioDecoderWorker] Worker initialized and ready');