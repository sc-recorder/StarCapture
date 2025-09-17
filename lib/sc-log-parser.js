const fs = require('fs').promises;
const path = require('path');
const { getPatternsPath } = require('./config-path-helper');

/**
 * Star Citizen Log Parser
 * Parses game logs using configurable regex patterns from JSON
 */
class SCLogParser {
    constructor() {
        this.patterns = null;
        this.transforms = null;
        this.categories = null;
        this.compiledPatterns = new Map();
    }

    /**
     * Load patterns from JSON file
     */
    async loadPatterns(patternsPath = null) {
        try {
            // Use the helper to get the correct path for production/dev
            const configPath = patternsPath || getPatternsPath();
            
            console.log('[SCLogParser] Loading patterns from:', configPath);
            const content = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(content);
            
            this.patterns = config.patterns;
            this.transforms = config.transforms;
            this.categories = config.categories;
            
            // Compile regex patterns for better performance
            this.compilePatterns();
            
            console.log(`[SCLogParser] Loaded ${this.patterns.length} patterns`);
            return true;
        } catch (error) {
            console.error('[SCLogParser] Failed to load patterns:', error);
            // Load fallback minimal patterns
            this.loadFallbackPatterns();
            return false;
        }
    }

    /**
     * Compile regex patterns for performance
     */
    compilePatterns() {
        this.compiledPatterns.clear();
        
        for (const pattern of this.patterns) {
            try {
                this.compiledPatterns.set(pattern.id, {
                    ...pattern,
                    regex: new RegExp(pattern.pattern, 'gm')
                });
            } catch (error) {
                console.error(`[SCLogParser] Failed to compile pattern ${pattern.id}:`, error);
            }
        }
    }

    /**
     * Load minimal fallback patterns if JSON fails
     */
    loadFallbackPatterns() {
        this.patterns = [
            {
                id: 'player_kill',
                category: 'combat',
                name: 'Player Kill',
                pattern: "CActor::Kill: '([^']+)'.*?killed by '([^']+)'.*?using '([^']+)'",
                fields: {
                    victim: { group: 1 },
                    killer: { group: 2 },
                    weapon: { group: 3 }
                },
                message: '{killer} killed {victim} with {weapon}'
            },
            {
                id: 'game_joined',
                category: 'system',
                name: 'Game Joined',
                pattern: '\\{Join PU\\}',
                fields: {},
                message: 'Joined Persistent Universe'
            }
        ];
        
        this.transforms = {};
        this.categories = {
            combat: { name: 'Combat', color: '#ff4444' },
            system: { name: 'System', color: '#ffaa44' }
        };
        
        this.compilePatterns();
    }

    /**
     * Parse a log line for events
     */
    parseLine(line) {
        const events = [];
        
        for (const [id, pattern] of this.compiledPatterns) {
            // Reset regex lastIndex for global patterns
            pattern.regex.lastIndex = 0;
            
            const match = pattern.regex.exec(line);
            if (match) {
                const event = this.extractEvent(pattern, match, line);
                if (event) {
                    events.push(event);
                }
            }
        }
        
        return events;
    }

    /**
     * Extract event data from regex match
     */
    extractEvent(pattern, match, rawLine) {
        const event = {
            id: pattern.id,
            name: pattern.name,
            category: pattern.category,
            severity: pattern.severity || 'low',
            timestamp: new Date().toISOString(),
            raw: rawLine,
            data: {}
        };
        
        // Extract fields from regex groups
        if (pattern.fields) {
            for (const [fieldName, fieldConfig] of Object.entries(pattern.fields)) {
                let value = null;
                
                if (fieldConfig.value !== undefined) {
                    // Static value
                    value = fieldConfig.value;
                } else if (fieldConfig.group !== undefined) {
                    // Extract from regex group
                    value = match[fieldConfig.group];
                    
                    // Apply transform if specified
                    if (value && fieldConfig.transform) {
                        value = this.applyTransform(value, fieldConfig.transform);
                    }
                }
                
                event.data[fieldName] = value;
            }
        }
        
        // Generate message from template
        if (pattern.message) {
            event.message = this.formatMessage(pattern.message, event.data);
        } else {
            event.message = pattern.name;
        }
        
        // Add category info
        if (this.categories && this.categories[pattern.category]) {
            event.categoryInfo = this.categories[pattern.category];
        }
        
        return event;
    }

