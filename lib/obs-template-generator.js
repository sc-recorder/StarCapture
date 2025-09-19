const fs = require('fs').promises;
const path = require('path');

class OBSTemplateGenerator {
    constructor(obsConfigPath) {
        // Always use LOCALAPPDATA for OBS resources
        const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
        this.obsConfigPath = obsConfigPath || path.join(
            localAppData,
            'sc-recorder',
            'resources',
            'obs-studio',
            'config',
            'obs-studio'
        );
    }
    
    // Generate a UUID for OBS sources
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // Generate all OBS configuration files from config
    async generateFromConfig(config) {
        if (!config || !config.settings) {
            throw new Error('Invalid configuration provided');
        }
        
        // Validate required settings
        if (!config.settings.recording.encoder) {
            throw new Error('No encoder specified in configuration. Please configure settings first.');
        }

        console.log('Generating OBS configuration from template...');
        
        // Clean up old files first
        await this.cleanup();
        
        // Generate global configuration files with performance settings
        await this.generateGlobalConfig(config.settings);
        await this.generateUserConfig();
        
        // Generate WebSocket configuration
        const wsConfig = await this.generateWebSocketConfig();
        
        // Generate profile
        await this.generateProfile(config.settings);
        
        // Generate scene collection
        await this.generateSceneCollection(config.settings);
        
        console.log('OBS configuration generated successfully');
        return { success: true, websocket: wsConfig };
    }

    // Clean up existing configuration
    async cleanup() {
        try {
            console.log('Cleaning up OBS configuration...');
            
            // Remove ALL existing profiles to ensure clean state
            const profilesPath = path.join(this.obsConfigPath, 'basic', 'profiles');
            
            try {
                const profiles = await fs.readdir(profilesPath);
                for (const profile of profiles) {
                    const profilePath = path.join(profilesPath, profile);
                    await fs.rm(profilePath, { recursive: true, force: true });
                    console.log(`Removed profile: ${profile}`);
                }
            } catch (e) {
                // Directory might not exist
            }
            
            // Remove ALL scene collections to ensure clean state
            const scenesPath = path.join(this.obsConfigPath, 'basic', 'scenes');
            
            try {
                const scenes = await fs.readdir(scenesPath);
                for (const scene of scenes) {
                    const scenePath = path.join(scenesPath, scene);
                    // Remove both .json and .json.bak files
                    await fs.unlink(scenePath).catch(() => {});
                    console.log(`Removed scene: ${scene}`);
                }
            } catch (e) {
                // Directory might not exist
            }
            
            // Remove global config files to ensure clean state
            const globalPath = path.join(this.obsConfigPath, 'global.ini');
            const userPath = path.join(this.obsConfigPath, 'user.ini');
            await fs.unlink(globalPath).catch(() => {});
            await fs.unlink(userPath).catch(() => {});
            
            console.log('Cleanup complete - ready for fresh configuration');
        } catch (error) {
            console.warn('Cleanup warning:', error.message);
        }
    }

    // Generate profile with settings
    async generateProfile(settings) {
        const profilePath = path.join(this.obsConfigPath, 'basic', 'profiles', 'SC-Recorder');
        const basicIniPath = path.join(profilePath, 'basic.ini');
        const encoderJsonPath = path.join(profilePath, 'recordEncoder.json');

        // Ensure directory exists
        await fs.mkdir(profilePath, { recursive: true });

        // Generate basic.ini content
        const iniContent = this.generateBasicIni(settings);

        // Write basic.ini file
        await fs.writeFile(basicIniPath, iniContent, 'utf8');

        // Generate and write recordEncoder.json for encoder-specific settings
        const encoderConfig = this.generateEncoderJson(settings);
        await fs.writeFile(encoderJsonPath, JSON.stringify(encoderConfig, null, 2), 'utf8');

        // Get actual resolution for logging (from display or resolution settings)
        const width = settings.resolution?.width || settings.display?.width || 'unknown';
        const height = settings.resolution?.height || settings.display?.height || 'unknown';
        console.log(`Generated profile: SC-Recorder (${width}x${height})`);
        console.log(`Generated encoder config with bitrate: ${encoderConfig.bitrate} Kbps`);
    }

