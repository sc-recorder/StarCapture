// Filter Editor Controller - Enhanced version matching playback/review functionality

class FilterEditorController {
    constructor() {
        this.templates = {};
        this.currentTemplate = null;
        this.defaultFilterName = null;
        this.eventPatterns = null;
        this.categories = null;
        this.availableFields = new Set();
        
        // Filter arrays
        this.excludeFilters = [];
        this.includeFilters = [];
        
        this.initialize();
    }
    
    async initialize() {
        await this.loadEventPatterns();
        await this.loadTemplates();
        this.setupEventListeners();
        this.updateTemplateSelect();
        this.discoverAvailableFields();
        this.updateFilterSummary();
    }
    
    async loadEventPatterns() {
        try {
            // Request patterns from main process
            const patterns = await ipcRenderer.invoke('get-event-patterns');
            
            if (patterns) {
                // Extract event types and categories
                this.eventPatterns = patterns.patterns || [];
                this.categories = patterns.categories || {};
                console.log('Loaded', this.eventPatterns.length, 'event patterns for filter editor');
            } else {
                throw new Error('No patterns returned from main process');
            }
        } catch (error) {
            console.error('Failed to load event patterns:', error);
            this.eventPatterns = [];
            this.categories = {};
        }
    }
    
    discoverAvailableFields() {
        // Clear existing fields
        this.availableFields.clear();
        
        // Add standard fields matching playback/review
        this.availableFields.add('subtype');  // Event Subtype (the actual event ID)
        this.availableFields.add('category');
        this.availableFields.add('message');
        this.availableFields.add('severity');
        
        // Discover fields from event patterns
        if (this.eventPatterns) {
            this.eventPatterns.forEach(pattern => {
                if (pattern.fields) {
                    Object.keys(pattern.fields).forEach(field => {
                        this.availableFields.add(field);
                    });
                }
            });
        }
        
        console.log('Available fields:', Array.from(this.availableFields));
    }
    
    async loadTemplates() {
        try {
            // Load templates from file
            const templates = await ipcRenderer.invoke('load-filter-templates');
            if (templates) {
                this.templates = templates;
            } else {
                this.templates = {};
            }

            // Load default filter setting from config
            const config = await ipcRenderer.invoke('load-config');
            if (config && config.settings && config.settings.defaultNotificationFilter) {
                this.defaultFilterName = config.settings.defaultNotificationFilter.name;
            }

            // Update the UI dropdown with the freshly loaded templates
            this.updateTemplateSelect();
        } catch (error) {
            console.error('Failed to load templates:', error);
            this.templates = {};
        }
    }
    
    async saveTemplates() {
        try {
            // Save templates to file
            await ipcRenderer.invoke('save-filter-templates', this.templates);
            
            // Save default filter setting to config via IPC
            if (this.defaultFilterName) {
                await this.saveDefaultFilterToConfig();
            }
            
            // Show save confirmation
            this.showSaveStatus();
        } catch (error) {
            console.error('Failed to save templates:', error);
        }
    }
    
    async saveDefaultFilterToConfig() {
        try {
            // Get the default filter template
            const defaultTemplate = this.templates[this.defaultFilterName];
            if (defaultTemplate) {
                // Send to main process to save in config
                await ipcRenderer.invoke('save-default-filter', {
                    name: this.defaultFilterName,
                    template: defaultTemplate
                });
            }
        } catch (error) {
            console.error('Failed to save default filter to config:', error);
        }
    }
    
    setupEventListeners() {
        // Template select
        document.getElementById('editor-template-select')?.addEventListener('change', (e) => {
            this.loadTemplate(e.target.value);
        });
        
        // Save button
        document.getElementById('editor-save-btn')?.addEventListener('click', async () => {
            await this.saveCurrentTemplate();
        });
        
        // Delete button
        document.getElementById('editor-delete-btn')?.addEventListener('click', async () => {
            await this.deleteCurrentTemplate();
        });
        
        // Clear button
        document.getElementById('editor-clear-btn')?.addEventListener('click', () => {
            this.clearAllFilters();
        });
        
        // Add exclude filter
        document.getElementById('editor-add-exclude')?.addEventListener('click', () => {
            this.addExcludeFilter();
        });
        
        // Add include filter
        document.getElementById('editor-add-include')?.addEventListener('click', () => {
            this.addIncludeFilter();
        });
        
        // Default filter checkbox
        document.getElementById('editor-default-filter')?.addEventListener('change', async (e) => {
            await this.handleDefaultFilterChange(e.target.checked);
        });
        
        // Export button
        document.getElementById('editor-export-btn')?.addEventListener('click', () => {
            this.exportTemplates();
        });
        
        // Import button
        document.getElementById('editor-import-btn')?.addEventListener('click', () => {
            this.importTemplates();
        });

        // Template delete confirmation modal buttons
        document.getElementById('template-delete-confirm')?.addEventListener('click', async () => {
            await this.confirmDeleteTemplate();
        });

        document.getElementById('template-delete-cancel')?.addEventListener('click', () => {
            this.hideDeleteConfirmModal();
        });
    }
    
