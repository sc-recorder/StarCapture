const OTIOTimingHelper = require('./otio-timing-helper');
const VideoMetadataReader = require('./video-metadata-reader');
const OTIOConfigLoader = require('./otio-config-loader');

class OTIOExporter {

    constructor(options = {}) {
        // Merge provided options with config settings
        this.settings = options;

        // Initialize dependencies
        this.videoMetadataReader = new VideoMetadataReader();

        // Set default frame rate
        this.frameRate = this.settings.frameRate || 30;
    }

    /**
     * Main export function - converts events to OTIO timeline
     */
    async exportEventsToOTIO(events, filterMetadata = null, videoPath = null) {
        try {
            // Auto-detect frame rate from video if configured
            let actualFrameRate = await this.resolveFrameRate(videoPath);
            this.frameRate = actualFrameRate;

            console.log(`Exporting ${events.length} events to OTIO at ${actualFrameRate} fps`);

            // Create OTIO timeline structure
            const otioData = this.createOTIOTimeline(events, filterMetadata, actualFrameRate);

            // Convert events to clips
            const clips = this.convertEventsToClips(events, actualFrameRate, videoPath);
            otioData.tracks.children[0].children = clips;

            return otioData;

        } catch (error) {
            console.error('Error during OTIO export:', error);
            throw error;
        }
    }

    /**
     * Resolve the frame rate to use (auto-detect or fixed)
     */
    async resolveFrameRate(videoPath) {
        if (this.settings.frameRate === 'auto' && videoPath) {
            try {
                return await this.videoMetadataReader.detectVideoFramerate(videoPath);
            } catch (error) {
                console.warn('Could not auto-detect framerate, using 30fps:', error.message);
                return 30;
            }
        }

        // For numeric frame rates or other values
        const rate = parseFloat(this.settings.frameRate);
        return isNaN(rate) ? 30 : rate;
    }

    /**
     * Create the basic OTIO timeline structure
     */
    createOTIOTimeline(events, filterMetadata, frameRate) {
        // Build metadata with Resolve-specific format
        const metadata = {
            "Resolve_OTIO": {
                "Resolve OTIO Meta Version": "1.0"
            }
        };

        return {
            "OTIO_SCHEMA": "Timeline.1",
            "metadata": metadata,
            "name": "",
            "global_start_time": OTIOTimingHelper.createRationalTime(0, frameRate),
            "tracks": {
                "OTIO_SCHEMA": "Stack.1",
                "metadata": {},
                "name": "",
                "source_range": null,
                "effects": [],
                "markers": [],
                "enabled": true,
                "children": [{
                    "OTIO_SCHEMA": "Track.1",
                    "metadata": {
                        "Resolve_OTIO": {
                            "Locked": false
                        }
                    },
                    "name": "Video 1",
                    "source_range": null,
                    "effects": [],
                    "markers": [],
                    "enabled": true,
                    "children": [],
                    "kind": "Video"
                }]
            }
        };
    }

    /**
     * Convert events array to OTIO clips
     * Uses single clip approach with all events as markers
     */
    convertEventsToClips(events, frameRate, videoPath = null) {
        if (!events || !Array.isArray(events)) {
            return [];
        }

        // Calculate total video duration from last event
        const lastEvent = events[events.length - 1];
        const videoDuration = lastEvent ? (lastEvent.videoOffset || 0) + 5 : 10; // Add 5 seconds buffer

        // Create all markers for events
        const markers = events.map(event => 
            this.createEventMarker(event, event.videoOffset || 0, frameRate)
        );

        // Get video filename for clip name
        const clipName = videoPath ? this.getVideoFileName(videoPath) + '.mkv' : "StarCapture Recording";

        // Create single clip with Resolve-compatible structure
        const clip = {
            "OTIO_SCHEMA": "Clip.2",
            "metadata": {
                "Resolve_OTIO": {
                    "Link Group ID": 1
                }
            },
            "name": clipName,
            "source_range": OTIOTimingHelper.createTimeRange(0, videoDuration, frameRate),
            "effects": [],
            "markers": markers,
            "enabled": true,
            "media_references": {
                "DEFAULT_MEDIA": this.createMediaReference(videoPath, videoDuration, frameRate, clipName)
            },
            "active_media_reference_key": "DEFAULT_MEDIA"
        };

        return [clip];
    }

    /**
     * Calculate clip duration based on mode
     */
    calculateClipDuration(currentOffset, nextOffset) {
        const mode = this.settings.clipDurationMode || 'auto';
        const minimalDuration = this.settings.minimalClipDuration || 0.1;
        const fixedDuration = this.settings.fixedClipDuration || 1.0;

        switch (mode) {
            case 'fixed':
                return Math.max(minimalDuration, fixedDuration);

            case 'minimal':
                return minimalDuration;

            case 'auto':
            default:
                // Duration bis zum nächsten Event, mindestens minimal
                const autoDuration = Math.max(minimalDuration, nextOffset - currentOffset);
                return autoDuration;
        }
    }

