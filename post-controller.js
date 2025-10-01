const path = require('path');

/**
 * Post Processing Controller
 * Manages video playback and event timeline interaction
 */
class PostController {
    constructor() {
        this.videoPlayer = document.getElementById('video-player');
        this.videoOverlay = document.getElementById('video-overlay');
        this.timelineEvents = document.getElementById('timeline-events');
        this.timelineCount = document.getElementById('timeline-count');
        this.currentEventDisplay = document.getElementById('current-event-display');
        
        this.events = [];
        this.filteredEvents = [];
        this.excludeFilters = [];
        this.includeFilters = [];
        this.filterOptions = {
            availableFields: [],  // All discovered field paths
            fieldValues: {}       // Map of field -> unique values
        };
        this.currentVideo = null;
        this.currentEventsFile = null;  // Track the current events file path
        this.currentEventIndex = -1;
        this.isPlaying = false;
        this.eventCheckInterval = null;
        this.draggedElement = null;
        this.confirmCallback = null;  // For generic confirm dialog
        this.selectedMainThumbnailEventId = null;  // For tracking selected main thumbnail event

        // Initialize shared video browser with error handling
        try {
            this.videoBrowser = new SharedVideoBrowser({
                modalId: 'post-video-browser-modal',
                onVideoSelected: (video) => this.handleVideoSelected(video)
            });
        } catch (error) {
            console.error('Failed to initialize SharedVideoBrowser:', error);
            this.videoBrowser = null;
        }

        // Get shared upload dialog instance
        this.uploadDialog = null;
        try {
            if (window.getUploadDialog) {
                this.uploadDialog = window.getUploadDialog();
            } else if (window.UploadDialog) {
                // Fallback to creating new instance if getUploadDialog not available
                this.uploadDialog = new window.UploadDialog();
            } else {
                console.error('UploadDialog not found on window');
            }
        } catch (error) {
            console.error('Failed to initialize UploadDialog:', error);
        }

        this.setupEventListeners();
        this.initialize();
    }
    
    /**
     * Initialize the controller
     */
    async initialize() {
        console.log('PostController initialized');
        
        // Load event patterns for filtering
        await this.loadEventPatterns();
        
        // Load filter templates
        await this.refreshTemplateList();
        
        // Check for last recording
        const lastRecording = await this.getLastRecording();
        if (lastRecording) {
        }
    }
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Browser and load buttons
        document.getElementById('browse-recordings-btn')?.addEventListener('click', () => this.showVideoBrowser());
        document.getElementById('load-video-btn')?.addEventListener('click', () => this.loadVideo());
        document.getElementById('load-events-btn')?.addEventListener('click', () => this.loadEvents());
        document.getElementById('save-recording-btn')?.addEventListener('click', () => this.saveRecording());
        document.getElementById('export-clips-btn')?.addEventListener('click', () => this.exportClips());
        document.getElementById('upload-video-btn')?.addEventListener('click', () => this.uploadVideo());
        
        // Modal controls (these are for the old modal, now handled by SharedVideoBrowser)
        // document.getElementById('close-browser-btn')?.addEventListener('click', () => this.hideVideoBrowser());
        // document.getElementById('refresh-browser-btn')?.addEventListener('click', () => this.refreshVideoBrowser());
        
        // Filter controls
        document.getElementById('add-exclude-btn')?.addEventListener('click', () => this.addExcludeFilter());
        document.getElementById('add-include-btn')?.addEventListener('click', () => this.addIncludeFilter());
        document.getElementById('apply-filters-btn')?.addEventListener('click', () => this.applyFilters());
        document.getElementById('clear-filters-btn')?.addEventListener('click', () => this.clearAllFilters());
        document.getElementById('save-filtered-btn')?.addEventListener('click', () => this.saveFilteredEvents());
        document.getElementById('save-template-btn')?.addEventListener('click', () => this.saveFilterTemplate());
        document.getElementById('filter-templates')?.addEventListener('change', (e) => this.loadFilterTemplate(e.target.value));
        document.getElementById('delete-template-btn')?.addEventListener('click', () => this.deleteFilterTemplate());

        // Custom event controls
        document.getElementById('insert-event-btn')?.addEventListener('click', () => this.openCustomEventDialog());

        // Timeline controls
        document.getElementById('zoom-in-btn')?.addEventListener('click', () => this.zoomTimeline(1.5));
        document.getElementById('zoom-out-btn')?.addEventListener('click', () => this.zoomTimeline(0.67));
        document.getElementById('fit-timeline-btn')?.addEventListener('click', () => this.fitTimeline());
        