    // Generate encoder JSON configuration file
    generateEncoderJson(settings) {
        const { recording = {}, performance = {} } = settings;

        // Calculate the actual bitrate to use
        let bitrate = recording.bitrate || 50000;

        // Get resolution for auto-calculation
        const resolution = settings.resolution || settings.display || { width: 1920, height: 1080 };
        let outputWidth = resolution.width;
        let outputHeight = resolution.height;

        // Apply scaling if specified
        if (resolution.scaleFactor && resolution.scaleFactor !== 1) {
            outputWidth = Math.round((resolution.width * resolution.scaleFactor) / 2) * 2;
            outputHeight = Math.round((resolution.height * resolution.scaleFactor) / 2) * 2;
        }

        // Only auto-calculate if explicitly set to auto mode and not custom profile
        if (performance.bitrateMode === 'auto' && performance.profile && performance.profile !== 'custom') {
            const pixels = outputWidth * outputHeight;
            const fps = recording.framerate || 30;
            const motionFactor = fps / 30;

            const qualityMultipliers = {
                performance: 3,
                balanced: 6,
                quality: 12,
                custom: 10
            };

            const multiplier = qualityMultipliers[performance.profile] || 10;
            bitrate = Math.round((pixels / 1000000) * multiplier * motionFactor * 1000);
        }

        // Base encoder configuration with bitrate
        const encoderConfig = {
            bitrate: bitrate
        };

        // Add encoder-specific settings based on encoder type
        const encoderId = recording.encoderId || recording.encoder || '';
        const profile = performance.profile || 'custom';

        if (encoderId.includes('nvenc')) {
            // NVIDIA NVENC specific settings
            encoderConfig.preset = this.getNvencPreset(profile);
            encoderConfig.rate_control = "CBR";  // Use CBR for consistent quality
            encoderConfig.keyint_sec = 2;
            encoderConfig.bf = profile === 'performance' ? 0 : 2;
            if (profile === 'quality') {
                encoderConfig.psycho_aq = 1;
                encoderConfig.lookahead = true;
            }
        } else if (encoderId.includes('amf')) {
            // AMD AMF specific settings
            const presetMap = {
                performance: "speed",
                balanced: "balanced",
                quality: "quality",
                custom: "balanced"
            };
            encoderConfig.preset = presetMap[profile] || "balanced";
            encoderConfig.rate_control = "CBR";
            if (encoderId.includes('h265') || encoderId.includes('hevc')) {
                encoderConfig.profile = "main";
            } else {
                encoderConfig.profile = "high";
            }
        } else if (encoderId.includes('x264')) {
            // x264 software encoder settings
            const presetMap = {
                performance: "ultrafast",
                balanced: "fast",
                quality: "slow",
                custom: "medium"
            };
            encoderConfig.preset = presetMap[profile] || "medium";
            encoderConfig.rate_control = "CBR";
            encoderConfig.profile = "high";
        }

        return encoderConfig;
    }

    getNvencPreset(profile) {
        const presetMap = {
            performance: "p1",
            balanced: "p4",
            quality: "p7",
            custom: "p5"
        };
        return presetMap[profile] || "p5";
    }

