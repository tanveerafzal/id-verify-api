import Tesseract from 'tesseract.js';
import { DocumentType, ExtractedDocumentData } from '../types/verification.types';

export class OCRService {
  private worker: Tesseract.Worker | null = null;

  async initialize(): Promise<void> {
    this.worker = await Tesseract.createWorker('eng');
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }

  async extractText(imageBuffer: Buffer): Promise<{ text: string; confidence: number }> {
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

    switch (documentType) {
      case DocumentType.DRIVERS_LICENSE:
        return this.parseDriversLicense(text, confidence);
      case DocumentType.PASSPORT:
        return this.parsePassport(text, confidence);
      case DocumentType.NATIONAL_ID:
        return this.parseNationalId(text, confidence);
      default:
        return this.parseGenericDocument(text, confidence);
    }
  }

  private parseDriversLicense(text: string, confidence: number): ExtractedDocumentData {
    const data: ExtractedDocumentData = { confidence };

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

    const dobMatch = text.match(/(?:DOB|Date of Birth|Birth Date)[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (dobMatch) {
      data.dateOfBirth = this.normalizeDate(dobMatch[1]);
    }

    const licenseMatch = text.match(/(?:DL|License|LIC)[#:\s]+([A-Z0-9]{5,15})/i);
    if (licenseMatch) {
      data.documentNumber = licenseMatch[1].trim();
    }

    const expiryMatch = text.match(/(?:EXP|Expires|Expiration)[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (expiryMatch) {
      data.expiryDate = this.normalizeDate(expiryMatch[1]);
    }

    const addressMatch = text.match(/(?:Address|ADDR)[:\s]+([^\n]+)/i);
    if (addressMatch) {
      data.address = this.parseAddress(addressMatch[1]);
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
