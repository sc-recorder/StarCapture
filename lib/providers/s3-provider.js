const fs = require('fs').promises;
const path = require('path');
const { Upload } = require('@aws-sdk/lib-storage');
const { S3Client, HeadBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

/**
 * S3 Provider
 * Handles uploads to S3-compatible storage services
 */
class S3Provider {
    constructor() {
        this.name = 's3';
        this.displayName = 'S3-Compatible Storage';
    }

    /**
     * Validate credentials and configuration
     */
    async validateCredentials(credentials, config) {
        const { accessKeyId, secretAccessKey } = credentials;
        const { endpoint, bucket, region = 'us-east-1' } = config;

        if (!accessKeyId || !secretAccessKey) {
            throw new Error('Access Key ID and Secret Access Key are required');
        }

        if (!bucket) {
            throw new Error('Bucket name is required');
        }

        // Create S3 client
        const client = this.createClient(credentials, config);

        try {
            // Test connection by checking if bucket exists
            const command = new HeadBucketCommand({ Bucket: bucket });
            await client.send(command);
            return true;
        } catch (error) {
            if (error.name === 'NotFound') {
                throw new Error(`Bucket "${bucket}" not found`);
            } else if (error.name === 'Forbidden') {
                throw new Error('Access denied to bucket (check credentials)');
            } else {
                throw new Error(`Connection failed: ${error.message}`);
            }
        }
    }

    /**
     * Test connection to S3
     */
    async testConnection(credentials, config) {
        await this.validateCredentials(credentials, config);
        return {
            success: true,
            message: 'Successfully connected to S3',
            bucket: config.bucket,
            endpoint: config.endpoint || 'AWS S3'
        };
    }

    /**
     * Upload a file to S3
     */
    async upload(credentials, config, filePath, metadata = {}, onProgress) {
        const { bucket, prefix = '', region = 'us-east-1', storageClass = 'STANDARD', publicUrl = '' } = config;

        // Get file info
        const stats = await fs.stat(filePath);
        const fileName = path.basename(filePath);
        const fileStream = require('fs').createReadStream(filePath);

        // Generate S3 key - use original filename or add timestamp if requested
        let key;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        if (metadata && metadata.preserveFilename) {
            // Use original filename without timestamp
            key = prefix ? `${prefix}/${fileName}` : fileName;
        } else {
            // Add timestamp prefix for uniqueness (optional)
            key = prefix ? `${prefix}/${timestamp}_${fileName}` : `${timestamp}_${fileName}`;
        }

        // Create S3 client
        const client = this.createClient(credentials, config);

        // Prepare upload parameters
        const uploadParams = {
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            StorageClass: storageClass,
            Metadata: {}
        };

        // Ensure all metadata values are strings
        // AWS SDK requires all metadata values to be strings
        const safeMetadata = {
            'original-filename': fileName,
            'upload-timestamp': timestamp,
            'file-size': stats.size.toString()
        };

        // Add any additional metadata, ensuring all values are strings
        if (metadata) {
            for (const [key, value] of Object.entries(metadata)) {
                if (value !== undefined && value !== null) {
                    safeMetadata[key] = String(value);
                }
            }
        }

        uploadParams.Metadata = safeMetadata;

        // Add content type if available
        const contentType = this.getContentType(fileName);
        if (contentType) {
            uploadParams.ContentType = contentType;
        }

        // Handle ACL for public access if requested
        if (metadata && metadata.makePublic) {
            uploadParams.ACL = 'public-read';
        }

        // Handle small files directly
        if (stats.size < 5 * 1024 * 1024) { // Less than 5MB
            try {
                await client.send(new PutObjectCommand(uploadParams));

                if (onProgress) {
                    onProgress({
                        percentage: 100,
                        bytesUploaded: stats.size,
                        totalBytes: stats.size
                    });
                }

                // Generate the public URL if configured
                let location;
                if (publicUrl) {
                    // Remove trailing slash from publicUrl if present
                    const baseUrl = publicUrl.replace(/\/$/, '');
                    location = `${baseUrl}/${key}`;
                } else {
                    // Default S3 URL format
                    location = `s3://${bucket}/${key}`;
                }

                // Upload metadata JSON if requested
                let metadataKey = null;
                if (metadata && metadata.includeMetadata) {
                    // Check if there's a corresponding JSON file
                    const jsonPath = filePath.replace(/\.[^/.]+$/, '.json');
                    try {
                        await fs.stat(jsonPath);
                        // JSON file exists, upload it
                        metadataKey = key.replace(/\.[^/.]+$/, '.json');

                        const jsonContent = await fs.readFile(jsonPath, 'utf8');
                        const putJsonCommand = new PutObjectCommand({
                            Bucket: bucket,
                            Key: metadataKey,
                            Body: jsonContent,
                            ContentType: 'application/json'
                        });

                        await client.send(putJsonCommand);
                    } catch (error) {
                        // JSON file doesn't exist or failed to upload, continue without it
                        console.log('No metadata JSON file found or failed to upload:', error.message);
                    }
                }

                return {
                    success: true,
                    location,
                    key,
                    bucket,
                    size: stats.size,
                    timestamp,
                    metadataKey
                };
            } catch (error) {
                throw new Error(`Upload failed: ${error.message}`);
            }
        }

        // Use multipart upload for larger files
        try {
            const parallelUploads = new Upload({
                client,
                params: uploadParams,
                queueSize: 4, // Concurrent parts
                partSize: 5 * 1024 * 1024, // 5MB parts
                leavePartsOnError: false
            });

            // Track progress
            parallelUploads.on('httpUploadProgress', (progress) => {
                if (onProgress && progress.loaded && progress.total) {
                    const percentage = Math.round((progress.loaded / progress.total) * 100);
                    onProgress({
                        percentage,
                        bytesUploaded: progress.loaded,
                        totalBytes: progress.total
                    });
                }
            });

            const result = await parallelUploads.done();

            // Generate the public URL if configured
            let location;
            if (publicUrl) {
                // Remove trailing slash from publicUrl if present
                const baseUrl = publicUrl.replace(/\/$/, '');
                location = `${baseUrl}/${key}`;
            } else {
                // Use AWS SDK result location or default format
                location = result.Location || `s3://${bucket}/${key}`;
            }

            // Upload metadata JSON if requested
            let metadataKey = null;
            if (metadata && metadata.includeMetadata) {
                // Check if there's a corresponding JSON file
                const jsonPath = filePath.replace(/\.[^/.]+$/, '.json');
                try {
                    await fs.stat(jsonPath);
                    // JSON file exists, upload it
                    const jsonFileName = path.basename(jsonPath);
                    metadataKey = key.replace(/\.[^/.]+$/, '.json');

                    const jsonContent = await fs.readFile(jsonPath, 'utf8');
                    const putJsonCommand = new PutObjectCommand({
                        Bucket: bucket,
                        Key: metadataKey,
                        Body: jsonContent,
                        ContentType: 'application/json'
                    });

                    await client.send(putJsonCommand);
                } catch (error) {
                    // JSON file doesn't exist or failed to upload, continue without it
                    console.log('No metadata JSON file found or failed to upload:', error.message);
                }
            }

            return {
                success: true,
                location,
                key,
                bucket,
                size: stats.size,
                timestamp,
                etag: result.ETag,
                metadataKey
            };
        } catch (error) {
            throw new Error(`Multipart upload failed: ${error.message}`);
        }
    }

    /**
     * Create S3 client with credentials
     */
    createClient(credentials, config) {
        const { accessKeyId, secretAccessKey } = credentials;
        const { endpoint, region = 'us-east-1', forcePathStyle = false } = config;

        const clientConfig = {
            region,
            credentials: {
                accessKeyId,
                secretAccessKey
            }
        };

        // Add custom endpoint for non-AWS S3 services
        if (endpoint) {
            // AWS SDK v3 requires endpoint to be a URL string
            // Ensure the endpoint is a proper string
            clientConfig.endpoint = String(endpoint).trim();

            // For S3-compatible services, force path style is often needed
            // In SDK v3, this is configured differently
            if (forcePathStyle) {
                clientConfig.forcePathStyle = true;
            }
        }

        return new S3Client(clientConfig);
    }

    /**
     * Get content type for file
     */
    getContentType(fileName) {
        const ext = path.extname(fileName).toLowerCase();
        const contentTypes = {
            '.mp4': 'video/mp4',
            '.mkv': 'video/x-matroska',
            '.avi': 'video/x-msvideo',
            '.mov': 'video/quicktime',
            '.webm': 'video/webm',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.json': 'application/json',
            '.txt': 'text/plain'
        };

        return contentTypes[ext] || 'application/octet-stream';
    }

    /**
     * Get configuration schema for UI
     */
    getConfigSchema() {
        return {
            credentials: [
                {
                    name: 'accessKeyId',
                    label: 'Access Key ID',
                    type: 'text',
                    required: true,
                    placeholder: 'AKIAIOSFODNN7EXAMPLE'
                },
                {
                    name: 'secretAccessKey',
                    label: 'Secret Access Key',
                    type: 'password',
                    required: true,
                    placeholder: '••••••••••••••••••••'
                }
            ],
            config: [
                {
                    name: 'bucket',
                    label: 'Bucket Name',
                    type: 'text',
                    required: true,
                    placeholder: 'my-bucket'
                },
                {
                    name: 'region',
                    label: 'Region',
                    type: 'text',
                    required: false,
                    default: 'us-east-1',
                    placeholder: 'us-east-1'
                },
                {
                    name: 'endpoint',
                    label: 'Custom Endpoint (optional)',
                    type: 'text',
                    required: false,
                    placeholder: 'https://s3.example.com',
                    description: 'Full URL including https:// for non-AWS S3 services (e.g., MinIO, Wasabi, Cloudflare R2)'
                },
                {
                    name: 'publicUrl',
                    label: 'Public URL Base (optional)',
                    type: 'text',
                    required: false,
                    placeholder: 'https://pub-example.r2.dev',
                    description: 'Base URL for public access if different from endpoint (e.g., R2 public hostname)'
                },
                {
                    name: 'prefix',
                    label: 'Path Prefix (optional)',
                    type: 'text',
                    required: false,
                    placeholder: 'recordings/star-citizen',
                    description: 'Folder path within the bucket'
                },
                {
                    name: 'forcePathStyle',
                    label: 'Force Path Style',
                    type: 'checkbox',
                    required: false,
                    default: false,
                    description: 'Required for some S3-compatible services'
                },
                {
                    name: 'storageClass',
                    label: 'Storage Class',
                    type: 'select',
                    required: false,
                    default: 'STANDARD',
                    options: [
                        { value: 'STANDARD', label: 'Standard' },
                        { value: 'STANDARD_IA', label: 'Standard-IA' },
                        { value: 'ONEZONE_IA', label: 'One Zone-IA' },
                        { value: 'INTELLIGENT_TIERING', label: 'Intelligent-Tiering' },
                        { value: 'GLACIER', label: 'Glacier' },
                        { value: 'DEEP_ARCHIVE', label: 'Deep Archive' }
                    ]
                }
            ]
        };
    }
}

module.exports = S3Provider;