    // Build encoder-specific settings based on performance profile
    buildEncoderSettings(recording, performance, bitrate) {
        const encoderId = recording.encoderId || recording.encoder || '';
        const profile = performance.profile || 'custom';

        // Default settings
        let settings = [];

        // Map performance profiles to encoder presets
        const presetMappings = {
            performance: {
                nvenc: 'p1',      // Fastest preset, lowest quality
                amf: 'speed',     // Speed preset for AMD
                x264: 'ultrafast' // Ultrafast for software encoding
            },
            balanced: {
                nvenc: 'p4',      // Balanced preset
                amf: 'balanced',  // Balanced preset for AMD
                x264: 'fast'      // Fast for software encoding
            },
            quality: {
                nvenc: 'p7',      // Quality preset, highest quality
                amf: 'quality',   // Quality preset for AMD
                x264: 'slow'      // Slow for software encoding
            },
            custom: {
                nvenc: 'p5',      // Default preset
                amf: 'balanced',  // Default for AMD
                x264: 'medium'    // Default for software
            }
        };

        // Determine encoder type and get the proper encoder ID for OBS
        let encoderType = 'unknown';
        let obsEncoderId = encoderId; // Use the actual encoder ID from OBS

        if (encoderId.includes('nvenc') || encoderId.includes('nvidia')) {
            encoderType = 'nvenc';
        } else if (encoderId.includes('amf') || encoderId.includes('amd')) {
            encoderType = 'amf';
        } else if (encoderId.includes('x264') || encoderId.includes('software')) {
            encoderType = 'x264';
        }

        // Apply performance overrides if specified
        const preset = performance.encoderPreset ||
                      (presetMappings[profile] && presetMappings[profile][encoderType]) ||
                      'default';

        const rateControl = performance.rateControl || 'CBR'; // Default to CBR for recording

        // Build encoder-specific configuration in proper INI format
        // Format: RecEncoder<Setting>=<value>
        if (encoderType === 'nvenc') {
            // NVIDIA NVENC settings
            settings.push(`RecEncoderOpt_preset=${preset}`);
            settings.push(`RecEncoderOpt_rate_control=${rateControl.toLowerCase()}`);
            if (rateControl === 'CQP') {
                settings.push(`RecEncoderOpt_cqp=${performance.cqLevel || 23}`);
            }
            settings.push(`RecEncoderOpt_keyint_sec=2`);
            settings.push(`RecEncoderOpt_bf=${profile === 'performance' ? 0 : 2}`);
            settings.push(`RecEncoderOpt_psycho_aq=${profile === 'quality' ? 1 : 0}`);
            settings.push(`RecEncoderOpt_gpu=0`);
            settings.push(`RecEncoderOpt_max_bitrate=${Math.round(bitrate * 1.5)}`);
        } else if (encoderType === 'amf') {
            // AMD AMF H264/H265 settings - these need different keys based on encoder
            if (encoderId.includes('h265') || encoderId.includes('hevc')) {
                // H265/HEVC AMF settings
                settings.push(`HEVC.Preset=${preset}`);
                settings.push(`HEVC.RateControl=${rateControl}`);
                settings.push(`HEVC.Bitrate=${bitrate}`);
                if (rateControl === 'CQP') {
                    settings.push(`HEVC.QP=${performance.cqLevel || 23}`);
                }
                settings.push(`HEVC.KeyframeInterval=${2 * (recording.framerate || 30)}`);
                settings.push(`HEVC.Profile=main`);
                settings.push(`HEVC.MaxBitrate=${Math.round(bitrate * 1.5)}`);
                settings.push(`HEVC.VBVBuffer=${Math.round(bitrate * 2)}`);
            } else {
                // H264 AMF settings
                settings.push(`H264.Preset=${preset}`);
                settings.push(`H264.RateControl=${rateControl}`);
                settings.push(`H264.Bitrate=${bitrate}`);
                if (rateControl === 'CQP') {
                    settings.push(`H264.QP=${performance.cqLevel || 23}`);
                }
                settings.push(`H264.KeyframeInterval=${2 * (recording.framerate || 30)}`);
                settings.push(`H264.Profile=high`);
                settings.push(`H264.MaxBitrate=${Math.round(bitrate * 1.5)}`);
                settings.push(`H264.VBVBuffer=${Math.round(bitrate * 2)}`);
            }
        } else if (encoderType === 'x264') {
            // x264 software encoder settings
            settings.push(`RecEncoderOpt_preset=${preset}`);
            settings.push(`RecEncoderOpt_rate_control=${rateControl.toLowerCase()}`);
            if (rateControl === 'CRF') {
                settings.push(`RecEncoderOpt_crf=${performance.cqLevel || 23}`);
            }
            settings.push(`RecEncoderOpt_keyint_sec=2`);
            settings.push(`RecEncoderOpt_bframes=${profile === 'performance' ? 0 : 2}`);
            settings.push(`RecEncoderOpt_profile=high`);
            settings.push(`RecEncoderOpt_tune=${profile === 'performance' ? 'zerolatency' : 'film'}`);
        }

        return settings;
    }
    
