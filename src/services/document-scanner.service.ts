import sharp from 'sharp';
import { DocumentQualityCheck, DocumentType } from '../types/verification.types';

export class DocumentScannerService {
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

  detectDocumentType(_imageBuffer: Buffer): Promise<DocumentType> {
    return Promise.resolve(DocumentType.DRIVERS_LICENSE);
  }
}