    /**
     * Get display name for an event
     */
    getEventDisplayName(event) {
        // Priority: name > type > subtype > category > id
        let displayName = event.name ||
                         event.type ||
                         event.subtype ||
                         event.category ||
                         `Event ${event.id}`;

        // Add damage type if available (e.g. "Player Kill - Suicide")
        if (event.data && event.data.damageType) {
            displayName += ` - ${event.data.damageType}`;
        }

        return displayName;
    }

    /**
     * Extract filename from video path
     */
    getVideoFileName(videoPath) {
        if (!videoPath) return "Video";
        const parts = videoPath.replace(/\\/g, '/').split('/');
        return parts[parts.length - 1].replace(/\.[^.]+$/, ''); // Remove extension
    }

    /**
     * Create metadata for a single clip
     */
    createClipMetadata(event) {
        const metadata = {
            "davinciresolve": {
                "event_id": event.id,
                "event_type": event.type,
                "event_subtype": event.subtype,
                "event_category": event.category,
                "severity": event.severity,
                "video_timecode": event.videoTimecode
            }
        };

        // Only include event data if it exists and is not empty
        if (event.data && Object.keys(event.data).length > 0) {
            metadata.starcapture = {
                "message": event.message,
                "data": event.data,
                "timestamp": event.timestamp,
                "original_video_offset": event.videoOffset,
                "formatted_timecode": OTIOTimingHelper.formatDuration(event.videoOffset || 0)
            };
        }

        return metadata;
    }

    /**
     * Create media reference for the video file (Resolve-compatible format)
     */
    createMediaReference(videoPath, duration, frameRate, clipName) {
        if (!videoPath) {
            return {
                "OTIO_SCHEMA": "MissingReference.1",
                "metadata": {},
                "name": clipName || "Missing Media",
                "available_range": null,
                "available_image_bounds": null
            };
        }
        
        return {
            "OTIO_SCHEMA": "ExternalReference.1",
            "metadata": {},
            "name": clipName || "Video",
            "available_range": OTIOTimingHelper.createTimeRange(0, duration, frameRate),
            "available_image_bounds": null,
            "target_url": videoPath
        };
    }

    /**
     * Create a marker for an event (Resolve-compatible format)
     */
    createEventMarker(event, videoOffset, frameRate) {
        // Calculate marker duration as exactly 1 frame (Resolve requirement)
        const markerDuration = 1 / frameRate;
        
        const marker = {
            "OTIO_SCHEMA": "Marker.2",
            "metadata": {
                "Resolve_OTIO": {
                    "Keywords": [
                        event.categoryInfo?.name || event.category || "Event",
                        event.severity
                    ].filter(Boolean), // Remove null/undefined values
                    "Note": event.message || `${event.category} event at ${event.videoTimecode}`
                }
            },
            "name": this.getEventDisplayName(event),
            "color": this.getSeverityColor(event.severity),
            "marked_range": OTIOTimingHelper.createTimeRange(videoOffset, markerDuration, frameRate)
        };

        return marker;
    }

    /**
     * Convert severity to marker color for DaVinci Resolve
     */
    getSeverityColor(severity) {
        const colors = {
            'high': 'RED',
            'medium': 'YELLOW',
            'low': 'GREEN',
            'info': 'BLUE',
            'debug': 'GRAY'
        };
        return colors[severity] || 'WHITE';
    }

    /**
     * Validate that all required settings are present
     */
    validateSettings() {
        const requiredSettings = ['includeFilterMetadata', 'clipDurationMode'];

        for (const setting of requiredSettings) {
            if (!(setting in this.settings)) {
                console.warn(`Missing setting: ${setting}, using default`);
            }
        }
    }

    /**
     * Batch export multiple event sets
     */
    async exportMultiple(sets) {
        const results = [];

        for (const set of sets) {
            const {
                events,
                filterMetadata,
                videoPath,
                presetName,
                outputPath
            } = set;

            // Temporarily update settings for this export
            const originalSettings = { ...this.settings };

            if (presetName) {
                const presetSettings = await OTIOConfigLoader.loadSettings(presetName);
                this.settings = { ...this.settings, ...presetSettings };
            }

            try {
                const otioData = await this.exportEventsToOTIO(events, filterMetadata, videoPath);
                results.push({
                    set: set.name || 'export',
                    otioData,
                    outputPath,
                    success: true
                });
            } catch (error) {
                results.push({
                    set: set.name || 'export',
                    error: error.message,
                    success: false
                });
            }

            // Restore original settings
            this.settings = originalSettings;
        }

        return results;
    }

    /**
     * Get summary of what will be exported
     */
    getExportSummary(events, filterMetadata, videoPath) {
        let frameRate = this.settings.frameRate;
        if (frameRate === 'auto') {
            frameRate = videoPath ? 'auto-detect from video' : '30fps (fallback)';
        }

        return {
            eventCount: events ? events.length : 0,
            frameRate: `${frameRate}`,
            includeFilterMetadata: !!this.settings.includeFilterMetadata,
            clipDurationMode: this.settings.clipDurationMode || 'auto',
            videoPath: videoPath || 'none',
            filterMetadata: filterMetadata ? 'yes' : 'none'
        };
    }
}

module.exports = OTIOExporter;