    // Generate basic.ini content
    generateBasicIni(settings) {
        // Validate required settings
        if (!settings) {
            throw new Error('Settings are required for generateBasicIni');
        }
        
        // Get resolution from either resolution settings or display settings
        const width = settings.resolution?.width || settings.display?.width;
        const height = settings.resolution?.height || settings.display?.height;
        
        if (!width || !height) {
            throw new Error('Resolution settings are required (width and height must be available in either resolution or display settings)');
        }
        
        // Create a normalized resolution object
        const resolution = {
            width: width,
            height: height,
            scaleFactor: settings.resolution?.scaleFactor || 1,
            preset: settings.resolution?.preset
        };
        
        const { recording = {}, audio = {}, performance = {} } = settings;
        
        // Apply performance profile settings
        let outputWidth = resolution.width;
        let outputHeight = resolution.height;
        let actualBitrate = recording.bitrate || 50000;

        // Apply resolution scaling if specified
        // Check both performance.resolutionScale and resolution.scaleFactor
        let scaleFactor = 1.0;
        if (resolution.scaleFactor && resolution.scaleFactor !== 1) {
            scaleFactor = resolution.scaleFactor;
        } else if (performance.resolutionScale && performance.resolutionScale !== 'native') {
            scaleFactor = performance.resolutionScale === '75' ? 0.75 : 0.5;
        }

        if (scaleFactor !== 1.0) {
            outputWidth = Math.round((resolution.width * scaleFactor) / 2) * 2;
            outputHeight = Math.round((resolution.height * scaleFactor) / 2) * 2;
            // Ensure minimum resolution
            outputWidth = Math.max(outputWidth, 640);
            outputHeight = Math.max(outputHeight, 360);
        }

        // Apply bitrate mode
        // Only auto-calculate bitrate if bitrateMode is 'auto' AND profile is NOT 'custom'
        if (performance.bitrateMode === 'auto' && performance.profile && performance.profile !== 'custom') {
            // Calculate optimal bitrate based on resolution, fps, and profile
            const pixels = outputWidth * outputHeight;
            const fps = recording.framerate || 30;
            const motionFactor = fps / 30;

            const qualityMultipliers = {
                performance: 3,    // Low bitrate for minimal impact
                balanced: 6,       // Moderate bitrate
                quality: 12,       // High bitrate for best quality
                custom: 10         // Default for custom (shouldn't reach here)
            };

            const multiplier = qualityMultipliers[performance.profile] || 10;
            actualBitrate = Math.round((pixels / 1000000) * multiplier * motionFactor * 1000);

            console.log(`Auto-calculated bitrate: ${actualBitrate} Kbps for ${outputWidth}x${outputHeight} @ ${fps}fps with ${performance.profile} profile`);
        } else {
            // Use the manually set bitrate from quality presets or custom value
            console.log(`Using manual bitrate: ${actualBitrate} Kbps`);
        }
        
        // Determine how many audio sources are enabled
        const voiceEnabled = audio && audio.track2 && audio.track2.enabled;
        const micEnabled = audio && audio.track3 && audio.track3.enabled;
        const totalSources = 1 + (voiceEnabled ? 1 : 0) + (micEnabled ? 1 : 0);

        // Calculate track bitmask based on configuration
        let trackMask = 1; // Track 1 always enabled
        let trackCount = 1;

        if (totalSources > 1) {
            // Multiple sources: Enable tracks for individual sources
            trackMask |= 2; // Track 2 for game audio
            trackCount = 2;

            if (voiceEnabled) {
                trackMask |= 4; // Track 3 for voice
                trackCount = 3;
            }

            if (micEnabled) {
                trackMask |= (voiceEnabled ? 8 : 4); // Track 4 if both, Track 3 if mic only
                trackCount = voiceEnabled && micEnabled ? 4 : 3;
            }
        }
        
        // Ensure output path exists and is properly formatted for OBS (needs double backslashes)
        // Always append 'recordings' subfolder to the output path
        const basePath = recording.outputPath || path.join(process.env.USERPROFILE, 'Videos', 'SC-Recorder');
        const outputPath = path.join(basePath, 'recordings');
        const formattedPath = outputPath.replace(/\\/g, '\\\\');
        
        // Build encoder-specific settings - currently OBS doesn't support these in basic.ini
        // They are configured through the encoder itself, not through INI settings
        // The RecRB (bitrate) setting is what actually controls the bitrate
        // We'll keep this for potential future use but it won't be added to the INI
        const encoderSettingsArray = this.buildEncoderSettings(recording, performance, actualBitrate);
        const encoderSettings = ''; // Disabled for now as OBS doesn't read these from basic.ini

        return `[General]
Name=SC-Recorder

[Video]
BaseCX=${resolution.width}
BaseCY=${resolution.height}
OutputCX=${outputWidth}
OutputCY=${outputHeight}
FPSType=0
FPSCommon=${recording.framerate || 30}
FPSInt=${recording.framerate || 30}
FPSNum=${recording.framerate || 30}
FPSDen=1
ScaleType=bicubic
ColorFormat=NV12
ColorSpace=709
ColorRange=Partial

[Panels]
CookieId=E5F95FDD0838D2B3

[Output]
Mode=Advanced

[AdvOut]
RecType=Standard
RecEncoder=${recording.encoderId || recording.encoder}
RecFilePath=${formattedPath}
RecFormat=mkv
RecTracks=${trackMask}
RecRB=${actualBitrate}
RecUseRescale=${outputWidth !== resolution.width || outputHeight !== resolution.height}
RecRescale=${outputWidth}x${outputHeight}
RecMultitrack=true
RecAudioTrack1Name=${totalSources > 1 ? 'Mixed Audio' : 'Game Audio'}
RecAudioTrack2Name=Game Audio
RecAudioTrack3Name=${voiceEnabled && micEnabled ? 'Voice Chat' : (voiceEnabled ? 'Voice Chat' : 'Microphone')}
RecAudioTrack4Name=Microphone
RecAudioTracks=${trackCount}
VodTrackEnabled=false
RecSplitFile=true
RecSplitFileType=Manual
RecSplitFileTime=30
RecSplitFileSize=2048
RecSplitFileResetTimestamps=true${encoderSettings}

[Audio]
SampleRate=48000
ChannelSetup=Stereo
MeterDecayRate=Fast
PeakMeterType=0

[AudioMixer]
# No desktop audio - only Star Citizen audio capture via scene
`;
    }

    // Generate scene collection
    async generateSceneCollection(settings) {
        const scenePath = path.join(this.obsConfigPath, 'basic', 'scenes', 'SC-Recording.json');
        
        // Ensure directory exists
        const scenesDir = path.dirname(scenePath);
        await fs.mkdir(scenesDir, { recursive: true });
        
        // Generate scene JSON
        const sceneData = this.generateSceneJson(settings);
        
        // Write file
        await fs.writeFile(scenePath, JSON.stringify(sceneData, null, 2), 'utf8');
        console.log('Generated scene collection: SC-Recording');
    }