    /**
     * Apply transform to a value
     */
    applyTransform(value, transformName) {
        if (!this.transforms || !this.transforms[transformName]) {
            return value;
        }
        
        const transform = this.transforms[transformName];
        
        switch (transform.type) {
            case 'timestamp':
                // Parse ISO 8601 timestamp
                try {
                    return new Date(value).toISOString();
                } catch (e) {
                    return value;
                }
                
            case 'cleanName':
                let cleaned = value;
                
                if (transform.operations) {
                    for (const op of transform.operations) {
                        if (op.stripPrefix) {
                            for (const prefix of op.stripPrefix) {
                                if (cleaned.startsWith(prefix)) {
                                    cleaned = cleaned.substring(prefix.length);
                                    break;
                                }
                            }
                        }
                        
                        if (op.removeTrailingNumbers) {
                            cleaned = cleaned.replace(/_\d+$/, '');
                        }
                        
                        if (op.replaceUnderscores) {
                            cleaned = cleaned.replace(/_/g, ' ');
                        }
                    }
                }
                
                return cleaned;
                
            default:
                return value;
        }
    }

    /**
     * Format message template with data
     */
    formatMessage(template, data) {
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            return data[key] || match;
        });
    }

    /**
     * Parse multiple lines
     */
    parseLines(lines) {
        const allEvents = [];
        
        for (const line of lines) {
            const events = this.parseLine(line);
            allEvents.push(...events);
        }
        
        return allEvents;
    }

    /**
     * Parse an entire log file
     */
    async parseFile(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            return this.parseLines(lines);
        } catch (error) {
            console.error('[SCLogParser] Failed to parse file:', error);
            return [];
        }
    }

    /**
     * Get statistics about parsed events
     */
    getEventStats(events) {
        const stats = {
            total: events.length,
            byCategory: {},
            bySeverity: {},
            byType: {}
        };
        
        for (const event of events) {
            // Count by category
            stats.byCategory[event.category] = (stats.byCategory[event.category] || 0) + 1;
            
            // Count by severity
            stats.bySeverity[event.severity] = (stats.bySeverity[event.severity] || 0) + 1;
            
            // Count by type
            stats.byType[event.id] = (stats.byType[event.id] || 0) + 1;
        }
        
        return stats;
    }

    /**
     * Filter events by criteria
     */
    filterEvents(events, criteria) {
        return events.filter(event => {
            if (criteria.category && event.category !== criteria.category) {
                return false;
            }
            
            if (criteria.severity) {
                const severityLevels = { low: 1, medium: 2, high: 3 };
                const eventLevel = severityLevels[event.severity] || 1;
                const criteriaLevel = severityLevels[criteria.severity] || 1;
                if (eventLevel < criteriaLevel) {
                    return false;
                }
            }
            
            if (criteria.startTime && new Date(event.timestamp) < new Date(criteria.startTime)) {
                return false;
            }
            
            if (criteria.endTime && new Date(event.timestamp) > new Date(criteria.endTime)) {
                return false;
            }
            
            if (criteria.search) {
                const searchLower = criteria.search.toLowerCase();
                if (!event.message.toLowerCase().includes(searchLower) &&
                    !event.raw.toLowerCase().includes(searchLower)) {
                    return false;
                }
            }
            
            return true;
        });
    }

    /**
     * Get available categories
     */
    getCategories() {
        return this.categories || {};
    }

    /**
     * Get available patterns
     */
    getPatterns() {
        return this.patterns || [];
    }

    /**
     * Check if parser is ready
     */
    isReady() {
        return this.compiledPatterns.size > 0;
    }
}

module.exports = SCLogParser;