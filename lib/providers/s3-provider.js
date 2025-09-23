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

        // Generate S3 key based on folder structure settings
        let key;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        // Get the base folder from metadata or config
        const baseFolder = (metadata && metadata.baseFolder) ? metadata.baseFolder : (prefix || '');
        const useIndividualFolders = metadata && metadata.useIndividualFolders !== undefined ? metadata.useIndividualFolders : true;

        // Get the base filename (without extension)
        const nameWithoutExt = path.basename(fileName, path.extname(fileName));

        // Build the key path
        let keyPath = '';

        // Add base folder if specified
        if (baseFolder) {
            keyPath = baseFolder.replace(/\/$/, ''); // Remove trailing slash
        }

        // Add individual video folder if enabled
        if (useIndividualFolders) {
            const folderName = metadata && metadata.preserveFilename ? nameWithoutExt : `${timestamp}_${nameWithoutExt}`;
            keyPath = keyPath ? `${keyPath}/${folderName}` : folderName;
        }

        // Add the actual filename
        const actualFileName = metadata && metadata.preserveFilename ? fileName : `${timestamp}_${fileName}`;
        key = keyPath ? `${keyPath}/${actualFileName}` : actualFileName;

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
                        // Use the same folder structure for the JSON file
                        if (useIndividualFolders) {
                            const jsonFileName = path.basename(jsonPath);
                            metadataKey = keyPath ? `${keyPath}/${jsonFileName}` : jsonFileName;
                        } else {
                            metadataKey = key.replace(/\.[^/.]+$/, '.json');
                        }

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

                // Upload thumbnails if requested
                let thumbnailKeys = [];
                if (metadata && metadata.includeThumbnails) {
                    thumbnailKeys = await this.uploadThumbnails(client, bucket, filePath, keyPath, useIndividualFolders, metadata);
                }

                return {
                    success: true,
                    location,
                    key,
                    bucket,
                    size: stats.size,
                    timestamp,
                    metadataKey,
                    thumbnailKeys
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
                    // Use the same folder structure for the JSON file
                    if (useIndividualFolders) {
                        const jsonFileName = path.basename(jsonPath);
                        metadataKey = keyPath ? `${keyPath}/${jsonFileName}` : jsonFileName;
                    } else {
                        metadataKey = key.replace(/\.[^/.]+$/, '.json');
                    }

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

            // Upload thumbnails if requested
            let thumbnailKeys = [];
            if (metadata && metadata.includeThumbnails) {
                thumbnailKeys = await this.uploadThumbnails(client, bucket, filePath, keyPath, useIndividualFolders, metadata);
            }

            return {
                success: true,
                location,
                key,
                bucket,
                size: stats.size,
                timestamp,
                etag: result.ETag,
                metadataKey,
                thumbnailKeys
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

    /**
     * Upload thumbnails folder to S3
     */
    async uploadThumbnails(client, bucket, videoPath, keyPath, useIndividualFolders, metadata) {
        const thumbnailKeys = [];

        try {
            const videoName = path.basename(videoPath, path.extname(videoPath));
            const videoDir = path.dirname(videoPath);
            const thumbnailFolder = path.join(videoDir, `${videoName}_thumbs`);
            const mainThumbnailPath = path.join(videoDir, `${videoName}_main_thumb.jpg`);

            // Upload main thumbnail if it exists
            if (require('fs').existsSync(mainThumbnailPath)) {
                const mainThumbKey = keyPath ?
                    `${keyPath}/${path.basename(mainThumbnailPath)}` :
                    path.basename(mainThumbnailPath);

                const mainThumbStream = require('fs').createReadStream(mainThumbnailPath);
                const uploadMainThumb = new PutObjectCommand({
                    Bucket: bucket,
                    Key: mainThumbKey,
                    Body: mainThumbStream,
                    ContentType: 'image/jpeg'
                });

                if (metadata && metadata.makePublic) {
                    uploadMainThumb.ACL = 'public-read';
                }

                await client.send(uploadMainThumb);
                thumbnailKeys.push(mainThumbKey);
                console.log('Uploaded main thumbnail:', mainThumbKey);
            }

            // Upload thumbnail folder if it exists
            if (require('fs').existsSync(thumbnailFolder)) {
                const thumbFiles = require('fs').readdirSync(thumbnailFolder)
                    .filter(f => f.endsWith('.jpg'));

                // Create the thumbnails folder key path
                const thumbFolderKey = keyPath ?
                    `${keyPath}/${videoName}_thumbs` :
                    `${videoName}_thumbs`;

                // Upload each thumbnail
                for (const thumbFile of thumbFiles) {
                    const thumbPath = path.join(thumbnailFolder, thumbFile);
                    const thumbKey = `${thumbFolderKey}/${thumbFile}`;

                    const thumbStream = require('fs').createReadStream(thumbPath);
                    const uploadThumb = new PutObjectCommand({
                        Bucket: bucket,
                        Key: thumbKey,
                        Body: thumbStream,
                        ContentType: 'image/jpeg'
                    });

                    if (metadata && metadata.makePublic) {
                        uploadThumb.ACL = 'public-read';
                    }

                    await client.send(uploadThumb);
                    thumbnailKeys.push(thumbKey);
                }

                console.log(`Uploaded ${thumbFiles.length} thumbnails to ${thumbFolderKey}`);
            }

            return thumbnailKeys;
        } catch (error) {
            console.error('Error uploading thumbnails:', error);
            // Don't fail the entire upload if thumbnails fail
            return thumbnailKeys;
        }
    }
}

module.exports = S3Provider;