    // Generate scene JSON structure
    generateSceneJson(settings) {
        // Get resolution from either resolution settings or display settings
        const width = settings.resolution?.width || settings.display?.width || 1920;
        const height = settings.resolution?.height || settings.display?.height || 1080;
        
        const resolution = { width, height };
        const { audio } = settings;
        
        // Create sources array - only include what we want
        const sources = [];
        
        // Scene items for the Star Citizen scene
        const sceneItems = [];
        let itemId = 1;
        
        // Add Game Capture source
        const gameCaptureUuid = this.generateUUID();
        sources.push({
            "enabled": true,
            "flags": 0,
            "hotkeys": {},
            "id": "game_capture",
            "mixers": 0,  // Video only, no audio mixer
            "monitoring_type": 0,
            "muted": false,
            "name": "Game Capture",
            "uuid": gameCaptureUuid,
            "private_settings": {},
            "push-to-mute": false,
            "push-to-mute-delay": 0,
            "push-to-talk": false,
            "push-to-talk-delay": 0,
            "settings": {
                "window": "Star Citizen:CryENGINE:StarCitizen.exe",
                "capture_mode": "window",
                "priority": 2,
                "capture_cursor": true,
                "allow_transparency": false,
                "force_sdr": false,
                "limit_framerate": false,
                "capture_overlays": false,
                "anti_cheat_hook": true,
                "hook_rate": 1
            },
            "sync": 0,
            "versioned_id": "game_capture",
            "volume": 1.0,
            "balance": 0.5,
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "prev_ver": 520093699
        });
        
        // Add Game Capture to scene items
        sceneItems.push({
            "name": "Game Capture",
            "source_uuid": gameCaptureUuid,
            "visible": true,
            "locked": false,
            "rot": 0.0,
            "align": 5,
            "bounds_type": 2,  // Scale to inner bounds
            "bounds_align": 0,
            "bounds_crop": false,
            "crop_left": 0,
            "crop_top": 0,
            "crop_right": 0,
            "crop_bottom": 0,
            "id": itemId++,
            "group_item_backup": false,
            "pos": {
                "x": 0.0,
                "y": 0.0
            },
            "scale": {
                "x": 1.0,
                "y": 1.0
            },
            "bounds": {
                "x": resolution.width,
                "y": resolution.height
            },
            "scale_filter": "disable",
            "blend_method": "default",
            "blend_type": "normal",
            "show_transition": {
                "duration": 0
            },
            "hide_transition": {
                "duration": 0
            },
            "private_settings": {}
        });
        
        // Determine how many audio sources are enabled
        const voiceEnabled = audio && audio.track2 && audio.track2.enabled;
        const micEnabled = audio && audio.track3 && audio.track3.enabled;
        const totalSources = 1 + (voiceEnabled ? 1 : 0) + (micEnabled ? 1 : 0);

        // Add Star Citizen Audio with appropriate track assignment
        const scAudioUuid = this.generateUUID();
        let scAudioMixers = 1; // Always on track 1
        if (totalSources > 1) {
            scAudioMixers |= 2; // Also on track 2 when multiple sources
        }

        sources.push({
            "enabled": true,
            "flags": 0,
            "hotkeys": {},
            "id": "wasapi_process_output_capture",
            "mixers": scAudioMixers,  // Track assignment based on config
            "monitoring_type": 0,
            "muted": false,
            "name": "Star Citizen Audio",
            "uuid": scAudioUuid,
            "private_settings": {},
            "push-to-mute": false,
            "push-to-mute-delay": 0,
            "push-to-talk": false,
            "push-to-talk-delay": 0,
            "settings": {
                "window": "Star Citizen:CryENGINE:StarCitizen.exe",
                "priority": 0
            },
            "sync": 0,
            "versioned_id": "wasapi_process_output_capture",
            "volume": 1.0,
            "balance": 0.5,
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "prev_ver": 520093699
        });
        
        // Add Star Citizen Audio to scene items
        sceneItems.push({
            "name": "Star Citizen Audio",
            "source_uuid": scAudioUuid,
            "visible": true,
            "locked": false,
            "rot": 0.0,
            "align": 5,
            "bounds_type": 0,
            "bounds_align": 0,
            "bounds_crop": false,
            "crop_left": 0,
            "crop_top": 0,
            "crop_right": 0,
            "crop_bottom": 0,
            "id": itemId++,
            "group_item_backup": false,
            "pos": {
                "x": 0.0,
                "y": 0.0
            },
            "scale": {
                "x": 1.0,
                "y": 1.0
            },
            "bounds": {
                "x": 0.0,
                "y": 0.0
            },
            "scale_filter": "disable",
            "blend_method": "default",
            "blend_type": "normal",
            "show_transition": {
                "duration": 0
            },
            "hide_transition": {
                "duration": 0
            },
            "private_settings": {}
        });
        
        // Add track 2 if configured (Voice Application)
        if (voiceEnabled) {
            const track2Uuid = this.generateUUID();
            const track2Type = audio.track2.type || 'device';

            // Determine track assignment for voice
            let voiceMixers = 0;
            if (totalSources === 1) {
                // Single source mode - voice only on track 1
                voiceMixers = 1;
            } else {
                // Multiple sources - voice on track 1 (mixed) and track 3
                voiceMixers = 1 | 4; // Track 1 and Track 3
            }

            const track2Source = {
                "prev_ver": 520159234,
                "name": "Voice Application",
                "uuid": track2Uuid,
                "id": "",  // Will be set based on type
                "versioned_id": "",  // Will be set based on type
                "settings": {},  // Will be set based on type
                "mixers": voiceMixers, // Dynamic track assignment
                "sync": 0,
                "flags": 0,
                "volume": 1.0,
                "balance": 0.5,
                "enabled": true,
                "muted": false,
                "push-to-mute": false,
                "push-to-mute-delay": 0,
                "push-to-talk": false,
                "push-to-talk-delay": 0,
                "hotkeys": {
                    "libobs.mute": [],
                    "libobs.unmute": [],
                    "libobs.push-to-mute": [],
                    "libobs.push-to-talk": []
                },
                "deinterlace_mode": 0,
                "deinterlace_field_order": 0,
                "monitoring_type": 0,
                "private_settings": {}
            };
            
            if (track2Type === 'device') {
                track2Source.id = audio.track2.deviceType === 'input' ? 'wasapi_input_capture' : 'wasapi_output_capture';
                track2Source.versioned_id = track2Source.id;
                track2Source.settings = {
                    "device_id": audio.track2.deviceId || audio.track2.source || 'default'
                };
            } else if (track2Type === 'application') {
                // Application audio capture - use full window class format
                // Format: "AppName:WindowClass:Executable.exe"
                let windowMatch = '';
                
                if (audio.track2.source) {
                    // Check if source already contains the full format (has colons)
                    if (audio.track2.source.includes(':')) {
                        // Source is already in format "Title:WindowClass:Executable"
                        // Split it and replace the unreliable title with a stable name
                        const parts = audio.track2.source.split(':');
                        if (parts.length === 3) {
                            // Extract executable name without .exe for the app name
                            const appName = parts[2].replace('.exe', '').replace('.EXE', '');
                            // Reconstruct with stable app name but preserve window class and executable
                            windowMatch = `${appName}:${parts[1]}:${parts[2]}`;
                        } else {
                            // Malformed, use as-is
                            windowMatch = audio.track2.source;
                        }
                    } else {
                        // Legacy format - just executable name, build full format
                        const exeName = audio.track2.source.endsWith('.exe') ? audio.track2.source : audio.track2.source + '.exe';
                        
                        // Map common voice apps to their window classes
                        if (exeName.toLowerCase() === 'discord.exe') {
                            windowMatch = "Discord:Chrome_WidgetWin_1:Discord.exe";
                        } else if (exeName.toLowerCase() === 'teamspeak3.exe' || exeName.toLowerCase() === 'ts3client_win64.exe') {
                            windowMatch = `TeamSpeak:Qt5QWindowIcon:${exeName}`;
                        } else if (exeName.toLowerCase() === 'steam.exe') {
                            windowMatch = `Steam:vguiPopupWindow:${exeName}`;
                        } else {
                            // Generic format for unknown apps - let OBS try to match by exe
                            const appName = exeName.replace('.exe', '').replace('.EXE', '');
                            windowMatch = `${appName}::${exeName}`;
                        }
                    }
                }
                
                track2Source.id = 'wasapi_process_output_capture';
                track2Source.versioned_id = 'wasapi_process_output_capture';
                track2Source.settings = {
                    "priority": 2,  // Priority 2 for executable matching
                    "window": windowMatch
                };
            }
            
            sources.push(track2Source);
            
            // Add to scene items
            sceneItems.push({
                "name": "Voice Application",
                "source_uuid": track2Uuid,
                "visible": true,
                "locked": false,
                "rot": 0.0,
                "align": 5,
                "bounds_type": 0,
                "bounds_align": 0,
                "bounds_crop": false,
                "crop_left": 0,
                "crop_top": 0,
                "crop_right": 0,
                "crop_bottom": 0,
                "id": sceneItems.length + 1,
                "group_item_backup": false,
                "pos": {
                    "x": 0.0,
                    "y": 0.0
                },
                "scale": {
                    "x": 1.0,
                    "y": 1.0
                },
                "bounds": {
                    "x": 0.0,
                    "y": 0.0
                },
                "scale_filter": "disable",
                "blend_method": "default",
                "blend_type": "normal",
                "show_transition": {
                    "duration": 0
                },
                "hide_transition": {
                    "duration": 0
                },
                "private_settings": {}
            });
        }
        
        // Add track 3 if configured (Microphone)
        if (micEnabled) {
            const track3Uuid = this.generateUUID();
            const track3Type = audio.track3.type || 'device';

            // Determine track assignment for microphone
            let micMixers = 0;
            if (totalSources === 1) {
                // Single source mode - mic only on track 1
                micMixers = 1;
            } else if (voiceEnabled && micEnabled) {
                // Both voice and mic - mic on track 1 (mixed) and track 4
                micMixers = 1 | 8; // Track 1 and Track 4
            } else {
                // Only mic enabled - mic on track 1 (mixed) and track 3
                micMixers = 1 | 4; // Track 1 and Track 3
            }

            const track3Source = {
                "prev_ver": 520159234,
                "name": "Microphone",
                "uuid": track3Uuid,
                "id": "",  // Will be set based on type
                "versioned_id": "",  // Will be set based on type
                "settings": {},  // Will be set based on type
                "mixers": micMixers, // Dynamic track assignment
                "sync": 0,
                "flags": 0,
                "volume": 1.0,
                "balance": 0.5,
                "enabled": true,
                "muted": false,
                "push-to-mute": false,
                "push-to-mute-delay": 0,
                "push-to-talk": false,
                "push-to-talk-delay": 0,
                "hotkeys": {
                    "libobs.mute": [],
                    "libobs.unmute": [],
                    "libobs.push-to-mute": [],
                    "libobs.push-to-talk": []
                },
                "deinterlace_mode": 0,
                "deinterlace_field_order": 0,
                "monitoring_type": 0,
                "private_settings": {}
            };
            
            if (track3Type === 'device') {
                // Microphone is always an input device
                track3Source.id = 'wasapi_input_capture';
                track3Source.versioned_id = 'wasapi_input_capture';
                track3Source.settings = {
                    "device_id": audio.track3.source || audio.track3.deviceId || 'default'
                };
            } else {
                // Fallback for application type (shouldn't happen for microphone)
                track3Source.id = 'wasapi_process_output_capture';
                track3Source.versioned_id = 'wasapi_process_output_capture';
                track3Source.settings = {
                    "window": audio.track3.source || audio.track3.window || ''
                };
            }
            
            sources.push(track3Source);
            
            // Add to scene items
            sceneItems.push({
                "name": "Microphone",
                "source_uuid": track3Uuid,
                "visible": true,
                "locked": false,
                "rot": 0.0,
                "align": 5,
                "bounds_type": 0,
                "bounds_align": 0,
                "bounds_crop": false,
                "crop_left": 0,
                "crop_top": 0,
                "crop_right": 0,
                "crop_bottom": 0,
                "id": sceneItems.length + 1,
                "group_item_backup": false,
                "pos": {
                    "x": 0.0,
                    "y": 0.0
                },
                "scale": {
                    "x": 1.0,
                    "y": 1.0
                },
                "bounds": {
                    "x": 0.0,
                    "y": 0.0
                },
                "scale_filter": "disable",
                "blend_method": "default",
                "blend_type": "normal",
                "show_transition": {
                    "duration": 0
                },
                "hide_transition": {
                    "duration": 0
                },
                "private_settings": {}
            });
        }
        
        // Create the Star Citizen scene with proper items
        const starCitizenScene = {
            "prev_ver": 520093699,
            "name": "Star Citizen",
            "uuid": this.generateUUID(),
            "id": "scene",
            "versioned_id": "scene",
            "settings": {
                "id_counter": itemId,
                "custom_size": false,
                "items": sceneItems
            },
            "mixers": 0,
            "sync": 0,
            "flags": 0,
            "volume": 1.0,
            "balance": 0.5,
            "enabled": true,
            "muted": false,
            "push-to-mute": false,
            "push-to-mute-delay": 0,
            "push-to-talk": false,
            "push-to-talk-delay": 0,
            "hotkeys": {},
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "monitoring_type": 0,
            "private_settings": {}
        };
        
        // Add the scene to sources
        sources.unshift(starCitizenScene);
        
        return {
            "current_program_scene": "Star Citizen",
            "current_scene": "Star Citizen",
            "current_transition": "Fade",
            "groups": [],
            "modules": {},
            "name": "SC-Recording",
            "preview_locked": false,
            "quick_transitions": [],
            "saved_projectors": [],
            "scaling_enabled": false,
            "scaling_level": 0,
            "scaling_off_x": 0.0,
            "scaling_off_y": 0.0,
            "scene_order": [
                {
                    "name": "Star Citizen"
                }
            ],
            "sources": sources,
            "transition_duration": 300,
            "transitions": [],
            "resolution": {
                "x": resolution.width,
                "y": resolution.height
            },
            "version": 1
        };
    }