        // Video player events
        if (this.videoPlayer) {
            this.videoPlayer.addEventListener('loadedmetadata', () => this.onVideoLoaded());
            this.videoPlayer.addEventListener('timeupdate', () => this.onVideoTimeUpdate());
            this.videoPlayer.addEventListener('play', () => this.onVideoPlay());
            this.videoPlayer.addEventListener('pause', () => this.onVideoPause());
            this.videoPlayer.addEventListener('seeked', () => this.onVideoSeeked());
        }
    }
    
    /**
     * Load video file
     */
    async loadVideo() {
        try {
            const result = await ipcRenderer.invoke('show-open-dialog', {
                title: 'Select Video Recording',
                filters: [
                    { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'webm'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile']
            });
            
            if (result && !result.canceled && result.filePaths.length > 0) {
                const videoPath = result.filePaths[0];
                this.loadVideoFile(videoPath);
            }
        } catch (error) {
            console.error('Failed to load video:', error);
        }
    }
    
    /**
     * Load video file by path
     */
    loadVideoFile(videoPath) {

        // Convert path for video element
        const fileUrl = `file://${videoPath.replace(/\\/g, '/')}`;
        this.videoPlayer.src = fileUrl;
        this.currentVideo = videoPath;

        // Enable save button if video is from recordings folder
        const saveBtn = document.getElementById('save-recording-btn');
        if (saveBtn && videoPath.includes('\\recordings\\')) {
            saveBtn.disabled = false;
        }

        // Enable upload button when video is loaded
        const uploadBtn = document.getElementById('upload-video-btn');
        if (uploadBtn) {
            uploadBtn.disabled = false;
        }

        // Hide overlay
        this.videoOverlay.classList.add('hidden');

        // Add error handling for codec issues
        this.videoPlayer.onerror = (e) => {
            console.error('Video playback error:', e);
            const error = this.videoPlayer.error;
            if (error) {
                let errorMsg = '';

                // Check if video source is empty (during file operations)
                if (!this.videoPlayer.src || this.videoPlayer.src === '' || this.videoPlayer.src === 'about:blank') {
                    errorMsg = 'No video loaded';
                } else {
                    // Actual video errors
                    errorMsg = 'Video playback failed: ';
                    switch(error.code) {
                        case error.MEDIA_ERR_ABORTED:
                            errorMsg += 'Playback aborted';
                            break;
                        case error.MEDIA_ERR_NETWORK:
                            errorMsg += 'Network error';
                            break;
                        case error.MEDIA_ERR_DECODE:
                            errorMsg += 'Video decode error (codec may not be supported)';
                            break;
                        case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                            errorMsg += 'Incompatible video format';
                            break;
                        default:
                            errorMsg += 'Unable to play video';
                    }
                }

                console.error(errorMsg, error.message);
                // Show error in overlay
                this.videoOverlay.classList.remove('hidden');
                this.videoOverlay.querySelector('.overlay-message').textContent = errorMsg;
            }
        };

        // Log when video loads successfully
        this.videoPlayer.onloadedmetadata = () => {
        };

        // Try to load corresponding events file
        this.loadEventsForVideo(videoPath);
    }
    
    /**
     * Save recording to saved folder
     */
    async saveRecording() {
        if (!this.currentVideo) {
            this.showAlert('No video loaded');
            return;
        }

        if (!this.currentVideo.includes('\\recordings\\')) {
            this.showAlert('This recording is already saved or edited');
            return;
        }

        // Ask if user wants to generate thumbnails
        const generateThumbnails = await this.confirmGenerateThumbnails();

        // Store original error handler for restoration
        const originalErrorHandler = this.videoPlayer.onerror;

        try {
            // Release video player file handle before moving
            console.log('Releasing video player file handle...');

            // Temporarily disable error handler to prevent spurious error messages
            this.videoPlayer.onerror = null;

            // Hide overlay during file operation
            this.videoOverlay.classList.add('hidden');

            this.videoPlayer.src = '';
            this.videoPlayer.load(); // Force release of file handle

            // Brief delay to ensure file handle is fully released
            await new Promise(resolve => setTimeout(resolve, 200));

            // First, save the recording (move to saved folder)
            const result = await ipcRenderer.invoke('move-recording', this.currentVideo);

            if (result.success) {
                // Update current paths to the new location
                this.currentVideo = result.newPath;
                if (this.currentEventsFile && result.newEventsPath) {
                    this.currentEventsFile = result.newEventsPath;
                }

                // Restore error handler
                this.videoPlayer.onerror = originalErrorHandler;

                // Reload video at new location using the existing loadVideoFile method
                console.log('Reloading video at new location:', result.newPath);
                this.loadVideoFile(result.newPath);

                // Generate thumbnails if user confirmed (after moving to saved folder)
                if (generateThumbnails && this.events.length > 0) {
                    const filteredEvents = this.filteredEvents.length > 0 ? this.filteredEvents : this.events;
                    if (filteredEvents.length > 0) {
                        // Get selected main thumbnail event from timeline
                        const mainEventId = this.getSelectedMainThumbnailEvent();

                        // Show progress modal
                        this.showThumbnailProgress(0, filteredEvents.length);

                        try {
                            const parsed = path.parse(this.currentVideo); // Now using the new saved path
                            const thumbnailFolder = path.join(parsed.dir, `${parsed.name}_thumbs`);

                            // Listen for progress updates
                            ipcRenderer.on('thumbnail-progress', (event, progress) => {
                                this.updateThumbnailProgress(progress);
                            });

                            const thumbnailResult = await ipcRenderer.invoke('generate-thumbnails', {
                                videoPath: this.currentVideo,
                                events: filteredEvents,
                                outputFolder: thumbnailFolder,
                                mainEventId: mainEventId
                            });

                            // Remove progress listener
                            ipcRenderer.removeAllListeners('thumbnail-progress');

                            if (thumbnailResult.success) {
                                // Build thumbnail map for individual event thumbnails
                                const thumbnailMap = {};
                                thumbnailResult.thumbnails.forEach(thumb => {
                                    if (thumb.success) {
                                        thumbnailMap[thumb.eventId] = `${parsed.name}_thumbs/${thumb.eventId}.jpg`;
                                    }
                                });

                                // Update events JSON with thumbnail paths
                                if (this.currentEventsFile) {
                                    await this.updateEventMetadataWithFile(this.currentEventsFile, thumbnailMap, thumbnailResult.mainThumbnail);
                                }

                                this.hideThumbnailProgress();

                                this.showAlert(`Recording saved successfully!<br>Generated ${thumbnailResult.count} thumbnails.`);
                            } else {
                                this.hideThumbnailProgress();
                                console.error(`Thumbnail generation failed: ${thumbnailResult.error}`);
                                this.showAlert('Recording saved successfully!<br>(Thumbnail generation failed)');
                            }
                        } catch (error) {
                            console.error('Thumbnail generation error:', error);
                            ipcRenderer.removeAllListeners('thumbnail-progress');
                            this.hideThumbnailProgress();
                            this.showAlert('Recording saved successfully!<br>(Thumbnail generation failed)');
                        }
                    } else {
                        this.showAlert('Recording saved successfully!');
                    }
                } else {
                    this.showAlert('Recording saved successfully!');
                }

                // Disable save button since it's no longer in recordings folder
                const saveBtn = document.getElementById('save-recording-btn');
                if (saveBtn) {
                    saveBtn.disabled = true;
                }
            } else {
                this.showAlert(`Failed to save recording: ${result.error}`);
            }
        } catch (error) {
            console.error('Failed to save recording:', error);

            // Restore error handler
            this.videoPlayer.onerror = originalErrorHandler;

            this.showAlert('Failed to save recording');
        }
    }

    /**
     * Confirm if user wants to generate thumbnails
     */
    async confirmGenerateThumbnails() {
        return new Promise((resolve) => {
            try {
                // Create custom dialog for Yes/No options
                const title = 'Generate Thumbnails?';
                const message = 'Would you like to generate thumbnails for the events in this video?<br><br>This will create preview images for each event and a main thumbnail for the video.';

                const confirmTitle = document.getElementById('confirm-title');
                const confirmMessage = document.getElementById('confirm-message');
                const okBtn = document.getElementById('confirm-ok-btn');
                const cancelBtn = document.getElementById('confirm-cancel-btn');
                const confirmDialog = document.getElementById('confirm-dialog');

                if (!confirmTitle || !confirmMessage || !okBtn || !cancelBtn || !confirmDialog) {
                    console.error('Confirm dialog elements not found');
                    resolve(false);
                    return;
                }

                confirmTitle.textContent = title;
                confirmMessage.innerHTML = message;

                // Set button texts
                okBtn.textContent = 'Yes, Generate';
                cancelBtn.textContent = 'No, Skip';

                // Remove the onclick handler temporarily
                const originalOnclick = cancelBtn.onclick;
                cancelBtn.onclick = null;

                // Handle Yes click
                const handleYes = () => {
                    okBtn.removeEventListener('click', handleYes);
                    cancelBtn.removeEventListener('click', handleNo);
                    cancelBtn.onclick = originalOnclick;
                    confirmDialog.style.display = 'none';
                    resolve(true);
                };

                // Handle No click
                const handleNo = () => {
                    okBtn.removeEventListener('click', handleYes);
                    cancelBtn.removeEventListener('click', handleNo);
                    cancelBtn.onclick = originalOnclick;
                    confirmDialog.style.display = 'none';
                    resolve(false);
                };

                okBtn.addEventListener('click', handleYes);
                cancelBtn.addEventListener('click', handleNo);

                // Show the dialog
                confirmDialog.style.display = 'flex';
            } catch (error) {
                console.error('Error showing confirm dialog:', error);
                resolve(false);
            }
        });
    }

    /**
     * Get selected main thumbnail event from timeline
     */
    getSelectedMainThumbnailEvent() {
        return this.selectedMainThumbnailEventId;
    }

    /**
     * Load events JSON file
     */
    async loadEvents() {
        try {
            const result = await ipcRenderer.invoke('show-open-dialog', {
                title: 'Select Events JSON File',
                filters: [
                    { name: 'JSON Files', extensions: ['json'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile']
            });

            if (result && !result.canceled && result.filePaths.length > 0) {
                const eventsPath = result.filePaths[0];
                this.loadEventsFile(eventsPath);
            }
        } catch (error) {
            console.error('Failed to load events:', error);
        }
    }
    
    /**
     * Load events for video
     */
    async loadEventsForVideo(videoPath) {
        // Try to find matching events file
        const parsed = path.parse(videoPath);
        const eventsPath = path.join(parsed.dir, `${parsed.name}.json`);
        
        try {
            const exists = await ipcRenderer.invoke('file-exists', eventsPath);
            if (exists) {
                this.loadEventsFile(eventsPath);
            } else {
            }
        } catch (error) {
            console.error('Error checking for events file:', error);
        }
    }
    
    /**
     * Load events from file
     */
    async loadEventsFile(eventsPath) {
        try {
            const content = await ipcRenderer.invoke('read-file', eventsPath);
            const data = JSON.parse(content);
            
            if (data.events) {
                this.events = data.events;
                this.filteredEvents = [...this.events];
                this.currentEventsFile = eventsPath;  // Track the file path
                
                // Analyze events for filter options
                this.analyzeEvents();
                
                this.updateTimeline();
                this.updateEventCount();
                
                // Enable export buttons if we have events
                const exportBtn = document.getElementById('export-clips-btn');
                const saveFilteredBtn = document.getElementById('save-filtered-btn');
                if (this.events.length > 0) {
                    if (exportBtn) exportBtn.disabled = false;
                    if (saveFilteredBtn) saveFilteredBtn.disabled = false;
                }
                
                // Update filter UI
                this.updateFilterUI();
            }
        } catch (error) {
            console.error('Failed to load events file:', error);
        }
    }
    
    /**
     * Update timeline with events
     */
    updateTimeline() {
        if (!this.timelineEvents) return;

        this.timelineEvents.innerHTML = '';

        this.filteredEvents.forEach((event, index) => {
            const eventEl = document.createElement('div');
            eventEl.className = `timeline-event ${event.category || event.type}`;
            eventEl.dataset.index = index;
            eventEl.dataset.time = event.videoOffset || 0;
            eventEl.dataset.eventId = event.id;

            // Check if this is a manual/editable event
            const isEditable = event.type === 'manual' || event.data?.editable === true;

            // Check if this event is selected as main thumbnail
            const isMainThumbnail = event.id === this.selectedMainThumbnailEventId;

            eventEl.innerHTML = `
                <div class="timeline-event-content">
                    <div class="timeline-event-time">${event.videoTimecode || '00:00:00'}</div>
                    <div class="timeline-event-title">${event.name || event.type}</div>
                    <div class="timeline-event-desc">${event.message || ''}</div>
                </div>
                ${isEditable ? `
                    <button class="event-edit-btn" onclick="event.stopPropagation(); window.postController.editEvent(${index})" title="Edit Event">
                        ✏️
                    </button>
                ` : ''}
                <button class="main-thumbnail-icon ${isMainThumbnail ? 'active' : ''}"
                        onclick="event.stopPropagation(); window.postController.toggleMainThumbnail('${event.id}')"
                        title="Set as main thumbnail">
                    📷
                </button>
            `;

            eventEl.addEventListener('click', () => this.jumpToEvent(index));

            this.timelineEvents.appendChild(eventEl);
        });
    }

    /**
     * Toggle main thumbnail selection for an event
     */
    toggleMainThumbnail(eventId) {
        // If clicking the same event, deselect it
        if (this.selectedMainThumbnailEventId === eventId) {
            this.selectedMainThumbnailEventId = null;
        } else {
            // Select new event
            this.selectedMainThumbnailEventId = eventId;
        }

        // Update all camera icons
        document.querySelectorAll('.main-thumbnail-icon').forEach(icon => {
            const eventEl = icon.closest('.timeline-event');
            if (eventEl && eventEl.dataset.eventId === this.selectedMainThumbnailEventId) {
                icon.classList.add('active');
            } else {
                icon.classList.remove('active');
            }
        });
    }
    
    /**
     * Jump to event in video
     */
    jumpToEvent(index) {
        const event = this.filteredEvents[index];
        if (!event || !this.videoPlayer) return;
        
        // Immediately highlight and show details (before seeking)
        this.highlightEvent(index);
        this.showEventDetails(event);
        this.currentEventIndex = index;
        
        // Set video time with a small offset to better catch the event
        const time = event.videoOffset || 0;
        const seekTime = Math.max(0, time - 0.5); // Go 0.5 seconds before event
        this.videoPlayer.currentTime = seekTime;
        
        // If video is paused, force an immediate check after seeking
        if (this.videoPlayer.paused) {
            // Use a small timeout to ensure seek completes
            setTimeout(() => {
                this.onVideoSeeked();
                // Force check for events at the new position
                this.checkForNearbyEvents(this.videoPlayer.currentTime);
            }, 100);
        }
    }
    
    /**
     * Highlight event in timeline
     */
    highlightEvent(index) {
        // Remove previous highlight
        document.querySelectorAll('.timeline-event.active').forEach(el => {
            el.classList.remove('active');
        });
        
        // Add highlight to current
        const eventEl = this.timelineEvents.children[index];
        if (eventEl) {
            eventEl.classList.add('active');
            eventEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        
        this.currentEventIndex = index;
    }
    
    /**
     * Show event details
     */
    showEventDetails(event) {
        if (!this.currentEventDisplay) return;
        
        const timeEl = document.getElementById('current-event-time');
        const nameEl = document.getElementById('current-event-name');
        const messageEl = document.getElementById('current-event-message');
        
        if (timeEl) timeEl.textContent = event.videoTimecode || '00:00:00';
        if (nameEl) nameEl.textContent = event.name || event.type || '--';
        if (messageEl) messageEl.textContent = event.message || '--';
        
        this.currentEventDisplay.style.display = 'block';
        
        // Auto-hide after 5 seconds
        clearTimeout(this.eventDisplayTimeout);
        this.eventDisplayTimeout = setTimeout(() => {
            this.currentEventDisplay.style.display = 'none';
        }, 5000);
    }
    
    /**
     * Apply filters to events
     */
    applyFilters() {
        // Use the new advanced filter system
        this.applyAdvancedFilters();
    }
    
    
    /**
     * Update event count
     */
    updateEventCount() {
        if (this.timelineCount) {
            const count = this.filteredEvents.length;
            this.timelineCount.textContent = `${count} event${count !== 1 ? 's' : ''}`;
        }
    }
    
    /**
     * Add exclude filter
     */
    addExcludeFilter() {
        const filterId = Date.now();
        this.excludeFilters.push({
            id: filterId,
            field: '',
            value: '',
            operator: 'equals',
            logicOperator: 'AND'  // How this filter combines with others
        });
        this.renderFilters();
    }
    
    /**
     * Add include filter
     */
    addIncludeFilter() {
        const filterId = Date.now();
        this.includeFilters.push({
            id: filterId,
            field: '',
            value: '',
            operator: 'equals',
            logicOperator: 'OR'  // Default to OR for includes
        });
        this.renderFilters();
    }
    
    /**
     * Render all filters in UI
     */
    renderFilters() {
        // Render exclude filters - no grouping, just show them in order with AND/OR operators
        const excludeList = document.getElementById('exclude-list');
        if (excludeList) {
            excludeList.innerHTML = '';
            this.excludeFilters.forEach(filter => {
                this.renderFilterRow(filter, 'exclude', excludeList);
            });
        }
        
        // Render include filters - no grouping, just show them in order with AND/OR operators
        const includeList = document.getElementById('include-list');
        if (includeList) {
            includeList.innerHTML = '';
            this.includeFilters.forEach(filter => {
                this.renderFilterRow(filter, 'include', includeList);
            });
        }
        
        this.updateFilterStats();
    }
    
    /**
     * Render a single filter row
     */
    renderFilterRow(filter, type, container) {
        const filterRow = document.createElement('div');
        filterRow.className = 'filter-row';
        filterRow.dataset.filterId = filter.id;
        filterRow.dataset.filterType = type;
        
        // Add logic operator selector (AND/OR) - but not for the first filter
        const isFirstFilter = (type === 'exclude' && this.excludeFilters.indexOf(filter) === 0) ||
                            (type === 'include' && this.includeFilters.indexOf(filter) === 0);
        
        if (!isFirstFilter) {
            const logicSelect = document.createElement('select');
            logicSelect.className = 'filter-logic-operator';
            logicSelect.innerHTML = `
                <option value="AND">AND</option>
                <option value="OR">OR</option>
            `;
            logicSelect.value = filter.logicOperator || (type === 'include' ? 'OR' : 'AND');
            logicSelect.onchange = () => {
                filter.logicOperator = logicSelect.value;
                this.applyFilters();
            };
            filterRow.appendChild(logicSelect);
        }
        
        // Create field selector
        const fieldSelect = document.createElement('select');
        fieldSelect.className = 'filter-field';
        fieldSelect.innerHTML = '<option value="">Select field...</option>';
        
        // Add available fields from dynamic discovery
        if (this.filterOptions.availableFields) {
            this.filterOptions.availableFields.forEach(field => {
                const option = document.createElement('option');
                option.value = field.value;
                option.textContent = field.label;
                fieldSelect.appendChild(option);
            });
        }
        
        fieldSelect.value = filter.field || '';
        fieldSelect.onchange = () => this.onFilterFieldChange(filter.id, type, fieldSelect);
        
        // Create value selector
        const valueSelect = document.createElement('select');
        valueSelect.className = 'filter-value-select';
        valueSelect.style.display = filter.field ? 'inline-block' : 'none';
        
        // Populate value if field is set
        if (filter.field) {
            this.populateValueSelect(valueSelect, filter.field);
            valueSelect.value = filter.value || '';
        }
        
        valueSelect.onchange = () => this.onFilterValueChange(filter.id, type, valueSelect.value);
        
        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'filter-remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => this.removeFilter(filter.id, type);
        
        filterRow.appendChild(fieldSelect);
        filterRow.appendChild(valueSelect);
        filterRow.appendChild(removeBtn);
        container.appendChild(filterRow);
    }
    
    /**
     * Render a filter group
     */
    renderFilterGroup(field, filters, container) {
        const group = document.createElement('div');
        group.className = 'filter-group';
        
        const header = document.createElement('div');
        header.className = 'filter-group-header';
        
        const title = document.createElement('div');
        title.className = 'filter-group-title';
        title.textContent = this.getFieldDisplayName(field);
        
        const operator = document.createElement('span');
        operator.className = 'filter-group-operator';
        operator.textContent = 'OR';
        
        header.appendChild(title);
        header.appendChild(operator);
        group.appendChild(header);
        
        const values = document.createElement('div');
        values.className = 'filter-group-values';
        
        filters.forEach(filter => {
            const chip = document.createElement('div');
            chip.className = 'filter-value-chip';
            chip.innerHTML = `
                <span>${this.getValueDisplayName(filter.field, filter.value)}</span>
                <span class="remove" onclick="window.postController.removeFilter(${filter.id}, 'include')">×</span>
            `;
            values.appendChild(chip);
        });
        
        group.appendChild(values);
        container.appendChild(group);
    }
    
    /**
     * Get display name for field
     */
    getFieldDisplayName(field) {
        // Find the field in our available fields to get its label
        if (this.filterOptions && this.filterOptions.availableFields) {
            const fieldInfo = this.filterOptions.availableFields.find(f => f.value === field);
            if (fieldInfo) {
                // Remove the count from the label for display
                return fieldInfo.label.replace(/\s*\(\d+\)$/, '');
            }
        }
        
        // Fallback display names
        const names = {
            player: 'Player Name',
            category: 'Category',
            type: 'Event Type',
            subtype: 'Event Subtype',
            eventName: 'Event Name',
            vehicle: 'Vehicle',
            zone: 'Zone/Location',
            weapon: 'Weapon',
            weaponClass: 'Weapon Class',
            damageType: 'Damage Type',
            message: 'Message Text'
        };
        return names[field] || field;
    }
    
    /**
     * Get display name for value
     */
    getValueDisplayName(field, value) {
        if (field === 'category' && this.eventPatterns?.categories?.[value]) {
            const cat = this.eventPatterns.categories[value];
            return `${cat.icon || ''} ${cat.name}`.trim();
        }
        // For all other fields, just return the value as is
        return value;
    }
    
    /**
     * Populate value select based on field
     */
    populateValueSelect(select, field) {
        select.innerHTML = '<option value="">Select value...</option>';
        
        // Safety check
        if (!this.filterOptions || !this.filterOptions.fieldValues) {
            console.warn('Filter options not initialized');
            return;
        }
        
        // Get values for the selected field
        const values = this.filterOptions.fieldValues[field];
        
        if (values && values.length > 0) {
            values.forEach(value => {
                const option = document.createElement('option');
                option.value = value;
                
                // Special formatting for certain fields
                if (field === 'category' && this.eventPatterns?.categories?.[value]) {
                    const catInfo = this.eventPatterns.categories[value];
                    option.textContent = `${catInfo.icon || ''} ${catInfo.name}`.trim();
                } else {
                    option.textContent = value;
                }
                
                select.appendChild(option);
            });
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = `(No values for this field)`;
            option.disabled = true;
            select.appendChild(option);
        }
    }
    
    /**
     * Handle filter field change
     */
    onFilterFieldChange(filterId, type, selectElement) {
        const field = selectElement.value;
        const filters = type === 'exclude' ? this.excludeFilters : this.includeFilters;
        const filter = filters.find(f => f.id === filterId);
        
        if (filter) {
            filter.field = field;
            filter.value = '';
            
            // Find the value select in the same row and update it
            const filterRow = selectElement.closest('.filter-row');
            const valueSelect = filterRow?.querySelector('.filter-value-select');
            
            if (valueSelect) {
                if (field) {
                    // Show and populate the value select
                    valueSelect.style.display = 'inline-block';
                    valueSelect.innerHTML = '<option value="">Select value...</option>';
                    this.populateValueSelect(valueSelect, field);
                } else {
                    // Hide the value select if no field is selected
                    valueSelect.style.display = 'none';
                    valueSelect.innerHTML = '';
                }
            }
            
            // Don't re-render everything, just update stats
            this.updateFilterStats();
        }
    }
    
    /**
     * Handle filter value change
     */
    onFilterValueChange(filterId, type, value) {
        const filters = type === 'exclude' ? this.excludeFilters : this.includeFilters;
        const filter = filters.find(f => f.id === filterId);
        
        if (filter) {
            filter.value = value;
        }
    }
    
    /**
     * Remove filter
     */
    removeFilter(filterId, type) {
        if (type === 'exclude') {
            this.excludeFilters = this.excludeFilters.filter(f => f.id !== filterId);
        } else {
            this.includeFilters = this.includeFilters.filter(f => f.id !== filterId);
        }
        this.renderFilters();
        this.applyFilters();
    }
    
    /**
     * Update filter stats
     */
    updateFilterStats() {
        const statsEl = document.getElementById('filter-stats-text');
        if (statsEl) {
            const excludeCount = this.excludeFilters.filter(f => f.field && f.value).length;
            const includeCount = this.includeFilters.filter(f => f.field && f.value).length;
            
            if (excludeCount === 0 && includeCount === 0) {
                statsEl.textContent = 'No filters active';
            } else {
                const parts = [];
                if (excludeCount > 0) parts.push(`${excludeCount} exclude`);
                if (includeCount > 0) parts.push(`${includeCount} include`);
                statsEl.textContent = `Active: ${parts.join(', ')}`;
            }
        }
    }
    
    
    /**
     * Apply filters with new logic
     */
    applyFilters() {
        // Start with all events
        let filtered = [...this.events];
        
        // Phase 1: Apply exclude filters
        const activeExcludes = this.excludeFilters.filter(f => f.field && f.value);
        if (activeExcludes.length > 0) {
            filtered = filtered.filter(event => {
                // Process excludes with their logic operators
                let shouldExclude = false;
                let accumulator = null;
                
                for (let i = 0; i < activeExcludes.length; i++) {
                    const filter = activeExcludes[i];
                    const matches = this.eventMatchesFilter(event, filter);
                    
                    if (i === 0) {
                        accumulator = matches;
                    } else {
                        if (filter.logicOperator === 'AND') {
                            accumulator = accumulator && matches;
                        } else { // OR
                            accumulator = accumulator || matches;
                        }
                    }
                }
                
                // If the accumulated result is true, exclude the event
                return !accumulator;
            });
        }
        
        // Phase 2: Apply include filters
        const activeIncludes = this.includeFilters.filter(f => f.field && f.value);
        if (activeIncludes.length > 0) {
            filtered = filtered.filter(event => {
                // Process includes with their logic operators
                let accumulator = null;
                
                for (let i = 0; i < activeIncludes.length; i++) {
                    const filter = activeIncludes[i];
                    const matches = this.eventMatchesFilter(event, filter);
                    
                    if (i === 0) {
                        accumulator = matches;
                    } else {
                        if (filter.logicOperator === 'AND') {
                            accumulator = accumulator && matches;
                        } else { // OR
                            accumulator = accumulator || matches;
                        }
                    }
                }
                
                return accumulator;
            });
        }
        
        this.filteredEvents = filtered;
        this.updateTimeline();
        this.updateEventCount();
        this.updateFilterStats();
    }
    
    /**
     * Check if event matches filter
     */
    eventMatchesFilter(event, filter) {
        const filterValue = (filter.value || '').toLowerCase();
        
        // Special handling for player field (searches multiple fields)
        if (filter.field === 'player') {
            const playerFields = ['killer', 'destroyer', 'victim', 'driver', 'player'];
            for (const field of playerFields) {
                if (event.data && event.data[field]) {
                    if (event.data[field].toLowerCase() === filterValue) {
                        return true;
                    }
                }
            }
            return false;
        }
        
        // Get the event value based on field
        let eventValue = '';
        
        // Check top-level fields
        if (filter.field === 'category') {
            eventValue = event.category || '';
        } else if (filter.field === 'type') {
            eventValue = event.type || '';
        } else if (filter.field === 'subtype') {
            eventValue = event.subtype || '';
        } else if (filter.field === 'eventName') {
            eventValue = event.name || '';
        } else if (filter.field === 'message') {
            eventValue = event.message || '';
            // For message field, use contains matching
            return eventValue.toLowerCase().includes(filterValue);
        } else {
            // Check data fields
            switch (filter.field) {
                case 'vehicle':
                    eventValue = event.data?.vehicle || '';
                    break;
                case 'zone':
                    eventValue = event.data?.zone || '';
                    break;
                case 'weapon':
                    eventValue = event.data?.weapon || '';
                    break;
                case 'weaponClass':
                    eventValue = event.data?.weaponClass || '';
                    break;
                case 'damageType':
                    eventValue = event.data?.damageType || '';
                    break;
                case 'playerId':
                    eventValue = event.data?.playerId || '';
                    break;
                case 'killerId':
                    eventValue = event.data?.killerId || '';
                    break;
                case 'destroyerId':
                    eventValue = event.data?.destroyerId || '';
                    break;
                case 'victimId':
                    eventValue = event.data?.victimId || '';
                    break;
                case 'vehicleId':
                    eventValue = event.data?.vehicleId || '';
                    break;
                default:
                    // Try data field first, then top level
                    eventValue = event.data?.[filter.field] || event[filter.field] || '';
            }
        }
        
        // Convert to lowercase for comparison
        eventValue = eventValue.toString().toLowerCase();
        
        // Exact match comparison
        return eventValue === filterValue;
    }
    
    /**
     * Old applyAdvancedFilters for compatibility
     */
    applyAdvancedFilters() {
        // Get current filter values from DOM
        const filterRows = document.querySelectorAll('.filter-row');
        this.filters = [];
        
        filterRows.forEach(row => {
            const filterId = parseInt(row.dataset.filterId);
            const type = row.querySelector('.filter-type').value;
            const field = row.querySelector('.filter-field').value;
            const operator = row.querySelector('.filter-operator').value;
            
            // Get value from either select or input
            const valueSelect = row.querySelector('.filter-value-select');
            const valueInput = row.querySelector('.filter-value');
            let value = '';
            
            if (valueSelect.style.display !== 'none' && valueSelect.value) {
                value = valueSelect.value;
            } else if (valueInput.style.display !== 'none' && valueInput.value) {
                value = valueInput.value;
            }
            
            if (value) {
                this.filters.push({ id: filterId, type, field, operator, value });
            }
        });
        
        // Apply filters in order
        this.filteredEvents = this.events.filter(event => {
            let include = true;
            
            for (const filter of this.filters) {
                let eventValue = '';
                let filterValue = filter.value.toLowerCase();
                let matches = false;
                
                // Map field to actual event property
                switch (filter.field) {
                    case 'category':
                        eventValue = (event.category || '').toLowerCase();
                        matches = eventValue === filterValue;
                        break;
                    case 'eventType':
                        eventValue = (event.id || event.type || '').toLowerCase();
                        matches = eventValue === filterValue;
                        break;
                    case 'severity':
                        eventValue = (event.severity || '').toLowerCase();
                        matches = eventValue === filterValue;
                        break;
                    case 'message':
                        eventValue = (event.message || '').toLowerCase();
                        break;
                    case 'victim':
                        eventValue = (event.victim || '').toLowerCase();
                        break;
                    case 'killer':
                        eventValue = (event.killer || '').toLowerCase();
                        break;
                    case 'vehicle':
                        eventValue = (event.vehicle || '').toLowerCase();
                        break;
                    case 'zone':
                        eventValue = (event.zone || event.location || '').toLowerCase();
                        break;
                    case 'weapon':
                        eventValue = (event.weapon || '').toLowerCase();
                        break;
                    default:
                        eventValue = (event[filter.field] || '').toString().toLowerCase();
                }
                
                // Apply operator for text fields
                if (!matches && filter.field !== 'category' && filter.field !== 'eventType' && filter.field !== 'severity') {
                    switch (filter.operator) {
                        case 'equals':
                            matches = eventValue === filterValue;
                            break;
                        case 'contains':
                            matches = eventValue.includes(filterValue);
                            break;
                        case 'starts':
                            matches = eventValue.startsWith(filterValue);
                            break;
                        case 'ends':
                            matches = eventValue.endsWith(filterValue);
                            break;
                    }
                }
                
                if (filter.type === 'include') {
                    if (!matches) include = false;
                } else if (filter.type === 'exclude') {
                    if (matches) include = false;
                }
                
                if (!include) break;
            }
            
            return include;
        });
        
        this.updateTimeline();
        this.updateEventCount();
    }
    
    /**
     * Clear all filters
     */
    clearAllFilters() {
        this.excludeFilters = [];
        this.includeFilters = [];
        this.renderFilters();
        this.filteredEvents = [...this.events];
        this.updateTimeline();
        this.updateEventCount();
        this.updateFilterStats();
    }
    
    // Drag and drop handlers
    handleDragStart(e) {
        this.draggedElement = e.currentTarget;
        e.currentTarget.classList.add('dragging');
    }
    
    handleDragOver(e) {
        e.preventDefault();
        const afterElement = this.getDragAfterElement(e.currentTarget.parentNode, e.clientY);
        if (afterElement == null) {
            e.currentTarget.parentNode.appendChild(this.draggedElement);
        } else {
            e.currentTarget.parentNode.insertBefore(this.draggedElement, afterElement);
        }
    }
    
    handleDrop(e) {
        e.preventDefault();
    }
    
    handleDragEnd(e) {
        e.currentTarget.classList.remove('dragging');
        this.draggedElement = null;
    }
    
    getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.filter-row:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }
    
    /**
     * Video loaded handler
     * Note: HTML5 video elements only play the first audio track by default.
     * The Web Audio API or MediaSource Extensions would be needed for multi-track control,
     * but browser support is limited for MKV files. VLC or other desktop players
     * will play all tracks correctly.
     */
    /**
     * Upload current video
     */
    async uploadVideo() {
        if (!this.currentVideo) {
            this.showAlert('No video loaded');
            return;
        }

        if (!this.uploadDialog) {
            this.showAlert('Upload functionality not available');
            return;
        }

        // Create a video object similar to what SharedVideoBrowser provides
        const videoObject = {
            path: this.currentVideo,
            hasEvents: !!this.currentEventsFile && this.events && this.events.length > 0,
            eventCount: this.events ? this.events.length : 0
        };

        // Show upload dialog with video object including event info
        this.uploadDialog.show(videoObject, {
            onUploadQueued: (uploadId, accountName) => {
                // Could show a notification here
            }
        });
    }

    onVideoLoaded() {

        // Check if video has multiple audio tracks (limited browser support)
        if (this.videoPlayer.audioTracks && this.videoPlayer.audioTracks.length > 0) {
            // Try to enable all tracks (may not work in all browsers)
            for (let i = 0; i < this.videoPlayer.audioTracks.length; i++) {
                this.videoPlayer.audioTracks[i].enabled = true;
            }
        } else {
        }

        // Enable insert event button
        const insertEventBtn = document.getElementById('insert-event-btn');
        if (insertEventBtn) {
            insertEventBtn.disabled = false;
        }

        // Force a repaint for H.265 videos which may have rendering issues
        this.videoPlayer.style.display = 'none';
        this.videoPlayer.offsetHeight; // Force reflow
        this.videoPlayer.style.display = 'block';

        // Ensure video is properly sized
        const wrapper = this.videoPlayer.parentElement;
        if (wrapper) {
            const aspectRatio = this.videoPlayer.videoWidth / this.videoPlayer.videoHeight;

            // Update wrapper aspect ratio to match video
            wrapper.style.aspectRatio = `${aspectRatio}`;
        }

        this.fitTimeline();
    }
    
    /**
     * Video time update handler
     */
    onVideoTimeUpdate() {
        const currentTime = this.videoPlayer.currentTime;

        // Update current time display
        const timeDisplay = document.getElementById('current-video-time');
        if (timeDisplay) {
            timeDisplay.textContent = this.formatTimecode(currentTime);
        }

        if (!this.isPlaying) return;

        // Check for nearby events
        this.checkForNearbyEvents(currentTime);
    }
    
    /**
     * Check for events near current time
     */
    checkForNearbyEvents(currentTime) {
        let bestEvent = null;
        let bestIndex = -1;
        
        // Find the best event to show (0.5-1.0 seconds ahead preferred)
        for (let i = 0; i < this.filteredEvents.length; i++) {
            const event = this.filteredEvents[i];
            const eventTime = event.videoOffset || 0;
            const timeDiff = eventTime - currentTime;
            
            // Perfect timing: event is 0.5-1.0 seconds ahead
            if (timeDiff >= 0.5 && timeDiff <= 1.0) {
                bestEvent = event;
                bestIndex = i;
                break; // This is ideal, use it
            }
            
            // Event just passed (within 0.5 seconds ago) - still show it
            if (timeDiff >= -0.5 && timeDiff < 0.5) {
                bestEvent = event;
                bestIndex = i;
                // Keep looking for a better upcoming event
            }
        }
        
        // Show the best event if we found one
        if (bestEvent && bestIndex !== this.currentEventIndex) {
            this.highlightEvent(bestIndex);
            this.showEventDetails(bestEvent);
        }
        
        // Clear display if no nearby event
        if (!bestEvent && this.currentEventIndex !== -1) {
            // Hide event display after we've moved past it
            const currentEvent = this.filteredEvents[this.currentEventIndex];
            if (currentEvent) {
                const timePassed = currentTime - (currentEvent.videoOffset || 0);
                if (timePassed > 3) { // Hide 3 seconds after event
                    this.currentEventIndex = -1;
                    if (this.currentEventDisplay) {
                        this.currentEventDisplay.style.display = 'none';
                    }
                }
            }
        }
    }
    
    /**
     * Video play handler
     */
    onVideoPlay() {
        this.isPlaying = true;
    }
    
    /**
     * Video pause handler
     */
    onVideoPause() {
        this.isPlaying = false;
    }
    
    /**
     * Video seeked handler
     */
    onVideoSeeked() {
        const currentTime = this.videoPlayer.currentTime;
        
        // Find closest event
        let closestEvent = null;
        let closestIndex = -1;
        let closestDiff = Infinity;
        
        for (let i = 0; i < this.filteredEvents.length; i++) {
            const event = this.filteredEvents[i];
            const eventTime = event.videoOffset || 0;
            const diff = Math.abs(eventTime - currentTime);
            
            if (diff < closestDiff) {
                closestDiff = diff;
                closestEvent = event;
                closestIndex = i;
            }
        }
        
        // Highlight closest event if within 5 seconds
        if (closestEvent && closestDiff < 5) {
            this.highlightEvent(closestIndex);
        }
    }
    
    /**
     * Export clips based on events
     */
    async exportClips() {
        // This would require ffmpeg integration
        console.log('Export clips feature - coming soon!');
        this.showAlert('Export clips feature will be available in a future update!');
    }
    
    /**
     * Zoom timeline
     */
    zoomTimeline(factor) {
        // Adjust timeline scale
    }
    
    /**
     * Fit timeline to view
     */
    fitTimeline() {
        // Reset timeline scale
    }
    
    /**
     * Get last recording info
     */
    async getLastRecording() {
        try {
            const status = await ipcRenderer.invoke('get-event-capture-status');
            return status;
        } catch (error) {
            console.error('Failed to get last recording:', error);
            return null;
        }
    }
    
    /**
     * Show video browser modal
     */
    async showVideoBrowser() {
        if (this.videoBrowser) {
            await this.videoBrowser.show();
        } else {
            console.error('Video browser not initialized');
        }
    }

    /**
     * Handle video selection from browser
     */
    handleVideoSelected(video) {
        this.loadVideoFile(video.path);
    }
    
    /**
     * Hide video browser modal
     */
    hideVideoBrowser() {
        const modal = document.getElementById('video-browser-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    /**
     * Refresh video browser
     */
    async refreshVideoBrowser() {
        await this.loadVideoList();
    }
    
    /**
     * Load list of videos from recording directory
     */
    async loadVideoList() {
        try {
            const recordings = await ipcRenderer.invoke('get-recordings-list');
            this.displayVideoList(recordings);
        } catch (error) {
            console.error('Failed to load video list:', error);
            this.displayVideoList([]);
        }
    }
    
    /**
     * Display video list in browser
     */
    displayVideoList(recordings) {
        const videoListEl = document.getElementById('video-list');
        const pathEl = document.getElementById('browser-path');
        
        if (!videoListEl) return;
        
        // Update path display
        if (pathEl && recordings.path) {
            pathEl.textContent = recordings.path;
        }
        
        // Clear existing list
        videoListEl.innerHTML = '';
        
        if (!recordings || recordings.length === 0) {
            videoListEl.innerHTML = '<div class="no-videos">No recordings found</div>';
            return;
        }
        
        // Recordings are already sorted by date in the IPC handler
        
        // Create video items
        recordings.forEach(video => {
            const videoItem = document.createElement('div');
            videoItem.className = video.hasEvents ? 'video-item has-events' : 'video-item';
            
            const date = new Date(video.modified);
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
            
            videoItem.innerHTML = `
                <div class="video-info">
                    <div class="video-name">${video.name}</div>
                    <div class="video-details">
                        <div class="video-date">📅 ${dateStr}</div>
                        <div class="video-size">💾 ${this.formatFileSize(video.size)}</div>
                        ${video.duration ? `<div class="video-duration">⏱️ ${this.formatDuration(video.duration)}</div>` : ''}
                        ${video.hasEvents ? `<div class="video-events">📊 ${video.eventCount} events</div>` : ''}
                    </div>
                </div>
                <div class="video-actions">
                    <button class="btn btn-sm btn-primary" onclick="window.postController.loadFromBrowser('${video.path.replace(/\\/g, '\\\\')}')">Load</button>
                </div>
            `;
            
            videoListEl.appendChild(videoItem);
        });
    }
    
    /**
     * Load video from browser selection
     */
    async loadFromBrowser(videoPath) {
        this.hideVideoBrowser();
        this.loadVideoFile(videoPath);
    }
    
    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (!bytes || bytes === 0) return '0 MB';
        const mb = bytes / (1024 * 1024);
        if (mb < 1000) {
            return `${mb.toFixed(1)} MB`;
        } else {
            const gb = mb / 1024;
            return `${gb.toFixed(2)} GB`;
        }
    }
    
    /**
     * Format duration
     */
    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes}:${secs.toString().padStart(2, '0')}`;
        }
    }
    
    /**
     * Analyze events to build filter options
     */
    analyzeEvents() {
        if (!this.events || this.events.length === 0) {
            return;
        }
        
        // Map to store all discovered fields and their values
        const fieldMap = new Map();
        
        // Helper to add field and value
        const addFieldValue = (fieldName, value, displayName = null) => {
            if (!value || value === 'unknown' || value === '0') return;
            
            if (!fieldMap.has(fieldName)) {
                fieldMap.set(fieldName, {
                    displayName: displayName || fieldName,
                    values: new Set()
                });
            }
            fieldMap.get(fieldName).values.add(String(value).trim());
        };
        
        // Extract all unique player names
        const playerNames = new Set();
        
        // Scan all events to discover fields and values
        this.events.forEach(event => {
            // Top-level fields
            if (event.category) addFieldValue('category', event.category, 'Category');
            if (event.type) addFieldValue('type', event.type, 'Event Type');
            if (event.subtype) addFieldValue('subtype', event.subtype, 'Event Subtype');
            if (event.name) addFieldValue('eventName', event.name, 'Event Name');
            
            // Message field (searchable text)
            if (event.message) addFieldValue('message', event.message, 'Message Text');
            
            // Extract data from nested data object
            if (event.data) {
                // Vehicle fields
                if (event.data.vehicle) addFieldValue('vehicle', event.data.vehicle, 'Vehicle');
                
                // Zone/location fields
                if (event.data.zone) addFieldValue('zone', event.data.zone, 'Zone/Location');
                
                // Weapon fields
                if (event.data.weapon) addFieldValue('weapon', event.data.weapon, 'Weapon');
                if (event.data.weaponClass) addFieldValue('weaponClass', event.data.weaponClass, 'Weapon Class');
                
                // Damage type
                if (event.data.damageType) addFieldValue('damageType', event.data.damageType, 'Damage Type');
                
                // Collect all player names from various fields
                ['killer', 'destroyer', 'victim', 'driver', 'player'].forEach(field => {
                    if (event.data[field] && event.data[field] !== 'unknown') {
                        playerNames.add(event.data[field]);
                    }
                });
                
                // Player IDs (might be useful)
                if (event.data.playerId) addFieldValue('playerId', event.data.playerId, 'Player ID');
                if (event.data.killerId) addFieldValue('killerId', event.data.killerId, 'Killer ID');
                if (event.data.destroyerId) addFieldValue('destroyerId', event.data.destroyerId, 'Destroyer ID');
                if (event.data.victimId) addFieldValue('victimId', event.data.victimId, 'Victim ID');
                
                // Vehicle IDs
                if (event.data.vehicleId) addFieldValue('vehicleId', event.data.vehicleId, 'Vehicle ID');
            }
        });
        
        // Add player names as a special combined field
        if (playerNames.size > 0) {
            fieldMap.set('player', {
                displayName: 'Player Name',
                values: playerNames
            });
        }
        
        // Convert to the format expected by the filter system
        const availableFields = [];
        const fieldValues = {};
        
        // Define field display order (most important first)
        const fieldOrder = [
            'player',      // Player names (combined from all sources)
            'category',    // Event category
            'type',        // Event type
            'subtype',     // Event subtype
            'eventName',   // Event name
            'vehicle',     // Vehicle name
            'zone',        // Zone/location
            'weapon',      // Weapon name
            'weaponClass', // Weapon class
            'damageType',  // Damage type
            'message',     // Message text (for text search)
            'playerId',    // Player IDs
            'killerId',
            'destroyerId',
            'victimId',
            'vehicleId'    // Vehicle IDs
        ];
        
        // Add fields in preferred order, then any remaining fields
        const addedFields = new Set();
        
        fieldOrder.forEach(fieldName => {
            if (fieldMap.has(fieldName)) {
                const field = fieldMap.get(fieldName);
                availableFields.push({
                    value: fieldName,
                    label: `${field.displayName} (${field.values.size})`
                });
                fieldValues[fieldName] = Array.from(field.values).sort((a, b) => 
                    a.toLowerCase().localeCompare(b.toLowerCase())
                );
                addedFields.add(fieldName);
            }
        });
        
        // Add any remaining fields not in the preferred order
        for (const [fieldName, field] of fieldMap.entries()) {
            if (!addedFields.has(fieldName)) {
                availableFields.push({
                    value: fieldName,
                    label: `${field.displayName} (${field.values.size})`
                });
                fieldValues[fieldName] = Array.from(field.values).sort((a, b) => 
                    a.toLowerCase().localeCompare(b.toLowerCase())
                );
            }
        }
        
        this.filterOptions = {
            availableFields,
            fieldValues
        };
        
        
    }
    
    /**
     * Update filter UI after loading events
     */
    updateFilterUI() {
        // Add quick exclude buttons based on available data
        const quickExcludes = document.getElementById('quick-excludes');
        if (quickExcludes) {
            quickExcludes.innerHTML = '';

            // Add quick exclude for low severity if it exists
            if (this.filterOptions && this.filterOptions.fieldValues && this.filterOptions.fieldValues.severity &&
                this.filterOptions.fieldValues.severity.includes('low')) {
                const btn = document.createElement('button');
                btn.textContent = 'Hide Low Severity';
                btn.onclick = () => this.addQuickExclude('severity', 'low');
                quickExcludes.appendChild(btn);
            }
            
            // Add quick exclude for ship enter/exit if they exist
            const eventTypes = this.filterOptions?.fieldValues?.type || [];
            const hasEnter = eventTypes.some(type =>
                type === 'seat_entered' || type === 'vehicle_entered'
            );
            const hasExit = eventTypes.some(type =>
                type === 'seat_exited' || type === 'vehicle_exited'
            );
            
            if (hasEnter || hasExit) {
                const btn = document.createElement('button');
                btn.textContent = 'Hide Ship Enter/Exit';
                btn.onclick = () => this.addQuickExcludeShipEvents();
                quickExcludes.appendChild(btn);
            }
        }
        
        // Update filter stats
        this.updateFilterStats();
    }
    
    /**
     * Add quick exclude filter
     */
    addQuickExclude(field, value) {
        this.excludeFilters.push({
            id: Date.now(),
            field: field,
            value: value,
            operator: 'equals'
        });
        this.renderFilters();
        this.applyFilters();
    }
    
    /**
     * Add quick exclude for ship events
     */
    addQuickExcludeShipEvents() {
        const enterEvents = ['seat_entered', 'vehicle_entered'];
        const exitEvents = ['seat_exited', 'vehicle_exited'];
        
        [...enterEvents, ...exitEvents].forEach(eventId => {
            if (this.filterOptions.eventTypes.some(([id]) => id === eventId)) {
                this.excludeFilters.push({
                    id: Date.now() + Math.random(),
                    field: 'eventType',
                    value: eventId,
                    operator: 'equals'
                });
            }
        });
        
        this.renderFilters();
        this.applyFilters();
    }
    
    /**
     * Load event patterns from configuration
     */
    async loadEventPatterns() {
        try {
            const fs = require('fs').promises;
            const { getPatternsPath } = require('./lib/config-path-helper');
            const patternsPath = getPatternsPath();
            const content = await fs.readFile(patternsPath, 'utf8');
            this.eventPatterns = JSON.parse(content);
            
        } catch (error) {
            console.error('Failed to load event patterns:', error);
            this.eventPatterns = { categories: {}, patterns: [] };
        }
    }
    
    /**
     * Save filtered events to new JSON file
     */
    async saveFilteredEvents() {
        if (!this.filteredEvents || this.filteredEvents.length === 0) {
            this.showAlert('No filtered events to save');
            return;
        }
        
        // Update dialog with current info
        document.getElementById('filtered-count').textContent = this.filteredEvents.length;
        document.getElementById('total-count').textContent = this.events.length;
        
        // Build filter summary
        const excludeCount = this.excludeFilters.filter(f => f.field && f.value).length;
        const includeCount = this.includeFilters.filter(f => f.field && f.value).length;
        let filterSummary = [];
        if (excludeCount > 0) filterSummary.push(`${excludeCount} exclude filter${excludeCount > 1 ? 's' : ''}`);
        if (includeCount > 0) filterSummary.push(`${includeCount} include filter${includeCount > 1 ? 's' : ''}`);
        document.getElementById('active-filters-summary').textContent = filterSummary.length > 0 ? filterSummary.join(', ') : 'None';
        
        // Show dialog
        document.getElementById('save-filtered-dialog').style.display = 'flex';
    }
    
    /**
     * Confirm and save filtered events (called from dialog)
     */
    async confirmSaveFilteredEvents() {
        // Hide dialog
        document.getElementById('save-filtered-dialog').style.display = 'none';
        
        try {
            const fs = require('fs').promises;
            
            // Determine the save path
            let savePath;
            if (this.currentEventsFile) {
                // We have a loaded events file, use its path
                savePath = this.currentEventsFile;
            } else if (this.currentVideo) {
                // Generate path based on video
                const parsed = path.parse(this.currentVideo);
                savePath = path.join(parsed.dir, `${parsed.name}.json`);
            } else {
                // No reference, ask user
                const result = await ipcRenderer.invoke('show-save-dialog', {
                    title: 'Save Filtered Events',
                    defaultPath: 'filtered_events.json',
                    filters: [
                        { name: 'JSON Files', extensions: ['json'] },
                        { name: 'All Files', extensions: ['*'] }
                    ]
                });
                
                if (!result || result.canceled) return;
                savePath = result.filePath;
            }
            
            // If file exists, create backup
            try {
                await fs.access(savePath);
                // File exists, create backup
                const backupPath = await this.getNextBackupFilename(savePath);
                await fs.rename(savePath, backupPath);
                
                // Show info about backup
                this.showAlert(
                    `<p><strong>✅ Export successful!</strong></p>
                    <p>Saved ${this.filteredEvents.length} filtered events.</p>
                    <p style="margin-top: 10px; font-size: 12px; color: #999;">
                        Original backed up to:<br>
                        ${path.basename(backupPath)}
                    </p>`,
                    'Events Exported'
                );
            } catch {
                // File doesn't exist, just save normally
                this.showAlert(
                    `<p><strong>✅ Export successful!</strong></p>
                    <p>Saved ${this.filteredEvents.length} filtered events.</p>`,
                    'Events Exported'
                );
            }
            
            // Create the JSON structure matching original format
            const outputData = {
                metadata: {
                    version: "1.0.0",
                    recorder: "SC-Recorder (Filtered)",
                    eventCount: this.filteredEvents.length,
                    originalEventCount: this.events.length,
                    filteredAt: new Date().toISOString(),
                    filters: {
                        exclude: this.excludeFilters.filter(f => f.field && f.value),
                        include: this.includeFilters.filter(f => f.field && f.value)
                    }
                },
                events: this.filteredEvents
            };
            
            // Save the file
            await fs.writeFile(savePath, JSON.stringify(outputData, null, 2));
            
            // Update current events file reference
            this.currentEventsFile = savePath;
            
        } catch (error) {
            console.error('Failed to save filtered events:', error);
            this.showAlert(
                `<p><strong>❌ Export failed</strong></p>
                <p>${error.message}</p>`,
                'Export Error'
            );
        }
    }
    
    /**
     * Save current filters as template
     */
    async saveFilterTemplate() {
        const activeExcludes = this.excludeFilters.filter(f => f.field && f.value);
        const activeIncludes = this.includeFilters.filter(f => f.field && f.value);
        const activeFilters = [...activeExcludes, ...activeIncludes];
        
        if (activeFilters.length === 0) {
            this.showAlert('No active filters to save as template');
            return;
        }
        
        // Build preview
        const preview = document.getElementById('template-preview');
        if (preview) {
            let previewHtml = '';
            if (activeExcludes.length > 0) {
                previewHtml += '<strong>Exclude filters:</strong><br>';
                activeExcludes.forEach(f => {
                    previewHtml += `• ${this.getFieldDisplayName(f.field)}: ${f.value}<br>`;
                });
            }
            if (activeIncludes.length > 0) {
                if (previewHtml) previewHtml += '<br>';
                previewHtml += '<strong>Include filters:</strong><br>';
                activeIncludes.forEach(f => {
                    previewHtml += `• ${this.getFieldDisplayName(f.field)}: ${f.value}<br>`;
                });
            }
            preview.innerHTML = previewHtml;
        }
        
        // Clear input and show dialog
        const input = document.getElementById('template-name-input');
        if (input) input.value = '';
        document.getElementById('template-name-dialog').style.display = 'flex';
    }
    
    /**
     * Confirm and save template (called from dialog)
     */
    async confirmSaveTemplate() {
        const templateName = document.getElementById('template-name-input')?.value?.trim();
        
        if (!templateName) {
            this.showAlert('Please enter a template name');
            return;
        }
        
        // Hide dialog
        document.getElementById('template-name-dialog').style.display = 'none';
        
        try {
            // Load existing templates
            const templates = await this.loadFilterTemplates();
            
            // Add new template
            templates[templateName] = {
                name: templateName,
                createdAt: new Date().toISOString(),
                excludeFilters: this.excludeFilters.filter(f => f.field && f.value),
                includeFilters: this.includeFilters.filter(f => f.field && f.value)
            };
            
            // Save templates via IPC
            await ipcRenderer.invoke('save-filter-templates', templates);
            
            // Update UI
            await this.refreshTemplateList();
            
            this.showAlert(`Filter template "${templateName}" saved successfully`);
        } catch (error) {
            console.error('Failed to save filter template:', error);
            this.showAlert('Failed to save filter template: ' + error.message);
        }
    }
    
    /**
     * Load filter templates
     */
    async loadFilterTemplates() {
        try {
            // Use IPC to load templates from main process
            const templates = await ipcRenderer.invoke('load-filter-templates');
            return templates || {};
        } catch (error) {
            console.error('Failed to load filter templates:', error);
            return {};
        }
    }
    
    /**
     * Load a specific filter template
     */
    async loadFilterTemplate(templateName) {
        if (!templateName) return;
        
        try {
            const templates = await this.loadFilterTemplates();
            const template = templates[templateName];
            
            if (!template) {
                this.showAlert('Template not found');
                return;
            }
            
            // Validate template filters against current available values
            const validatedExcludeFilters = [];
            const validatedIncludeFilters = [];
            let skippedCount = 0;

            // Validate exclude filters
            if (template.excludeFilters) {
                for (const filter of template.excludeFilters) {
                    // Check if the field exists in current data
                    const fieldExists = this.filterOptions.fieldValues &&
                                      this.filterOptions.fieldValues[filter.field];

                    if (fieldExists) {
                        // Check if the value exists for this field
                        const valueExists = this.filterOptions.fieldValues[filter.field].includes(filter.value);
                        if (valueExists) {
                            validatedExcludeFilters.push(filter);
                        } else {
                            skippedCount++;
                        }
                    } else {
                        skippedCount++;
                    }
                }
            }

            // Validate include filters
            if (template.includeFilters) {
                for (const filter of template.includeFilters) {
                    // Check if the field exists in current data
                    const fieldExists = this.filterOptions.fieldValues &&
                                      this.filterOptions.fieldValues[filter.field];

                    if (fieldExists) {
                        // Check if the value exists for this field
                        const valueExists = this.filterOptions.fieldValues[filter.field].includes(filter.value);
                        if (valueExists) {
                            validatedIncludeFilters.push(filter);
                        } else {
                            skippedCount++;
                        }
                    } else {
                        skippedCount++;
                    }
                }
            }

            // Check if any filters were applied
            const totalOriginalFilters = (template.excludeFilters?.length || 0) + (template.includeFilters?.length || 0);
            const totalAppliedFilters = validatedExcludeFilters.length + validatedIncludeFilters.length;

            if (totalAppliedFilters === 0 && totalOriginalFilters > 0) {
                // No filters could be applied
                this.showAlert(
                    `<p>No filters from template "${templateName}" could be applied.</p>
                    <p style="margin-top: 10px; color: #999;">
                        The template contains ${totalOriginalFilters} filter${totalOriginalFilters > 1 ? 's' : ''},
                        but none match the current video's event data.
                    </p>`,
                    'Template Not Compatible'
                );
                return;
            }

            // Apply validated filters
            this.excludeFilters = validatedExcludeFilters;
            this.includeFilters = validatedIncludeFilters;

            // Show notification if some filters were skipped
            if (skippedCount > 0) {
                const message = `Template "${templateName}" loaded with ${totalAppliedFilters} of ${totalOriginalFilters} filters applied.
                                ${skippedCount} filter${skippedCount > 1 ? 's were' : ' was'} skipped due to missing values in current data.`;

                if (window.NotificationManager) {
                    window.NotificationManager.warning(message, 5000);
                } else {
                }
            } else {
            }

            // Re-render and apply
            this.renderFilters();
            this.applyFilters();
        } catch (error) {
            console.error('Failed to load filter template:', error);
            this.showAlert('Failed to load filter template: ' + error.message);
        }
    }
    
    /**
     * Delete a filter template
     */
    async deleteFilterTemplate() {
        const select = document.getElementById('filter-templates');
        const templateName = select?.value;
        
        if (!templateName) {
            this.showAlert('Please select a template to delete');
            return;
        }
        
        const confirmed = await this.showDeleteTemplateConfirm(templateName);
        if (!confirmed) return;
        
        try {
            const templates = await this.loadFilterTemplates();
            delete templates[templateName];
            
            // Save updated templates via IPC
            await ipcRenderer.invoke('save-filter-templates', templates);
            
            // Update UI
            await this.refreshTemplateList();
            
            this.showAlert(`Template "${templateName}" deleted`);
        } catch (error) {
            console.error('Failed to delete filter template:', error);
            this.showAlert('Failed to delete filter template: ' + error.message);
        }
    }
    
    /**
     * Refresh the template list in the UI
     */
    async refreshTemplateList() {
        const select = document.getElementById('filter-templates');
        if (!select) {
            return;
        }

        const templates = await this.loadFilterTemplates();

        // Clear and rebuild options
        select.innerHTML = '<option value="">Load Template...</option>';

        Object.keys(templates).sort().forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });

    }
    
    /**
     * Show custom alert dialog
     */
    showAlert(message, title = 'Alert') {
        document.getElementById('alert-title').textContent = title;
        document.getElementById('alert-message').innerHTML = message;
        document.getElementById('alert-dialog').style.display = 'flex';
    }
    
    /**
     * Close alert dialog
     */
    closeAlert() {
        document.getElementById('alert-dialog').style.display = 'none';
    }
    
    /**
     * Show custom confirm dialog
     */
    showConfirm(message, title = 'Confirm', callback, okText = 'OK') {
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').innerHTML = message;
        const okBtn = document.getElementById('confirm-ok-btn');
        okBtn.textContent = okText;
        okBtn.onclick = () => {
            this.confirmCallback = null;
            document.getElementById('confirm-dialog').style.display = 'none';
            if (callback) callback();
        };
        this.confirmCallback = callback;
        document.getElementById('confirm-dialog').style.display = 'flex';
    }
    
    /**
     * Cancel confirm dialog
     */
    cancelConfirm() {
        this.confirmCallback = null;
        document.getElementById('confirm-dialog').style.display = 'none';
    }
    

    /**
     * Update event metadata with thumbnails using specific file
     */
    async updateEventMetadataWithFile(filePath, thumbnailMap, mainThumbnail) {
        if (!filePath) {
            console.warn('No events file path provided');
            return;
        }

        try {
            const fs = require('fs').promises;

            // Read existing JSON
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);

            // Update metadata with main thumbnail
            if (mainThumbnail) {
                data.metadata = data.metadata || {};
                data.metadata.videoThumbnail = mainThumbnail;
            }

            // Update individual event thumbnails
            if (data.events) {
                data.events.forEach(event => {
                    if (thumbnailMap[event.id]) {
                        event.thumbnail = thumbnailMap[event.id];
                    }
                });
            }

            // Save updated JSON
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error('Failed to update event metadata:', error);
            // Don't throw, just log the error
        }
    }

    /**
     * Update event metadata with thumbnails (legacy)
     */
    async updateEventMetadata(thumbnailMap, mainThumbnail) {
        if (this.currentEventsFile) {
            return this.updateEventMetadataWithFile(this.currentEventsFile, thumbnailMap, mainThumbnail);
        }
        console.warn('No events file loaded');
    }

    /**
     * Show thumbnail progress modal
     */
    showThumbnailProgress(current, total) {
        const modal = document.getElementById('thumbnail-progress-modal');
        if (modal) {
            modal.style.display = 'flex';
            document.getElementById('thumbnail-current').textContent = current;
            document.getElementById('thumbnail-total').textContent = total;
            document.getElementById('thumbnail-progress-fill').style.width = '0%';
        }
    }

    /**
     * Update thumbnail progress
     */
    updateThumbnailProgress(progress) {
        const current = document.getElementById('thumbnail-current');
        const progressFill = document.getElementById('thumbnail-progress-fill');
        const currentEvent = document.getElementById('thumbnail-current-event');

        if (current) current.textContent = progress.current;
        if (progressFill) {
            const percent = (progress.current / progress.total) * 100;
            progressFill.style.width = `${percent}%`;
        }
        if (currentEvent) {
            currentEvent.textContent = `Processing: ${progress.eventName || 'Event'}`;
        }
    }

    /**
     * Hide thumbnail progress modal
     */
    hideThumbnailProgress() {
        const modal = document.getElementById('thumbnail-progress-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    /**
     * Get next available backup filename
     */
    async getNextBackupFilename(originalPath) {
        const fs = require('fs').promises;
        const parsed = path.parse(originalPath);
        let counter = 1;
        let backupPath;

        // Find next available .old-N filename
        while (true) {
            backupPath = path.join(parsed.dir, `${parsed.name}.old-${counter}${parsed.ext}`);
            try {
                await fs.access(backupPath);
                counter++;
            } catch {
                // File doesn't exist, we can use this name
                break;
            }
        }
        
        return backupPath;
    }
    
    /**
     * Show delete template confirmation dialog
     */
    showDeleteTemplateConfirm(templateName) {
        return new Promise((resolve) => {
            // Update dialog content
            document.getElementById('delete-template-name').textContent = templateName;
            
            // Set up button handlers
            const confirmBtn = document.getElementById('delete-template-confirm-btn');
            const cancelBtn = document.getElementById('delete-template-cancel-btn');
            
            const cleanup = () => {
                document.getElementById('delete-template-dialog').style.display = 'none';
                confirmBtn.onclick = null;
                cancelBtn.onclick = null;
            };
            
            confirmBtn.onclick = () => {
                cleanup();
                resolve(true);
            };
            
            cancelBtn.onclick = () => {
                cleanup();
                resolve(false);
            };
            
            // Show dialog
            document.getElementById('delete-template-dialog').style.display = 'flex';
        });
    }

    /**
     * Format seconds to timecode string
     */
    formatTimecode(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    /**
     * Open custom event dialog
     */
    openCustomEventDialog() {
        if (!this.currentVideo || !this.events.length) {
            if (window.NotificationManager) {
                window.NotificationManager.warning('Please load a video and events file first', 3000);
            }
            return;
        }

        // Clear edit mode
        this.editingEventIndex = null;

        // Get current video time
        const currentTime = this.videoPlayer.currentTime;
        const formattedTime = this.formatTimecode(currentTime);

        // Reset form to defaults for new event
        document.getElementById('event-time').value = formattedTime;
        document.getElementById('event-type').value = 'manual';
        document.getElementById('event-subtype').value = 'user_marked';
        document.getElementById('event-name').value = 'Manual Event';
        document.getElementById('event-message').value = '';
        document.getElementById('event-severity').value = 'medium';

        // Update dialog title
        document.querySelector('#custom-event-dialog .modal-header h3').textContent = 'Insert Custom Event';

        // Show the dialog
        document.getElementById('custom-event-dialog').style.display = 'flex';
    }

    /**
     * Edit an existing event
     */
    editEvent(filteredIndex) {
        // Get the actual event from filteredEvents
        const event = this.filteredEvents[filteredIndex];
        if (!event) return;

        // Find the actual index in the main events array
        const actualIndex = this.events.findIndex(e => e.id === event.id);
        if (actualIndex === -1) return;

        // Store the index we're editing
        this.editingEventIndex = actualIndex;

        // Populate form with event data
        document.getElementById('event-time').value = event.videoTimecode || this.formatTimecode(event.videoOffset || 0);
        document.getElementById('event-type').value = event.type || 'manual';
        document.getElementById('event-subtype').value = event.subtype || 'user_marked';
        document.getElementById('event-name').value = event.name || '';
        document.getElementById('event-message').value = event.message || '';
        document.getElementById('event-severity').value = event.severity || 'medium';

        // Update dialog title
        document.querySelector('#custom-event-dialog .modal-header h3').textContent = 'Edit Event';

        // Show the dialog
        document.getElementById('custom-event-dialog').style.display = 'flex';
    }

    /**
     * Close custom event dialog
     */
    closeCustomEventDialog() {
        document.getElementById('custom-event-dialog').style.display = 'none';
    }

    /**
     * Insert or update custom event
     */
    async insertCustomEvent() {
        // Get form values
        const timeStr = document.getElementById('event-time').value;
        const type = document.getElementById('event-type').value;
        const subtype = document.getElementById('event-subtype').value;
        const name = document.getElementById('event-name').value;
        const message = document.getElementById('event-message').value;
        const severity = document.getElementById('event-severity').value;

        // Parse time string to seconds
        const timeParts = timeStr.split(':');
        let videoOffset = 0;
        if (timeParts.length === 3) {
            const [h, m, s] = timeParts;
            const secParts = s.split('.');
            videoOffset = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
        }

        if (this.editingEventIndex !== null && this.editingEventIndex !== undefined) {
            // Edit mode - update existing event
            const existingEvent = this.events[this.editingEventIndex];

            // Update the event while preserving its ID and original timestamp
            existingEvent.videoOffset = videoOffset;
            existingEvent.videoTimecode = this.formatTimecode(videoOffset);
            existingEvent.type = type || 'manual';
            existingEvent.subtype = subtype || 'user_marked';
            existingEvent.name = name || 'Manual Event';
            existingEvent.message = message || 'User marked event - click to edit description';
            existingEvent.severity = severity || 'medium';
            existingEvent.category = type || 'manual';
            existingEvent.data = {
                ...existingEvent.data,
                userNote: message || 'Click to add description',
                editable: true,
                lastEditedAt: new Date().toISOString()
            };

            // Sort events by video offset
            this.events.sort((a, b) => (a.videoOffset || 0) - (b.videoOffset || 0));

            // Save the updated events to file
            if (this.currentEventsFile) {
                try {
                    await this.saveEventsToFile();
                    // No success message - just update silently
                } catch (error) {
                    console.error('Failed to save events:', error);
                    if (window.NotificationManager) {
                        window.NotificationManager.error('Failed to save event: ' + error.message, 5000);
                    }
                }
            }
        } else {
            // Insert mode - create new event
            const now = Date.now();
            const newEvent = {
                id: `evt_${now}_${Math.random().toString(36).substr(2, 9)}`,
                timestamp: new Date().toISOString(),
                videoOffset: videoOffset,
                videoTimecode: this.formatTimecode(videoOffset),
                type: type || 'manual',
                subtype: subtype || 'user_marked',
                name: name || 'Manual Event',
                message: message || 'User marked event - click to edit description',
                severity: severity || 'medium',
                category: type || 'manual',
                categoryInfo: {},
                data: {
                    userNote: message || 'Click to add description',
                    editable: true,
                    markedAt: new Date().toISOString()
                },
                raw: null
            };

            // Add to events array
            this.events.push(newEvent);

            // Sort events by video offset
            this.events.sort((a, b) => (a.videoOffset || 0) - (b.videoOffset || 0));

            // Save the updated events to file
            if (this.currentEventsFile) {
                try {
                    await this.saveEventsToFile();
                    // No success message - just insert silently
                } catch (error) {
                    console.error('Failed to save events:', error);
                    if (window.NotificationManager) {
                        window.NotificationManager.error('Failed to save event: ' + error.message, 5000);
                    }
                }
            }
        }

        // Clear edit mode
        this.editingEventIndex = null;

        // Apply filters to refresh the display
        this.applyFilters();

        // Close the dialog
        this.closeCustomEventDialog();
    }

    /**
     * Save events back to the JSON file
     */
    async saveEventsToFile() {
        if (!this.currentEventsFile) {
            throw new Error('No events file loaded');
        }

        const fs = require('fs').promises;

        // Build the full JSON structure
        const data = {
            metadata: {
                version: '1.0.0',
                recorder: 'SC-Recorder',
                eventCount: this.events.length,
                modifiedAt: new Date().toISOString()
            },
            events: this.events
        };

        // Write to file
        await fs.writeFile(this.currentEventsFile, JSON.stringify(data, null, 2));
    }

}

// Initialize when view is shown
window.postController = null;

// Create controller when view is activated
window.initializePostView = function() {
    if (!window.postController) {
        console.log('Initializing Post Controller...');
        window.postController = new PostController();
    }
};