    updateTemplateSelect() {
        const select = document.getElementById('editor-template-select');
        if (!select) return;
        
        select.innerHTML = '<option value="">Load Template...</option>';
        
        Object.keys(this.templates).sort().forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            if (name === this.defaultFilterName) {
                option.textContent += ' (Default)';
            }
            select.appendChild(option);
        });
    }
    
    loadTemplate(name) {
        if (!name) {
            // Reset to new template
            this.currentTemplate = null;
            document.getElementById('editor-template-name').value = '';
            document.getElementById('editor-delete-btn').disabled = true;
            document.getElementById('editor-default-filter').checked = false;
            return;
        }
        
        // Load existing template
        this.currentTemplate = name;
        const template = this.templates[name];
        if (!template) return;
        
        document.getElementById('editor-template-name').value = name;
        document.getElementById('editor-delete-btn').disabled = false;
        document.getElementById('editor-default-filter').checked = (name === this.defaultFilterName);
        
        // Load filters
        this.excludeFilters = template.excludeFilters || [];
        this.includeFilters = template.includeFilters || [];
        
        // Ensure all filters have IDs and logic operators
        this.excludeFilters.forEach(filter => {
            if (!filter.id) filter.id = Date.now() + Math.random();
            if (!filter.logicOperator) filter.logicOperator = 'AND';
            if (!filter.operator) filter.operator = 'equals';
        });
        
        this.includeFilters.forEach(filter => {
            if (!filter.id) filter.id = Date.now() + Math.random();
            if (!filter.logicOperator) filter.logicOperator = 'OR';
            if (!filter.operator) filter.operator = 'equals';
        });
        
        this.renderFilters();
        this.updateFilterSummary();
    }
    
    addExcludeFilter() {
        const filterId = Date.now();
        this.excludeFilters.push({
            id: filterId,
            field: '',
            value: '',
            operator: 'equals',
            logicOperator: 'AND'
        });
        this.renderFilters();
        this.updateFilterSummary();
    }
    
    addIncludeFilter() {
        const filterId = Date.now();
        this.includeFilters.push({
            id: filterId,
            field: '',
            value: '',
            operator: 'equals',
            logicOperator: 'OR'
        });
        this.renderFilters();
        this.updateFilterSummary();
    }
    
    removeFilter(filterId, type) {
        if (type === 'exclude') {
            this.excludeFilters = this.excludeFilters.filter(f => f.id !== filterId);
        } else {
            this.includeFilters = this.includeFilters.filter(f => f.id !== filterId);
        }
        this.renderFilters();
        this.updateFilterSummary();
    }
    
    renderFilters() {
        // Render exclude filters
        const excludeContainer = document.getElementById('editor-exclude-list');
        excludeContainer.innerHTML = '';
        this.excludeFilters.forEach(filter => {
            this.renderFilterRow(filter, 'exclude', excludeContainer);
        });
        
        // Render include filters
        const includeContainer = document.getElementById('editor-include-list');
        includeContainer.innerHTML = '';
        this.includeFilters.forEach(filter => {
            this.renderFilterRow(filter, 'include', includeContainer);
        });
    }
    
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
            logicSelect.value = filter.logicOperator || (type === 'exclude' ? 'AND' : 'OR');
            logicSelect.onchange = () => {
                filter.logicOperator = logicSelect.value;
            };
            filterRow.appendChild(logicSelect);
        }
        
        // Create field selector
        const fieldSelect = document.createElement('select');
        fieldSelect.className = 'filter-field';
        fieldSelect.innerHTML = '<option value="">Select field...</option>';
        
        // Add available fields
        Array.from(this.availableFields).sort().forEach(field => {
            const option = document.createElement('option');
            option.value = field;
            option.textContent = this.getFieldDisplayName(field);
            fieldSelect.appendChild(option);
        });
        
        fieldSelect.value = filter.field || '';
        fieldSelect.onchange = () => {
            filter.field = fieldSelect.value;
            this.updateValueOptions(filter, filterRow);
        };
        
        // Create value input/select
        const valueContainer = document.createElement('div');
        valueContainer.className = 'filter-value-container';
        valueContainer.style.flex = '1';
        
        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'filter-remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => this.removeFilter(filter.id, type);
        
        // Set operator to 'equals' always (matching playback behavior)
        filter.operator = 'equals';
        
        filterRow.appendChild(fieldSelect);
        filterRow.appendChild(valueContainer);
        filterRow.appendChild(removeBtn);
        container.appendChild(filterRow);
        
        // Set up value input
        this.updateValueOptions(filter, filterRow);
    }
    
    updateValueOptions(filter, filterRow) {
        const container = filterRow.querySelector('.filter-value-container');
        container.innerHTML = '';
        
        if (filter.field === 'subtype') {
            // Create dropdown for event subtypes (event IDs)
            const select = document.createElement('select');
            select.className = 'filter-value';
            select.innerHTML = '<option value="">Select event...</option>';
            
            // Group events by category
            const eventsByCategory = {};
            this.eventPatterns.forEach(event => {
                if (!eventsByCategory[event.category]) {
                    eventsByCategory[event.category] = [];
                }
                eventsByCategory[event.category].push(event);
            });
            
            Object.keys(eventsByCategory).forEach(category => {
                const optgroup = document.createElement('optgroup');
                const categoryInfo = this.categories[category];
                optgroup.label = categoryInfo ? categoryInfo.name : category;
                
                eventsByCategory[category].forEach(event => {
                    const option = document.createElement('option');
                    option.value = event.id;
                    option.textContent = event.name;
                    optgroup.appendChild(option);
                });
                
                select.appendChild(optgroup);
            });
            
            select.value = filter.value || '';
            select.onchange = () => {
                filter.value = select.value;
            };
            container.appendChild(select);
            
        } else if (filter.field === 'category') {
            // Create dropdown for categories
            const select = document.createElement('select');
            select.className = 'filter-value';
            select.innerHTML = '<option value="">Select category...</option>';
            
            Object.keys(this.categories).forEach(catKey => {
                const option = document.createElement('option');
                option.value = catKey;
                option.textContent = this.categories[catKey].name;
                select.appendChild(option);
            });
            
            select.value = filter.value || '';
            select.onchange = () => {
                filter.value = select.value;
            };
            container.appendChild(select);
            
        } else if (filter.field === 'severity') {
            // Create dropdown for severity
            const select = document.createElement('select');
            select.className = 'filter-value';
            select.innerHTML = `
                <option value="">Select severity...</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
            `;
            select.value = filter.value || '';
            select.onchange = () => {
                filter.value = select.value;
            };
            container.appendChild(select);
            
        } else {
            // Create text input for other fields
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'filter-value';
            input.placeholder = 'Enter value...';
            input.value = filter.value || '';
            input.oninput = () => {
                filter.value = input.value;
            };
            container.appendChild(input);
        }
    }
    
    getFieldDisplayName(field) {
        const fieldNames = {
            subtype: 'Event Subtype',
            category: 'Category',
            message: 'Message',
            severity: 'Severity',
            player: 'Player Name',
            victim: 'Victim Name',
            killer: 'Killer Name',
            weapon: 'Weapon',
            vehicle: 'Vehicle',
            zone: 'Zone/Location',
            timestamp: 'Timestamp'
        };
        return fieldNames[field] || field;
    }
    
    async saveCurrentTemplate() {
        const name = document.getElementById('editor-template-name').value.trim();
        if (!name) {
            this.showMessage('Please enter a template name', 'warning');
            return;
        }
        
        // Filter out empty filters
        const activeExcludes = this.excludeFilters.filter(f => f.field && f.value);
        const activeIncludes = this.includeFilters.filter(f => f.field && f.value);
        
        // Save template
        this.templates[name] = {
            name: name,
            excludeFilters: activeExcludes,
            includeFilters: activeIncludes,
            createdAt: this.templates[name]?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // Update default filter if checkbox is checked
        if (document.getElementById('editor-default-filter').checked) {
            // Clear previous default
            if (this.defaultFilterName && this.defaultFilterName !== name) {
                if (this.templates[this.defaultFilterName]) {
                    delete this.templates[this.defaultFilterName].isDefault;
                }
            }
            this.defaultFilterName = name;
            this.templates[name].isDefault = true;
        } else if (this.defaultFilterName === name) {
            // Unchecked - remove as default
            this.defaultFilterName = null;
            delete this.templates[name].isDefault;
        }
        
        this.currentTemplate = name;
        await this.saveTemplates();
        this.updateTemplateSelect();
        
        // Select the saved template
        document.getElementById('editor-template-select').value = name;
        document.getElementById('editor-delete-btn').disabled = false;
    }
    
    async deleteCurrentTemplate() {
        if (!this.currentTemplate) return;

        // Store the template name to delete
        this.templateToDelete = this.currentTemplate;

        // Show custom confirmation modal
        this.showDeleteConfirmModal(`Are you sure you want to delete the template "${this.currentTemplate}"?`);
    }

    showDeleteConfirmModal(message) {
        const modal = document.getElementById('template-delete-modal');
        const messageEl = document.getElementById('template-delete-message');

        if (!modal || !messageEl) return;

        messageEl.textContent = message;
        modal.style.display = 'flex';
    }

    hideDeleteConfirmModal() {
        const modal = document.getElementById('template-delete-modal');
        if (modal) {
            modal.style.display = 'none';
        }
        this.templateToDelete = null;
    }

    /**
     * Show message notification (non-blocking)
     */
    showMessage(message, type = 'info') {
        const messageDiv = document.createElement('div');
        messageDiv.className = `filter-editor-message message-${type}`;
        messageDiv.textContent = message;

        // Style based on type
        const colors = {
            'info': '#4a9eff',
            'success': '#4aff9e',
            'warning': '#ff9e4a',
            'error': '#ff4444'
        };

        messageDiv.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            color: white;
            background: ${colors[type] || colors.info};
            padding: 12px 20px;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            z-index: 10000;
            max-width: 400px;
            animation: slideIn 0.3s ease-out;
        `;

        document.body.appendChild(messageDiv);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            messageDiv.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => messageDiv.remove(), 300);
        }, 5000);
    }

    async confirmDeleteTemplate() {
        if (!this.templateToDelete) {
            this.hideDeleteConfirmModal();
            return;
        }

        // Check if this was the default filter
        if (this.defaultFilterName === this.templateToDelete) {
            this.defaultFilterName = null;
            // Notify main process to clear default filter
            await ipcRenderer.invoke('clear-default-filter');
        }

        delete this.templates[this.templateToDelete];
        await this.saveTemplates();
        this.updateTemplateSelect();

        // Reset to new template
        this.currentTemplate = null;
        document.getElementById('editor-template-name').value = '';
        document.getElementById('editor-delete-btn').disabled = true;
        document.getElementById('editor-default-filter').checked = false;
        this.clearAllFilters();

        this.hideDeleteConfirmModal();
    }
    
    clearAllFilters() {
        this.excludeFilters = [];
        this.includeFilters = [];
        this.renderFilters();
        this.updateFilterSummary();
    }
    
    async handleDefaultFilterChange(checked) {
        const name = document.getElementById('editor-template-name').value.trim();
        if (!name && checked) {
            this.showMessage('Please save the template first before setting it as default', 'warning');
            document.getElementById('editor-default-filter').checked = false;
            return;
        }
        
        if (checked && this.currentTemplate) {
            // Set as default
            if (this.defaultFilterName && this.defaultFilterName !== this.currentTemplate) {
                // Clear previous default
                if (this.templates[this.defaultFilterName]) {
                    delete this.templates[this.defaultFilterName].isDefault;
                }
            }
            this.defaultFilterName = this.currentTemplate;
            if (this.templates[this.currentTemplate]) {
                this.templates[this.currentTemplate].isDefault = true;
            }
            await this.saveTemplates();
            this.updateTemplateSelect();
        }
    }
    
    updateFilterSummary() {
        const countElement = document.getElementById('editor-filter-count');
        if (!countElement) return;
        
        const activeExcludes = this.excludeFilters.filter(f => f.field && f.value).length;
        const activeIncludes = this.includeFilters.filter(f => f.field && f.value).length;
        const total = activeExcludes + activeIncludes;
        
        if (total === 0) {
            countElement.textContent = 'No filters configured';
        } else {
            let summary = [];
            if (activeExcludes > 0) {
                summary.push(`${activeExcludes} exclude`);
            }
            if (activeIncludes > 0) {
                summary.push(`${activeIncludes} include`);
            }
            countElement.textContent = `${total} filter${total !== 1 ? 's' : ''} (${summary.join(', ')})`;
        }
    }
    
    showSaveStatus() {
        const statusElement = document.getElementById('editor-save-status');
        if (statusElement) {
            statusElement.style.display = 'block';
            setTimeout(() => {
                statusElement.style.display = 'none';
            }, 2000);
        }
    }
    
    exportTemplates() {
        const dataStr = JSON.stringify(this.templates, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'filter-templates.json';
        a.click();
        URL.revokeObjectURL(url);
    }
    
    async importTemplates() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                const text = await file.text();
                const imported = JSON.parse(text);
                
                // Merge with existing templates
                Object.assign(this.templates, imported);
                
                // Check for default filter in imported templates
                Object.keys(imported).forEach(name => {
                    if (imported[name].isDefault) {
                        this.defaultFilterName = name;
                    }
                });
                
                await this.saveTemplates();
                this.updateTemplateSelect();
                this.showMessage('Templates imported successfully!', 'success');
            } catch (error) {
                console.error('Failed to import templates:', error);
                this.showMessage('Failed to import templates. Please check the file format.', 'error');
            }
        };
        
        input.click();
    }
}

// Initialize when loaded
function initializeFilterEditor() {
    window.filterEditorController = new FilterEditorController();
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initializeFilterEditor, FilterEditorController };
}