    // Generate global.ini configuration
    async generateGlobalConfig(settings = {}) {
        const globalPath = path.join(this.obsConfigPath, 'global.ini');
        
        // Determine process priority based on performance settings
        let processPriority = 'Normal';
        if (settings.performance) {
            if (settings.performance.processPriority) {
                processPriority = settings.performance.processPriority;
            } else if (settings.performance.profile) {
                // Map performance profiles to process priority
                const priorityMap = {
                    performance: 'BelowNormal',
                    balanced: 'Normal',
                    quality: 'AboveNormal',
                    custom: 'Normal'
                };
                processPriority = priorityMap[settings.performance.profile] || 'Normal';
            }
        }
        
        const globalContent = `[General]
Pre31Migrated=true
MaxLogs=10
InfoIncrement=-1
ProcessPriority=${processPriority}
EnableAutoUpdates=false
BrowserHWAccel=true
FirstRun=false
LastVersion=520093699

[Video]
Renderer=Direct3D 11

[Audio]
DisableAudioDucking=true

[Locations]
Configuration=../../config
SceneCollections=../../config
Profiles=../../config
`;
        
        // Add UTF-8 BOM for OBS compatibility
        await fs.writeFile(globalPath, '\ufeff' + globalContent, 'utf8');
        console.log(`Generated global.ini with process priority: ${processPriority}`);
    }
    
