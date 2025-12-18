import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../utils/logger';

interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface UploadResult {
  key: string;
  url: string;
  bucket: string;
}

export class S3Service {
  private client: S3Client | null = null;
  private bucket: string = '';
  private region: string = '';
  private isConfigured: boolean = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const config: S3Config = {
      region: process.env.AWS_REGION || 'us-east-1',
      bucket: process.env.AWS_S3_BUCKET || '',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    };

    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      logger.warn('[S3Service] AWS S3 credentials not configured. Documents will be saved locally.');
      this.isConfigured = false;
      return;
    }

    try {
      this.client = new S3Client({
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey
        }
      });

      this.bucket = config.bucket;
      this.region = config.region;
      this.isConfigured = true;

      logger.info(`[S3Service] AWS S3 initialized - Bucket: ${this.bucket}, Region: ${this.region}`);
    } catch (error) {
      logger.error('[S3Service] Failed to initialize AWS S3:', error);
      this.isConfigured = false;
    }
  }

  isEnabled(): boolean {
    return this.isConfigured;
  }

  /**
   * Upload a file to S3
   */
  async uploadFile(
    buffer: Buffer,
    key: string,
    contentType: string = 'image/jpeg'
  ): Promise<UploadResult> {
    if (!this.isConfigured || !this.client) {
      throw new Error('S3 is not configured');
    }

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        // Set metadata for document tracking
        Metadata: {
          'uploaded-at': new Date().toISOString()
        }
      });

      await this.client.send(command);

      // Generate the public URL with properly encoded key
      // Encode each path segment separately to preserve slashes
      const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/');
      const url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`;

      logger.info(`[S3Service] File uploaded successfully: ${key}`);

      return {
        key,
        url,
        bucket: this.bucket
      };
    } catch (error) {
      logger.error(`[S3Service] Failed to upload file: ${key}`, error);
      throw error;
    }
  }

  /**
   * Upload a verification document to S3
   */
  async uploadDocument(
    verificationId: string,
    buffer: Buffer,
    filename: string,
    documentType: string,
    contentType: string = 'image/jpeg'
  ): Promise<UploadResult> {
    const timestamp = Date.now();
    const key = `verifications/${verificationId}/documents/${documentType}-${timestamp}-${filename}`;

    return this.uploadFile(buffer, key, contentType);
  }

  /**
   * Upload a selfie to S3
   */
  async uploadSelfie(
    verificationId: string,
    buffer: Buffer,
    filename: string,
    contentType: string = 'image/jpeg'
  ): Promise<UploadResult> {
    const timestamp = Date.now();
    const key = `verifications/${verificationId}/selfies/selfie-${timestamp}-${filename}`;

    return this.uploadFile(buffer, key, contentType);
  }

  /**
   * Get a pre-signed URL for temporary access to a private file
   * Default expiration increased to 8 hours to prevent URLs expiring during dashboard sessions
   */
  async getSignedUrl(key: string, expiresIn: number = 28800): Promise<string> {
    if (!this.isConfigured || !this.client) {
      throw new Error('S3 is not configured');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      });

      const signedUrl = await getSignedUrl(this.client, command, { expiresIn });

      return signedUrl;
    } catch (error) {
      logger.error(`[S3Service] Failed to generate signed URL: ${key}`, error);
      throw error;
    }
  }

  /**
   * Delete a file from S3
   */
  async deleteFile(key: string): Promise<void> {
    if (!this.isConfigured || !this.client) {
      throw new Error('S3 is not configured');
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      });

      await this.client.send(command);

      logger.info(`[S3Service] File deleted successfully: ${key}`);
    } catch (error) {
      logger.error(`[S3Service] Failed to delete file: ${key}`, error);
      throw error;
    }
  }

  /**
   * Upload a partner logo to S3
   */
  async uploadPartnerLogo(
    partnerId: string,
    buffer: Buffer,
    filename: string,
    contentType: string = 'image/png'
  ): Promise<UploadResult> {
    const timestamp = Date.now();
    const extension = filename.split('.').pop() || 'png';
    const key = `partners/${partnerId}/logo-${timestamp}.${extension}`;

    return this.uploadFile(buffer, key, contentType);
  }

  /**
   * Delete all files for a verification
   */
  async deleteVerificationFiles(verificationId: string): Promise<void> {
    // Note: This is a simplified version. For production, you'd want to
    // list all objects with the prefix and delete them in batches
    logger.info(`[S3Service] Delete verification files requested for: ${verificationId}`);
  }

  /**
   * Get the S3 key from a full URL
   * Handles both encoded and unencoded URLs for backward compatibility
   */
  extractKeyFromUrl(url: string): string | null {
    try {
      // First, try to encode any unencoded special characters in the URL
      // This handles URLs that were stored without proper encoding
      const safeUrl = url.replace(/'/g, '%27').replace(/ /g, '%20');
      const urlObj = new URL(safeUrl);
      // Remove leading slash and decode the path to get the actual S3 key
      const path = urlObj.pathname.substring(1);
      // Decode URI components to get the actual key as stored in S3
      return decodeURIComponent(path);
    } catch (error) {
      logger.error(`[S3Service] Failed to extract key from URL: ${url}`, error);
      return null;
    }
  }
}

// Export singleton instance
export const s3Service = new S3Service();
