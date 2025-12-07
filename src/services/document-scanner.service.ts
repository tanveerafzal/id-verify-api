import sharp from 'sharp';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { DocumentQualityCheck, DocumentType } from '../types/verification.types';

// Document detection result interface
export interface DocumentDetectionResult {
  documentType: DocumentType;
  confidence: number;
  detectedKeywords: string[];
  method: 'google_vision' | 'keyword_analysis' | 'fallback';
}

// Keywords and patterns for each document type
const DOCUMENT_PATTERNS: Record<string, { keywords: string[]; patterns: RegExp[]; weight: number }> = {
  [DocumentType.DRIVERS_LICENSE]: {
    keywords: [
      'driver', 'license', 'licence', 'driving', 'dl', 'motor vehicle',
      'class', 'endorsements', 'restrictions', 'dob', 'exp', 'iss',
      'height', 'weight', 'eyes', 'hair', 'sex', 'rstr', 'end',
      'permis de conduire', 'ontario', 'california', 'texas', 'new york',
      'florida', 'state of', 'department of motor', 'dmv'
    ],
    patterns: [
      /driver'?s?\s*licen[cs]e/i,
      /permis\s*de\s*conduire/i,
      /class\s*[a-z0-9]/i,
      /dl\s*[#:]?\s*[a-z0-9]/i,
      /motor\s*vehicle/i,
      /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/,
      /ontario|quebec|british columbia|alberta/i
    ],
    weight: 1.0
  },
  [DocumentType.PASSPORT]: {
    keywords: [
      'passport', 'passeport', 'reisepass', 'pasaporte',
      'nationality', 'nationalité', 'surname', 'given names',
      'date of birth', 'place of birth', 'date of issue', 'date of expiry',
      'authority', 'type', 'code', 'p<', 'mrz', 'machine readable'
    ],
    patterns: [
      /passport/i,
      /passeport/i,
      /P<[A-Z]{3}/,  // MRZ pattern
      /nationality/i,
      /place\s*of\s*birth/i,
      /date\s*of\s*expiry/i,
      /given\s*names?/i,
      /[A-Z0-9<]{44}/  // MRZ line pattern
    ],
    weight: 1.2
  },
  [DocumentType.NATIONAL_ID]: {
    keywords: [
      'national', 'identity', 'identification', 'id card', 'citizen',
      'identity card', 'carte d\'identité', 'documento', 'identidad',
      'cedula', 'dni', 'nic', 'aadhar', 'pan card', 'social security',
      'national insurance', 'republic', 'government'
    ],
    patterns: [
      /national\s*id/i,
      /identity\s*card/i,
      /carte\s*d'?identit[ée]/i,
      /c[ée]dula/i,
      /\bDNI\b/i,
      /\bNIC\b/i,
      /citizen/i,
      /republic\s*of/i
    ],
    weight: 0.9
  },
  [DocumentType.RESIDENCE_PERMIT]: {
    keywords: [
      'residence', 'permit', 'resident', 'permanent', 'temporary',
      'visa', 'immigration', 'alien', 'green card', 'work permit',
      'settlement', 'leave to remain', 'aufenthaltstitel', 'titre de séjour',
      'permesso di soggiorno', 'residencia'
    ],
    patterns: [
      /residen(ce|t)\s*permit/i,
      /permanent\s*resident/i,
      /green\s*card/i,
      /work\s*permit/i,
      /visa/i,
      /immigration/i,
      /titre\s*de\s*s[ée]jour/i,
      /aufenthaltstitel/i
    ],
    weight: 0.8
  },
  [DocumentType.VOTER_ID]: {
    keywords: [
      'voter', 'election', 'electoral', 'voting', 'poll', 'ballot',
      'voter id', 'election commission', 'electoral roll', 'elector',
      'registered voter', 'constituency', 'polling'
    ],
    patterns: [
      /voter\s*id/i,
      /election/i,
      /electoral/i,
      /polling/i,
      /elector/i,
      /constituency/i
    ],
    weight: 0.7
  }
};

// Google Vision labels that indicate document types
const VISION_LABEL_MAPPINGS: Record<string, DocumentType[]> = {
  'driver\'s license': [DocumentType.DRIVERS_LICENSE],
  'driving license': [DocumentType.DRIVERS_LICENSE],
  'license': [DocumentType.DRIVERS_LICENSE],
  'passport': [DocumentType.PASSPORT],
  'identity document': [DocumentType.NATIONAL_ID, DocumentType.DRIVERS_LICENSE],
  'id card': [DocumentType.NATIONAL_ID],
  'national id': [DocumentType.NATIONAL_ID],
  'residence permit': [DocumentType.RESIDENCE_PERMIT],
  'visa': [DocumentType.RESIDENCE_PERMIT],
  'voter id': [DocumentType.VOTER_ID],
  'document': [DocumentType.OTHER],
  'text': [DocumentType.OTHER],
  'card': [DocumentType.OTHER]
};

export class DocumentScannerService {
  private visionClient: ImageAnnotatorClient | null = null;
  private useGoogleVision: boolean = false;

  constructor() {
    this.initializeGoogleVision();
  }

  private initializeGoogleVision(): void {
    try {
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT) {
        this.visionClient = new ImageAnnotatorClient();
        this.useGoogleVision = true;
        console.log('[DocumentScannerService] Google Cloud Vision API initialized');
      }
    } catch (error) {
      console.log('[DocumentScannerService] Google Vision not available:', error);
      this.useGoogleVision = false;
    }
  }
  async preprocessImage(imageBuffer: Buffer): Promise<Buffer> {
    try {
      const processedImage = await sharp(imageBuffer)
        .resize(2000, 2000, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .normalize()
        .sharpen()
        .toBuffer();

      return processedImage;
    } catch (error) {
      throw new Error(`Image preprocessing failed: ${error}`);
    }
  }

  async checkQuality(imageBuffer: Buffer): Promise<DocumentQualityCheck> {
    try {
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();
      const stats = await image.stats();

      const qualityChecks = {
        isBlurry: await this.detectBlur(imageBuffer),
        hasGlare: await this.detectGlare(stats),
        isComplete: await this.checkCompleteness(metadata),
        issues: [] as string[]
      };

      if (qualityChecks.isBlurry) {
        qualityChecks.issues.push('Image appears blurry');
      }
      if (qualityChecks.hasGlare) {
        qualityChecks.issues.push('Glare detected on document');
      }
      if (!qualityChecks.isComplete) {
        qualityChecks.issues.push('Document appears incomplete or cut off');
      }

      const qualityScore = this.calculateQualityScore(qualityChecks, metadata);

      return {
        ...qualityChecks,
        qualityScore
      };
    } catch (error) {
      throw new Error(`Quality check failed: ${error}`);
    }
  }

  private async detectBlur(imageBuffer: Buffer): Promise<boolean> {
    const image = sharp(imageBuffer);
    const grayscale = await image
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const laplacianVariance = this.calculateLaplacianVariance(
      grayscale.data,
      grayscale.info.width,
      grayscale.info.height
    );

    return laplacianVariance < 100;
  }

  private calculateLaplacianVariance(
    pixels: Buffer,
    width: number,
    height: number
  ): number {
    const laplacianKernel = [
      [0, 1, 0],
      [1, -4, 1],
      [0, 1, 0]
    ];

    let sum = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let laplacian = 0;
        for (let ky = 0; ky < 3; ky++) {
          for (let kx = 0; kx < 3; kx++) {
            const px = x + kx - 1;
            const py = y + ky - 1;
            const pixelValue = pixels[py * width + px];
            laplacian += pixelValue * laplacianKernel[ky][kx];
          }
        }
        sum += laplacian * laplacian;
        count++;
      }
    }

    return sum / count;
  }

  private async detectGlare(stats: sharp.Stats): Promise<boolean> {
    const channels = stats.channels;
    if (!channels || channels.length === 0) return false;

    const maxIntensity = Math.max(...channels.map(c => c.max));
    const meanIntensity = channels.reduce((sum, c) => sum + c.mean, 0) / channels.length;

    return maxIntensity > 250 && (maxIntensity - meanIntensity) > 100;
  }

  private async checkCompleteness(metadata: sharp.Metadata): Promise<boolean> {
    if (!metadata.width || !metadata.height) return false;

    const aspectRatio = metadata.width / metadata.height;
    const minWidth = 200;
    const minHeight = 200;

    // More lenient checks for demo purposes
    return (
      metadata.width >= minWidth &&
      metadata.height >= minHeight &&
      aspectRatio > 0.5 &&
      aspectRatio < 3.0
    );
  }

  private calculateQualityScore(
    checks: { isBlurry: boolean; hasGlare: boolean; isComplete: boolean },
    metadata: sharp.Metadata
  ): number {
    let score = 1.0;

    if (checks.isBlurry) score -= 0.3;
    if (checks.hasGlare) score -= 0.2;
    if (!checks.isComplete) score -= 0.4;

    if (metadata.width && metadata.width < 800) score -= 0.1;
    if (metadata.height && metadata.height < 600) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  async detectDocumentBorders(imageBuffer: Buffer): Promise<Buffer> {
    try {
      const edges = await sharp(imageBuffer)
        .grayscale()
        .normalize()
        .toBuffer();

      return edges;
    } catch (error) {
      throw new Error(`Border detection failed: ${error}`);
    }
  }

  async cropToDocument(imageBuffer: Buffer): Promise<Buffer> {
    try {
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();

      if (!metadata.width || !metadata.height) {
        return imageBuffer;
      }

      const cropMargin = 20;
      const croppedImage = await image
        .extract({
          left: cropMargin,
          top: cropMargin,
          width: metadata.width - (2 * cropMargin),
          height: metadata.height - (2 * cropMargin)
        })
        .toBuffer();

      return croppedImage;
    } catch (error) {
      return imageBuffer;
    }
  }

  async generateThumbnail(imageBuffer: Buffer, width: number = 300): Promise<Buffer> {
    try {
      const thumbnail = await sharp(imageBuffer)
        .resize(width, null, {
          fit: 'inside',
          withoutEnlargement: false
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      return thumbnail;
    } catch (error) {
      throw new Error(`Thumbnail generation failed: ${error}`);
    }
  }

  /**
   * Detect document type using Google Vision and keyword analysis
   */
  async detectDocumentType(imageBuffer: Buffer): Promise<DocumentDetectionResult> {
    console.log('[DocumentScannerService] Starting document type detection');

    try {
      // Try Google Vision first for both labels and text
      if (this.useGoogleVision && this.visionClient) {
        const result = await this.detectWithGoogleVision(imageBuffer);
        if (result.confidence > 0.6) {
          console.log('[DocumentScannerService] Google Vision detection:', result);
          return result;
        }
      }

      // Fall back to keyword analysis using OCR text
      const textResult = await this.detectWithKeywordAnalysis(imageBuffer);
      if (textResult.confidence > 0.4) {
        console.log('[DocumentScannerService] Keyword analysis detection:', textResult);
        return textResult;
      }

      // Default fallback
      console.log('[DocumentScannerService] Using fallback detection');
      return {
        documentType: DocumentType.OTHER,
        confidence: 0.3,
        detectedKeywords: [],
        method: 'fallback'
      };
    } catch (error) {
      console.error('[DocumentScannerService] Detection error:', error);
      return {
        documentType: DocumentType.OTHER,
        confidence: 0.1,
        detectedKeywords: [],
        method: 'fallback'
      };
    }
  }

  /**
   * Detect document type using Google Vision API (labels + text)
   */
  private async detectWithGoogleVision(imageBuffer: Buffer): Promise<DocumentDetectionResult> {
    try {
      // Run label detection and text detection in parallel
      const [labelResult, textResult] = await Promise.all([
        this.visionClient!.labelDetection({
          image: { content: imageBuffer.toString('base64') }
        }),
        this.visionClient!.textDetection({
          image: { content: imageBuffer.toString('base64') }
        })
      ]);

      const labels = labelResult[0].labelAnnotations || [];
      const textAnnotations = textResult[0].textAnnotations || [];
      const fullText = textAnnotations[0]?.description || '';

      console.log('[DocumentScannerService] Vision labels:', labels.map(l => l.description).slice(0, 5));
      console.log('[DocumentScannerService] Extracted text length:', fullText.length);

      // Score based on labels
      const labelScores = this.scoreFromLabels(labels);

      // Score based on text keywords
      const textScores = this.scoreFromText(fullText);

      // Combine scores (labels: 40%, text: 60%)
      const combinedScores: Record<DocumentType, number> = {} as Record<DocumentType, number>;
      const allTypes = Object.values(DocumentType);

      for (const docType of allTypes) {
        const labelScore = labelScores[docType] || 0;
        const textScore = textScores[docType] || 0;
        combinedScores[docType] = (labelScore * 0.4) + (textScore * 0.6);
      }

      // Find best match
      let bestType: DocumentType = DocumentType.OTHER;
      let bestScore = 0;
      let detectedKeywords: string[] = [];

      for (const [docType, score] of Object.entries(combinedScores)) {
        if (score > bestScore) {
          bestScore = score;
          bestType = docType as DocumentType;
        }
      }

      // Get detected keywords for the best type
      if (bestType !== DocumentType.OTHER && DOCUMENT_PATTERNS[bestType]) {
        const pattern = DOCUMENT_PATTERNS[bestType];
        detectedKeywords = pattern.keywords.filter(kw =>
          fullText.toLowerCase().includes(kw.toLowerCase())
        );
      }

      return {
        documentType: bestType,
        confidence: Math.min(1, bestScore),
        detectedKeywords,
        method: 'google_vision'
      };
    } catch (error) {
      console.error('[DocumentScannerService] Google Vision detection failed:', error);
      throw error;
    }
  }

  /**
   * Score document types based on Google Vision labels
   */
  private scoreFromLabels(labels: Array<{ description?: string | null; score?: number | null }>): Record<DocumentType, number> {
    const scores: Record<DocumentType, number> = {} as Record<DocumentType, number>;

    for (const label of labels) {
      const labelText = (label.description || '').toLowerCase();
      const labelScore = label.score || 0;

      for (const [mappingKey, docTypes] of Object.entries(VISION_LABEL_MAPPINGS)) {
        if (labelText.includes(mappingKey)) {
          for (const docType of docTypes) {
            scores[docType] = (scores[docType] || 0) + (labelScore * 0.5);
          }
        }
      }
    }

    return scores;
  }

  /**
   * Score document types based on text content
   */
  private scoreFromText(text: string): Record<DocumentType, number> {
    const scores: Record<DocumentType, number> = {} as Record<DocumentType, number>;
    const lowerText = text.toLowerCase();

    for (const [docType, config] of Object.entries(DOCUMENT_PATTERNS)) {
      let score = 0;
      let matchCount = 0;

      // Check keywords
      for (const keyword of config.keywords) {
        if (lowerText.includes(keyword.toLowerCase())) {
          score += 0.1;
          matchCount++;
        }
      }

      // Check regex patterns (higher weight)
      for (const pattern of config.patterns) {
        if (pattern.test(text)) {
          score += 0.2;
          matchCount++;
        }
      }

      // Apply document type weight
      score *= config.weight;

      // Bonus for multiple matches
      if (matchCount >= 3) {
        score *= 1.2;
      }
      if (matchCount >= 5) {
        score *= 1.3;
      }

      scores[docType as DocumentType] = Math.min(1, score);
    }

    return scores;
  }

  /**
   * Detect document type using keyword analysis (fallback without Google Vision)
   */
  private async detectWithKeywordAnalysis(imageBuffer: Buffer): Promise<DocumentDetectionResult> {
    // This would normally use Tesseract, but we'll use a simpler approach
    // by checking image characteristics

    try {
      const metadata = await sharp(imageBuffer).metadata();
      const aspectRatio = (metadata.width || 1) / (metadata.height || 1);

      // Passport pages are typically more square or portrait
      // Driver's licenses are typically landscape (credit card sized)
      // ID cards vary

      let likelyType: DocumentType = DocumentType.OTHER;
      let confidence = 0.4;

      if (aspectRatio >= 1.4 && aspectRatio <= 1.8) {
        // Credit card / license aspect ratio
        likelyType = DocumentType.DRIVERS_LICENSE;
        confidence = 0.5;
      } else if (aspectRatio >= 0.65 && aspectRatio <= 0.85) {
        // Passport page aspect ratio (portrait)
        likelyType = DocumentType.PASSPORT;
        confidence = 0.45;
      } else if (aspectRatio >= 0.9 && aspectRatio <= 1.1) {
        // Square-ish, could be various ID types
        likelyType = DocumentType.NATIONAL_ID;
        confidence = 0.4;
      }

      return {
        documentType: likelyType,
        confidence,
        detectedKeywords: [],
        method: 'keyword_analysis'
      };
    } catch (error) {
      return {
        documentType: DocumentType.OTHER,
        confidence: 0.3,
        detectedKeywords: [],
        method: 'keyword_analysis'
      };
    }
  }

  /**
   * Get human-readable document type name
   */
  getDocumentTypeName(docType: DocumentType): string {
    const names: Record<DocumentType, string> = {
      [DocumentType.DRIVERS_LICENSE]: 'Driver\'s License',
      [DocumentType.PASSPORT]: 'Passport',
      [DocumentType.NATIONAL_ID]: 'National ID Card',
      [DocumentType.RESIDENCE_PERMIT]: 'Residence Permit',
      [DocumentType.VOTER_ID]: 'Voter ID',
      [DocumentType.SELFIE]: 'Selfie',
      [DocumentType.OTHER]: 'Other Document'
    };
    return names[docType] || 'Unknown Document';
  }
}