    // Generate user.ini configuration
    async generateUserConfig() {
        const userPath = path.join(this.obsConfigPath, 'user.ini');
        
        const userContent = `[General]
Pre19Defaults=false
Pre21Defaults=false
Pre23Defaults=false
Pre24.1Defaults=false
ConfirmOnExit=false
HotkeyFocusType=NeverDisableHotkeys
FirstRun=false

[BasicWindow]
PreviewEnabled=false
PreviewProgramMode=false
SceneDuplicationMode=true
SwapScenesMode=true
SnappingEnabled=true
ScreenSnapping=true
SourceSnapping=true
CenterSnapping=false
SnapDistance=10
SpacingHelpersEnabled=true
RecordWhenStreaming=false
KeepRecordingWhenStreamStops=false
SysTrayEnabled=true
SysTrayWhenStarted=true
SaveProjectors=false
ShowTransitions=true
ShowListboxToolbars=true
ShowStatusBar=true
ShowSourceIcons=true
ShowContextToolbars=true
StudioModeLabels=true
VerticalVolControl=false
MultiviewMouseSwitch=true
MultiviewDrawNames=true
MultiviewDrawAreas=true
MediaControlsCountdownTimer=true
AlwaysOnTop=false
EditPropertiesMode=false
DocksLocked=false
SideDocks=false

[Basic]
Profile=SC-Recorder
ProfileDir=SC-Recorder
SceneCollection=SC-Recording
SceneCollectionFile=SC-Recording
ConfigOnNewProfile=false
`;
        
        // Add UTF-8 BOM for OBS compatibility
        await fs.writeFile(userPath, '\ufeff' + userContent, 'utf8');
        console.log('Generated user.ini');
    }
    
