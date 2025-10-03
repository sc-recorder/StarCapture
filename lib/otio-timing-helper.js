class OTIOTimingHelper {

    /**
     * Parse timecode string to seconds (e.g., "00:00:05.807" -> 5.807)
     */
    static parseTimecode(timecodeString) {
        if (!timecodeString || timecodeString === '--') {
            return 0;
        }

        // Handle "HH:MM:SS.sss" format
        const parts = timecodeString.split(':');
        if (parts.length === 3) {
            const [hours, minutes, seconds] = parts;
            const [wholeSeconds, milliseconds] = seconds.split('.');

            const totalSeconds =
                parseInt(hours) * 3600 +
                parseInt(minutes) * 60 +
                parseFloat(wholeSeconds) +
                (parseFloat(milliseconds || '0') / 1000);

            return totalSeconds;
        }

        // Fallback: try parsing as float
        return parseFloat(timecodeString) || 0;
    }

    /**
     * Format duration in seconds to timecode string
     */
    static formatDuration(seconds) {
        if (!seconds || seconds <= 0) return "00:00:00.000";

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        const milliseconds = Math.floor((secs % 1) * 1000);

        const wholeSeconds = Math.floor(secs);
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${wholeSeconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
    }

    /**
     * Create OTIO RationalTime for given seconds and frame rate
     */
    static createRationalTime(seconds, frameRate = 30) {
        // value should be the frame number, so multiply by frame rate
        const frameValue = Math.round(seconds * frameRate);

        return {
            "OTIO_SCHEMA": "RationalTime.1",
            "rate": frameRate,
            "value": frameValue
        };
    }

    /**
     * Create OTIO TimeRange for start/duration
     */
    static createTimeRange(startSeconds, durationSeconds, frameRate = 30) {
        return {
            "OTIO_SCHEMA": "TimeRange.1",
            "duration": this.createRationalTime(durationSeconds, frameRate),
            "start_time": this.createRationalTime(startSeconds, frameRate)
        };
    }

    /**
     * Convert frame number back to seconds
     */
    static frameToSeconds(frame, frameRate = 30) {
        return frame / frameRate;
    }

    /**
     * Validate timecode format
     */
    static isValidTimecode(timecode) {
        const pattern = /^\d{2}:\d{2}:\d{2}(\.\d{3})?$/;
        return pattern.test(timecode);
    }

    /**
     * Get precise microseconds from timecode for high-precision applications
     */
    static timecodeToMicroseconds(timecode) {
        const seconds = this.parseTimecode(timecode);
        return Math.round(seconds * 1000000); // microseconds
    }
}

module.exports = OTIOTimingHelper;
