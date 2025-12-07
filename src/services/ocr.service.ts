import Tesseract from 'tesseract.js';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { DocumentType, ExtractedDocumentData } from '../types/verification.types';

export class OCRService {
  private worker: Tesseract.Worker | null = null;
  private visionClient: ImageAnnotatorClient | null = null;
  private useGoogleVision: boolean = false;

  constructor() {
    this.initializeGoogleVision();
  }

  private initializeGoogleVision(): void {
    try {
      // Check if Google Cloud credentials are configured
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT) {
        this.visionClient = new ImageAnnotatorClient();
        this.useGoogleVision = true;
        console.log('[OCRService] Google Cloud Vision API initialized');
      } else {
        console.log('[OCRService] Google Cloud Vision credentials not found, using Tesseract.js');
      }
    } catch (error) {
      console.log('[OCRService] Failed to initialize Google Vision, falling back to Tesseract:', error);
      this.useGoogleVision = false;
    }
  }

  async initialize(): Promise<void> {
    if (!this.useGoogleVision) {
      this.worker = await Tesseract.createWorker('eng');
    }
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }

  async extractText(imageBuffer: Buffer): Promise<{ text: string; confidence: number }> {
    if (this.useGoogleVision && this.visionClient) {
      return this.extractTextWithGoogleVision(imageBuffer);
    }
    return this.extractTextWithTesseract(imageBuffer);
  }

  private async extractTextWithGoogleVision(imageBuffer: Buffer): Promise<{ text: string; confidence: number }> {
    try {
      const [result] = await this.visionClient!.textDetection({
        image: { content: imageBuffer.toString('base64') }
      });

      const detections = result.textAnnotations;

      if (!detections || detections.length === 0) {
        console.log('[OCRService] Google Vision: No text detected, falling back to Tesseract');
        return this.extractTextWithTesseract(imageBuffer);
      }

      // First annotation contains the entire extracted text
      const fullText = detections[0].description || '';

      // Google Vision doesn't provide a direct confidence score for the whole text
      // We calculate an average from individual word confidences if available
      let confidence = 0.95; // Default high confidence for Google Vision

      if (result.fullTextAnnotation?.pages) {
        const confidences: number[] = [];
        for (const page of result.fullTextAnnotation.pages) {
          for (const block of page.blocks || []) {
            if (block.confidence) {
              confidences.push(block.confidence);
            }
          }
        }
        if (confidences.length > 0) {
          confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
        }
      }

      console.log('[OCRService] Google Vision extracted text length:', fullText.length);
      console.log('[OCRService] Google Vision confidence:', confidence);

      return { text: fullText, confidence };
    } catch (error) {
      console.error('[OCRService] Google Vision extraction failed, falling back to Tesseract:', error);
      return this.extractTextWithTesseract(imageBuffer);
    }
  }

  private async extractTextWithTesseract(imageBuffer: Buffer): Promise<{ text: string; confidence: number }> {
    try {
      if (!this.worker) {
        await this.initialize();
      }

      const result = await this.worker!.recognize(imageBuffer);

      return {
        text: result.data.text,
        confidence: result.data.confidence / 100
      };
    } catch (error) {
      throw new Error(`OCR extraction failed: ${error}`);
    }
  }

  async extractDocumentData(
    imageBuffer: Buffer,
    documentType: DocumentType
  ): Promise<ExtractedDocumentData> {
    const { text, confidence } = await this.extractText(imageBuffer);

    console.log('[OCRService] Extracted text:', text.substring(0, 200));
    console.log('[OCRService] Confidence:', confidence);
    console.log('[OCRService] Document type:', documentType);

    let extractedData: ExtractedDocumentData;

    switch (documentType) {
      case DocumentType.DRIVERS_LICENSE:
        extractedData = this.parseDriversLicense(text, confidence);
        break;
      case DocumentType.PASSPORT:
        extractedData = this.parsePassport(text, confidence);
        break;
      case DocumentType.NATIONAL_ID:
        extractedData = this.parseNationalId(text, confidence);
        break;
      default:
        extractedData = this.parseGenericDocument(text, confidence);
    }

    console.log('[OCRService] Parsed extracted data:', extractedData);

    return extractedData;
  }

  private parseDriversLicense(text: string, confidence: number): ExtractedDocumentData {
    const data: ExtractedDocumentData = { confidence };

    // Try Canadian/Ontario format first: "1.2 NAME/NOM" followed by LASTNAME then FIRSTNAME on separate lines
    const canadianNameMatch = text.match(/(?:NAME\/NOM|NOM\/NAME)\s*\n?\s*([A-Z]+)\s*\n?\s*([A-Z]+)/i);
    if (canadianNameMatch) {
      data.lastName = canadianNameMatch[1].trim();
      data.firstName = canadianNameMatch[2].trim();
      data.fullName = `${data.firstName} ${data.lastName}`;
    } else {
      // Try US format: "Name: John Doe" or similar
      const nameMatch = text.match(/(?:Name|NAME)[:\s]+([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/i);
      if (nameMatch) {
        const fullName = nameMatch[1].trim();
        data.fullName = fullName;
        const nameParts = fullName.split(' ');
        if (nameParts.length >= 2) {
          data.firstName = nameParts[0];
          data.lastName = nameParts.slice(1).join(' ');
        }
      }
    }

    // Also try to find name from "John Doe" pattern after "SAMPLE" (common in sample licenses)
    if (!data.fullName) {
      const sampleNameMatch = text.match(/SAMPLE\s*\n?\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i);
      if (sampleNameMatch) {
        const fullName = sampleNameMatch[1].trim();
        data.fullName = fullName;
        const nameParts = fullName.split(' ');
        if (nameParts.length >= 2) {
          data.firstName = nameParts[0];
          data.lastName = nameParts[nameParts.length - 1];
        }
      }
    }

    // Canadian license number format: "4d NUMBER/NUMERO" followed by the number like "DO123-45678-90123"
    const canadianLicenseMatch = text.match(/(?:NUMBER\/NUMERO|NUMERO\/NUMBER)\s*\n?\s*([A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+|[A-Z0-9]{10,20})/i);
    if (canadianLicenseMatch) {
      data.documentNumber = canadianLicenseMatch[1].trim();
    } else {
      // Also try pattern like "4d DO123-45678-90123"
      const altLicenseMatch = text.match(/4d\s+([A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+)/i);
      if (altLicenseMatch) {
        data.documentNumber = altLicenseMatch[1].trim();
      } else {
        // US format
        const licenseMatch = text.match(/(?:DL|License|LIC)[#:\s]+([A-Z0-9]{5,15})/i);
        if (licenseMatch) {
          data.documentNumber = licenseMatch[1].trim();
        }
      }
    }

    // DOB patterns - try multiple formats
    const dobMatch = text.match(/(?:DOB|Date of Birth|Birth Date|4b)[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (dobMatch) {
      data.dateOfBirth = this.normalizeDate(dobMatch[1]);
    }

    // Expiry patterns - Canadian uses "4a" or "ISS/DEL" for issue, need to find expiry
    const expiryMatch = text.match(/(?:EXP|Expires|Expiration|4c)[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (expiryMatch) {
      data.expiryDate = this.normalizeDate(expiryMatch[1]);
    }

    // Address - Canadian format shows street directly, look for street pattern
    const canadianAddressMatch = text.match(/(\d+\s+[A-Z]+\s+(?:STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|BLVD|WAY|LANE|LN)[^\n]*)\n?([A-Z]+),?\s*([A-Z]{2}),?\s*([A-Z0-9\s]+)/i);
    if (canadianAddressMatch) {
      data.address = {
        street: canadianAddressMatch[1].trim(),
        city: canadianAddressMatch[2].trim(),
        state: canadianAddressMatch[3].trim(),
        postalCode: canadianAddressMatch[4].trim().replace(/\s+/g, ' '),
        country: 'CAN'
      };
    } else {
      const addressMatch = text.match(/(?:Address|ADDR)[:\s]+([^\n]+)/i);
      if (addressMatch) {
        data.address = this.parseAddress(addressMatch[1]);
      }
    }

    const genderMatch = text.match(/(?:Sex|Gender)[:\s]+(M|F|Male|Female)/i);
    if (genderMatch) {
      data.gender = genderMatch[1].charAt(0).toUpperCase();
    }

    return data;
  }

  private parsePassport(text: string, confidence: number): ExtractedDocumentData {
    const data: ExtractedDocumentData = { confidence };

    const mrzMatch = text.match(/P<[A-Z]{3}([A-Z<]+)<<([A-Z<]+)<+\n([A-Z0-9<]+)/);
    if (mrzMatch) {
      data.mrz = mrzMatch[0];
      data.lastName = mrzMatch[1].replace(/</g, ' ').trim();
      data.firstName = mrzMatch[2].replace(/</g, ' ').trim();
      data.fullName = `${data.firstName} ${data.lastName}`;

      const mrzLine2 = mrzMatch[3];
      data.documentNumber = mrzLine2.substring(0, 9).replace(/</g, '');
      data.nationality = mrzLine2.substring(10, 13);

      const dobStr = mrzLine2.substring(13, 19);
      data.dateOfBirth = this.parseMRZDate(dobStr);

      const expiryStr = mrzLine2.substring(21, 27);
      data.expiryDate = this.parseMRZDate(expiryStr);

      data.gender = mrzLine2.charAt(20);
    } else {
      const nameMatch = text.match(/(?:Surname|Given Names)[:\s]+([A-Z\s]+)/gi);
      if (nameMatch && nameMatch.length >= 2) {
        data.lastName = nameMatch[0].split(/[:\s]+/)[1]?.trim();
        data.firstName = nameMatch[1].split(/[:\s]+/)[1]?.trim();
        data.fullName = `${data.firstName} ${data.lastName}`;
      }

      const passportNoMatch = text.match(/(?:Passport No|Document No)[:\s]+([A-Z0-9]+)/i);
      if (passportNoMatch) {
        data.documentNumber = passportNoMatch[1].trim();
      }
    }

    return data;
  }

  private parseNationalId(text: string, confidence: number): ExtractedDocumentData {
    const data: ExtractedDocumentData = { confidence };

    const nameMatch = text.match(/(?:Name|NOMBRE)[:\s]+([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/i);
    if (nameMatch) {
      data.fullName = nameMatch[1].trim();
    }

    const idMatch = text.match(/(?:ID|No|Number)[:\s]+([A-Z0-9]{5,20})/i);
    if (idMatch) {
      data.documentNumber = idMatch[1].trim();
    }

    const dobMatch = text.match(/(?:DOB|Born|Fecha de Nacimiento)[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (dobMatch) {
      data.dateOfBirth = this.normalizeDate(dobMatch[1]);
    }

    return data;
  }

  private parseGenericDocument(text: string, confidence: number): ExtractedDocumentData {
    const data: ExtractedDocumentData = { confidence };

    const nameMatch = text.match(/([A-Z][a-z]+\s[A-Z][a-z]+)/);
    if (nameMatch) {
      data.fullName = nameMatch[1];
    }

    const dateMatches = text.match(/\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/g);
    if (dateMatches && dateMatches.length > 0) {
      data.dateOfBirth = this.normalizeDate(dateMatches[0]);
    }

    return data;
  }

  private parseAddress(addressText: string): ExtractedDocumentData['address'] {
    const parts = addressText.split(/[,\n]+/).map(p => p.trim());

    const postalCodeMatch = addressText.match(/\b\d{5}(?:-\d{4})?\b/);
    const stateMatch = addressText.match(/\b([A-Z]{2})\b/);

    return {
      street: parts[0] || undefined,
      city: parts[1] || undefined,
      state: stateMatch ? stateMatch[1] : undefined,
      postalCode: postalCodeMatch ? postalCodeMatch[0] : undefined,
      country: 'USA'
    };
  }

  private normalizeDate(dateStr: string): string {
    const cleaned = dateStr.replace(/[-\/]/g, '-');
    const parts = cleaned.split('-');

    if (parts.length !== 3) return dateStr;

    let [month, day, year] = parts;

    if (year.length === 2) {
      const currentYear = new Date().getFullYear();
      const century = Math.floor(currentYear / 100) * 100;
      const yearNum = parseInt(year, 10);
      year = yearNum > (currentYear % 100) ? `${century - 100 + yearNum}` : `${century + yearNum}`;
    }

    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  private parseMRZDate(mrzDate: string): string {
    const year = mrzDate.substring(0, 2);
    const month = mrzDate.substring(2, 4);
    const day = mrzDate.substring(4, 6);

    const currentYear = new Date().getFullYear();
    const century = parseInt(year, 10) > (currentYear % 100) ? '19' : '20';

    return `${century}${year}-${month}-${day}`;
  }

  async validateMRZ(mrz: string): Promise<boolean> {
    const lines = mrz.split('\n');
    if (lines.length < 2) return false;

    for (const line of lines) {
      if (!/^[A-Z0-9<]+$/.test(line)) {
        return false;
      }
    }

    return true;
  }
}