    // Generate WebSocket configuration
    async generateWebSocketConfig(port = 4455, password = 'screcorder123') {
        const wsDir = path.join(this.obsConfigPath, 'plugin_config', 'obs-websocket');
        const wsPath = path.join(wsDir, 'config.json');
        
        // Ensure directory exists
        await fs.mkdir(wsDir, { recursive: true });
        
        const wsConfig = {
            alerts_enabled: false,
            auth_required: true,
            first_load: false,
            server_enabled: true,
            server_password: password,
            server_port: port
        };
        
        await fs.writeFile(wsPath, JSON.stringify(wsConfig, null, 2), 'utf8');
        console.log('Generated WebSocket config');
        
        return { port, password };
    }

    // Check if templates need regeneration
    async needsRegeneration(config) {
        try {
            // Check if profile exists
            const profilePath = path.join(this.obsConfigPath, 'basic', 'profiles', 'SC-Recorder', 'basic.ini');
            await fs.access(profilePath);
            
            // Check if scene exists
            const scenePath = path.join(this.obsConfigPath, 'basic', 'scenes', 'SC-Recording.json');
            await fs.access(scenePath);
            
            // Check if global config exists
            const globalPath = path.join(this.obsConfigPath, 'global.ini');
            await fs.access(globalPath);
            
            // Check if user config exists
            const userPath = path.join(this.obsConfigPath, 'user.ini');
            await fs.access(userPath);
            
            return false;
        } catch {
            return true;
        }
    }
}

module.exports = OBSTemplateGenerator;