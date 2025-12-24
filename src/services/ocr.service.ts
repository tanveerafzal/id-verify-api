import Tesseract from 'tesseract.js';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import axios from 'axios';
import { DocumentType, ExtractedDocumentData } from '../types/verification.types';
import { DocumentAiEntity } from './document-scanner.service';
import { config } from '../config';

// Response type from external document OCR API
interface ExternalOcrResponse {
  success: boolean;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  document_number: string | null;
  date_of_birth: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  gender: string | null;
  address: string | null;
  missing_fields: string[] | null;
  processing_time_seconds: number;
  error: string | null;
}

// Entity name mappings for different processor types
// Custom extractors may use different field names than built-in processors
const ENTITY_MAPPINGS: Record<string, keyof ExtractedDocumentData | 'skip'> = {
  // Standard Document AI field names (US processors)
  'family_name': 'lastName',
  'familyname': 'lastName',
  'family name': 'lastName',
  'given_names': 'firstName',
  'givennames': 'firstName',
  'given names': 'firstName',
  'given_name': 'firstName',
  'document_id': 'documentNumber',
  'documentid': 'documentNumber',
  'document id': 'documentNumber',
  'document_number': 'documentNumber',
  'documentnumber': 'documentNumber',
  'document number': 'documentNumber',
  'date_of_birth': 'dateOfBirth',
  'dateofbirth': 'dateOfBirth',
  'date of birth': 'dateOfBirth',
  'expiration_date': 'expiryDate',
  'expirationdate': 'expiryDate',
  'expiration date': 'expiryDate',
  'expiry_date': 'expiryDate',
  'issue_date': 'issueDate',
  'issuedate': 'issueDate',
  'issue date': 'issueDate',
  'address': 'address',
  'mrz_code': 'mrz',
  'mrzcode': 'mrz',
  'mrz code': 'mrz',
  'sex': 'gender',
  'gender': 'gender',
  'nationality': 'nationality',

  // Canadian custom extractor field names (suggested schema)
  'last_name': 'lastName',
  'lastname': 'lastName',
  'surname': 'lastName',
  'first_name': 'firstName',
  'firstname': 'firstName',
  'middle_name': 'skip', // We don't have a middle name field
  'license_number': 'documentNumber',
  'licensenumber': 'documentNumber',
  'licence_number': 'documentNumber', // Canadian spelling
  'licencenumber': 'documentNumber',
  'passport_number': 'documentNumber',
  'passportnumber': 'documentNumber',
  'dob': 'dateOfBirth',
  'birth_date': 'dateOfBirth',
  'birthdate': 'dateOfBirth',
  'exp_date': 'expiryDate',
  'expiry': 'expiryDate',
  'iss_date': 'issueDate',
  'issue': 'issueDate',
  'street_address': 'address',
  'full_address': 'address',
  'province': 'skip', // Handled separately in address parsing
  'city': 'skip',
  'postal_code': 'skip',
  'class': 'skip', // License class
  'restrictions': 'skip',
  'endorsements': 'skip',
  'height': 'skip',
  'weight': 'skip',
  'eye_color': 'skip',
  'hair_color': 'skip',
  'photo': 'skip',
  'portrait': 'skip',
  'signature': 'skip',

  // Permanent Resident Card specific fields
  'card_expires': 'expiryDate',
  'cardexpires': 'expiryDate',
  'card expires': 'expiryDate',
  'card_expiration': 'expiryDate',
  'resident_since': 'issueDate',
  'residentsince': 'issueDate',
  'resident since': 'issueDate',
  'uscis_number': 'documentNumber',
  'uscisnumber': 'documentNumber',
  'uscis number': 'documentNumber',
  'alien_number': 'documentNumber',
  'aliennumber': 'documentNumber',
  'alien number': 'documentNumber',
  'a_number': 'documentNumber',
  'id_number': 'documentNumber',
  'id_no': 'documentNumber',
  'anumber': 'documentNumber',
  'a number': 'documentNumber',
  'category': 'skip',
  'country_of_birth': 'nationality',
  'countryofbirth': 'nationality',
  'country of birth': 'nationality'
};

export class OCRService {
  private worker: Tesseract.Worker | null = null;
  private visionClient: ImageAnnotatorClient | null = null;
  private documentAiClient: DocumentProcessorServiceClient | null = null;
  private useGoogleVision: boolean = false;
  private useDocumentAi: boolean = false;

  constructor() {
    this.initializeGoogleServices();
  }

  private initializeGoogleServices(): void {
    try {
      // Check if Google Cloud credentials are configured
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT) {
        // Initialize Vision API (for face detection and fallback OCR)
        this.visionClient = new ImageAnnotatorClient();
        this.useGoogleVision = true;
        console.log('[OCRService] Google Cloud Vision API initialized');

        // Initialize Document AI if any processor IDs are configured
        const docAiConfig = config.googleCloud.documentAi;
        const hasDocAiProcessors =
          docAiConfig.usDriversLicenseProcessorId ||
          docAiConfig.usPassportProcessorId ||
          docAiConfig.caDriversLicenseProcessorId ||
          docAiConfig.caPassportProcessorId ||
          docAiConfig.genericIdProcessorId;

        if (hasDocAiProcessors) {
          this.documentAiClient = new DocumentProcessorServiceClient();
          this.useDocumentAi = true;
          console.log('[OCRService] Google Document AI initialized');

          // Log which processors are configured
          if (docAiConfig.caDriversLicenseProcessorId) {
            console.log('[OCRService] Canadian Driver License processor configured');
          }
          if (docAiConfig.caPassportProcessorId) {
            console.log('[OCRService] Canadian Passport processor configured');
          }
          if (docAiConfig.usDriversLicenseProcessorId) {
            console.log('[OCRService] US Driver License processor configured');
          }
          if (docAiConfig.usPassportProcessorId) {
            console.log('[OCRService] US Passport processor configured');
          }
        } else {
          console.log('[OCRService] Document AI processor IDs not configured, using Vision API for OCR');
        }
      } else {
        console.log('[OCRService] Google Cloud credentials not found, using Tesseract.js');
      }
    } catch (error) {
      console.log('[OCRService] Failed to initialize Google services, falling back to Tesseract:', error);
      this.useGoogleVision = false;
      this.useDocumentAi = false;
    }
  }

  async initialize(): Promise<void> {
    if (!this.useGoogleVision && !this.useDocumentAi) {
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
      // Use documentTextDetection for better structured document OCR
      const [result] = await this.visionClient!.documentTextDetection({
        image: { content: imageBuffer.toString('base64') }
      });

      const fullTextAnnotation = result.fullTextAnnotation;

      if (!fullTextAnnotation || !fullTextAnnotation.text) {
        console.log('[OCRService] Google Vision: No text detected, falling back to Tesseract');
        return this.extractTextWithTesseract(imageBuffer);
      }

      const fullText = fullTextAnnotation.text;

      // Calculate average confidence from blocks
      let confidence = 0.95;
      if (fullTextAnnotation.pages) {
        const confidences: number[] = [];
        for (const page of fullTextAnnotation.pages) {
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
    documentType: DocumentType,
    cachedDocumentAiEntities?: DocumentAiEntity[]
  ): Promise<ExtractedDocumentData> {
    console.log('[OCRService] Extracting document data for type:', documentType);

    // FIRST PREFERENCE: Try external Document OCR API
    try {
      console.log('[OCRService] Trying external Document OCR API first...');
      const externalResult = await this.extractWithExternalOcr(imageBuffer);
      console.log('[OCRService] External OCR API succeeded, using extracted data');
      return externalResult;
    } catch (error) {
      console.log('[OCRService] External OCR API failed, falling back to other methods:', error instanceof Error ? error.message : error);
    }

    // SECOND: If we have cached Document AI entities from detection, use them directly
    if (cachedDocumentAiEntities && cachedDocumentAiEntities.length > 0) {
      console.log('[OCRService] Using cached Document AI entities (', cachedDocumentAiEntities.length, 'entities) - skipping redundant API call');
      return this.extractFromCachedEntities(cachedDocumentAiEntities);
    }

    // THIRD: Try Google Document AI if configured
    if (this.useDocumentAi && this.documentAiClient) {
      const processorId = this.getProcessorIdForDocumentType(documentType);

      if (processorId) {
        try {
          console.log('[OCRService] Using Document AI for extraction');
          return await this.extractWithDocumentAi(imageBuffer, documentType, processorId);
        } catch (error) {
          console.error('[OCRService] Document AI extraction failed, falling back to Vision API:', error);
        }
      }
    }

    // FOURTH: Fallback to Vision API + regex parsing
    console.log('[OCRService] Using Vision API + regex parsing for extraction');
    const { text, confidence } = await this.extractText(imageBuffer);

    console.log('[OCRService] Extracted text:', text.substring(0, 500));
    console.log('[OCRService] Confidence:', confidence);

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
      case DocumentType.PERMANENT_RESIDENT_CARD:
        extractedData = this.parsePermanentResidentCard(text, confidence);
        break;
      default:
        extractedData = this.parseGenericDocument(text, confidence);
    }

    console.log('[OCRService] Parsed extracted data:', extractedData);

    return extractedData;
  }

  /**
   * Extract document data using the external Document OCR API
   * This is an alternative OCR method that can be used instead of or alongside Google services
   */
  async extractWithExternalOcr(imageBuffer: Buffer): Promise<ExtractedDocumentData> {
    const apiUrl = config.documentOcr.apiUrl;
    const apiKey = config.documentOcr.apiKey;

    console.log('[OCRService] Calling external Document OCR API');

    try {
      // Create form data with the image
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: 'document.jpg',
        contentType: 'image/jpeg'
      });

      const response = await axios.post<ExternalOcrResponse>(apiUrl, formData, {
        headers: {
          'X-API-Key': apiKey,
          ...formData.getHeaders()
        },
        timeout: 30000 // 30 second timeout
      });

      const data = response.data;

      if (!data.success) {
        throw new Error(data.error || 'External OCR API returned unsuccessful response');
      }

      console.log('[OCRService] External OCR API response received in', data.processing_time_seconds, 'seconds');

      // Map the response to ExtractedDocumentData
      const extractedData: ExtractedDocumentData = {
        confidence: 0.95 // External API is highly accurate
      };

      if (data.first_name) {
        extractedData.firstName = data.first_name;
      }

      if (data.last_name) {
        extractedData.lastName = data.last_name;
      }

      if (data.full_name) {
        extractedData.fullName = data.full_name;
      } else if (extractedData.firstName || extractedData.lastName) {
        extractedData.fullName = [extractedData.firstName, extractedData.lastName]
          .filter(Boolean)
          .join(' ');
      }

      if (data.document_number) {
        extractedData.documentNumber = data.document_number;
      }

      if (data.date_of_birth) {
        extractedData.dateOfBirth = this.normalizeExternalDate(data.date_of_birth);
      }

      if (data.issue_date) {
        extractedData.issueDate = this.normalizeExternalDate(data.issue_date);
      }

      if (data.expiry_date) {
        extractedData.expiryDate = this.normalizeExternalDate(data.expiry_date);
      }

      if (data.gender) {
        extractedData.gender = data.gender.charAt(0).toUpperCase();
      }

      if (data.address) {
        extractedData.address = this.parseExternalAddress(data.address);
      }

      // Log any missing fields for debugging
      if (data.missing_fields && data.missing_fields.length > 0) {
        console.log('[OCRService] External OCR missing fields:', data.missing_fields);
      }

      console.log('[OCRService] External OCR extracted data:', extractedData);

      return extractedData;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('[OCRService] External OCR API request failed:', error.message);
        if (error.response) {
          console.error('[OCRService] Response status:', error.response.status);
          console.error('[OCRService] Response data:', error.response.data);
        }
      } else {
        console.error('[OCRService] External OCR extraction failed:', error);
      }
      throw new Error(`External OCR extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Normalize date from external OCR API format (YYYY/MM/DD) to standard format (YYYY-MM-DD)
   */
  private normalizeExternalDate(dateStr: string): string {
    // Handle YYYY/MM/DD format from external API
    if (dateStr.includes('/')) {
      return dateStr.replace(/\//g, '-');
    }
    return dateStr;
  }

  /**
   * Parse address string from external OCR API into structured format
   * Example input: "57 KALMAR CRES RICHMOND HILL, ON, L4E 3Z4"
   */
  private parseExternalAddress(addressStr: string): ExtractedDocumentData['address'] {
    // Try to parse Canadian format: "STREET, CITY, PROVINCE, POSTAL"
    // or "STREET CITY, PROVINCE, POSTAL"
    const parts = addressStr.split(',').map(p => p.trim());

    if (parts.length >= 3) {
      // Format: "STREET CITY, PROVINCE, POSTAL" or "STREET, CITY, PROVINCE POSTAL"
      const streetAndCity = parts[0];
      const province = parts[1].trim();
      const postalCode = parts[2].trim();

      // Try to detect Canadian postal code pattern (A1A 1A1)
      const canadianPostalMatch = postalCode.match(/([A-Z]\d[A-Z]\s?\d[A-Z]\d)/i);
      const usZipMatch = postalCode.match(/(\d{5}(?:-\d{4})?)/);

      // Try to separate street from city in the first part
      // Look for common patterns like "123 STREET NAME CITY"
      const cityKeywords = ['HILL', 'VILLE', 'TOWN', 'CITY', 'HEIGHTS', 'PARK', 'VILLAGE', 'BEACH', 'LAKE', 'RIVER'];
      let street = streetAndCity;
      let city: string | undefined;

      // If province contains postal code, extract it
      const provincePostalMatch = province.match(/^([A-Z]{2})\s+([A-Z0-9\s]+)$/i);
      let actualProvince = province;
      let actualPostalCode = canadianPostalMatch ? canadianPostalMatch[1] : (usZipMatch ? usZipMatch[1] : postalCode);

      if (provincePostalMatch) {
        actualProvince = provincePostalMatch[1];
        actualPostalCode = provincePostalMatch[2].trim();
      }

      // Try to find city in the street+city part by looking for the last word before common endings
      for (const keyword of cityKeywords) {
        const keywordIndex = streetAndCity.toUpperCase().indexOf(keyword);
        if (keywordIndex > 0) {
          // Find the start of the city name (word before the keyword or the keyword itself as part of city name)
          const beforeKeyword = streetAndCity.substring(0, keywordIndex + keyword.length);
          const words = beforeKeyword.trim().split(/\s+/);
          if (words.length > 2) {
            // Assume last 2 words are city name
            city = words.slice(-2).join(' ');
            street = words.slice(0, -2).join(' ');
          }
          break;
        }
      }

      // Detect country from postal code format
      const isCanadian = /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(actualPostalCode);

      return {
        street,
        city,
        state: actualProvince,
        postalCode: actualPostalCode,
        country: isCanadian ? 'CAN' : 'USA'
      };
    } else if (parts.length === 2) {
      // Format: "STREET, CITY STATE POSTAL"
      const street = parts[0];
      const cityStatePostal = parts[1];

      // Try to parse "CITY STATE POSTAL"
      const statePostalMatch = cityStatePostal.match(/(.+?)\s+([A-Z]{2})\s+([A-Z0-9\s]+)$/i);
      if (statePostalMatch) {
        return {
          street,
          city: statePostalMatch[1].trim(),
          state: statePostalMatch[2],
          postalCode: statePostalMatch[3].trim(),
          country: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(statePostalMatch[3].trim()) ? 'CAN' : 'USA'
        };
      }

      return {
        street,
        city: cityStatePostal
      };
    }

    // Fallback: return the whole string as street
    return {
      street: addressStr
    };
  }

  /**
   * Extract document data from cached Document AI entities
   * This avoids making a redundant Document AI API call when detection already extracted the data
   */
  private extractFromCachedEntities(entities: DocumentAiEntity[]): ExtractedDocumentData {
    console.log('[OCRService] Processing', entities.length, 'cached Document AI entities');

    const extractedData: ExtractedDocumentData = {
      confidence: 0.95 // Document AI is highly accurate
    };

    // Temporary storage for address components
    const addressComponents: {
      street?: string;
      city?: string;
      province?: string;
      postalCode?: string;
    } = {};

    for (const entity of entities) {
      const entityType = entity.type.toLowerCase().replace(/\s+/g, '_');
      const mentionText = entity.mentionText;
      const normalizedValue = entity.normalizedValue;

      console.log(`[OCRService] Cached entity: ${entityType} = ${mentionText}`);

      // Map entity to our field using the mapping table
      const mappedField = ENTITY_MAPPINGS[entityType];

      if (mappedField === 'skip') {
        // Handle address components separately
        if (entityType === 'city') {
          addressComponents.city = mentionText;
        } else if (entityType === 'province' || entityType === 'state') {
          addressComponents.province = mentionText;
        } else if (entityType === 'postal_code' || entityType === 'postalcode' || entityType === 'zip') {
          addressComponents.postalCode = mentionText;
        }
        continue;
      }

      if (!mappedField) {
        console.log(`[OCRService] Unknown entity type: ${entityType}`);
        continue;
      }

      // Handle different field types
      switch (mappedField) {
        case 'lastName':
          extractedData.lastName = mentionText;
          break;
        case 'firstName':
          extractedData.firstName = mentionText;
          break;
        case 'documentNumber':
          extractedData.documentNumber = mentionText;
          break;
        case 'dateOfBirth':
          extractedData.dateOfBirth = this.extractDateValue(normalizedValue, mentionText);
          break;
        case 'expiryDate':
          extractedData.expiryDate = this.extractDateValue(normalizedValue, mentionText);
          break;
        case 'issueDate':
          extractedData.issueDate = this.extractDateValue(normalizedValue, mentionText);
          break;
        case 'address':
          addressComponents.street = mentionText;
          break;
        case 'mrz':
          extractedData.mrz = mentionText;
          break;
        case 'gender':
          extractedData.gender = mentionText.charAt(0).toUpperCase();
          break;
        case 'nationality':
          extractedData.nationality = mentionText;
          break;
      }

      // Update confidence if available
      if (entity.confidence) {
        extractedData.confidence = Math.min(extractedData.confidence || 1, entity.confidence);
      }
    }

    // Construct full name from first and last name
    if (extractedData.firstName || extractedData.lastName) {
      extractedData.fullName = [extractedData.firstName, extractedData.lastName]
        .filter(Boolean)
        .join(' ');
    }

    // Construct address from components
    if (addressComponents.street || addressComponents.city || addressComponents.province) {
      extractedData.address = {
        street: addressComponents.street,
        city: addressComponents.city,
        state: addressComponents.province,
        postalCode: addressComponents.postalCode,
        country: this.detectCountryFromAddress(addressComponents)
      };
    }

    console.log('[OCRService] Extracted data from cached entities:', extractedData);

    return extractedData;
  }

  private getProcessorIdForDocumentType(documentType: DocumentType): string | null {
    const docAiConfig = config.googleCloud.documentAi;

    switch (documentType) {
      case DocumentType.DRIVERS_LICENSE:
        // Prefer Canadian processor, fall back to US, then generic
        return docAiConfig.caDriversLicenseProcessorId ||
               docAiConfig.usDriversLicenseProcessorId ||
               docAiConfig.genericIdProcessorId ||
               null;

      case DocumentType.PASSPORT:
        // Prefer Canadian processor, fall back to US, then generic
        return docAiConfig.caPassportProcessorId ||
               docAiConfig.usPassportProcessorId ||
               docAiConfig.genericIdProcessorId ||
               null;

      case DocumentType.NATIONAL_ID:
      case DocumentType.RESIDENCE_PERMIT:
      case DocumentType.PERMANENT_RESIDENT_CARD:
        // Use generic processor for other ID types
        return docAiConfig.genericIdProcessorId || null;

      default:
        return null;
    }
  }

  private async extractWithDocumentAi(
    imageBuffer: Buffer,
    _documentType: DocumentType,
    processorId: string
  ): Promise<ExtractedDocumentData> {
    const projectId = config.googleCloud.projectId;
    const location = config.googleCloud.location || 'us';

    const processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;

    console.log('[OCRService] Document AI processor:', processorName);

    const request = {
      name: processorName,
      rawDocument: {
        content: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg'
      }
    };

    const [result] = await this.documentAiClient!.processDocument(request);
    const { document } = result;

    if (!document || !document.entities) {
      throw new Error('Document AI returned no entities');
    }

    console.log('[OCRService] Document AI entities found:', document.entities.length);

    // Map Document AI entities to our ExtractedDocumentData format
    const extractedData: ExtractedDocumentData = {
      confidence: 0.95 // Document AI is highly accurate
    };

    // Temporary storage for address components
    const addressComponents: {
      street?: string;
      city?: string;
      province?: string;
      postalCode?: string;
    } = {};

    for (const entity of document.entities) {
      const entityType = entity.type?.toLowerCase().replace(/\s+/g, '_') || '';
      const mentionText = entity.mentionText || '';
      const normalizedValue = entity.normalizedValue;

      console.log(`[OCRService] Entity: ${entityType} = ${mentionText}`);

      // Map entity to our field using the mapping table
      const mappedField = ENTITY_MAPPINGS[entityType];

      if (mappedField === 'skip') {
        // Handle address components separately
        if (entityType === 'city') {
          addressComponents.city = mentionText;
        } else if (entityType === 'province' || entityType === 'state') {
          addressComponents.province = mentionText;
        } else if (entityType === 'postal_code' || entityType === 'postalcode' || entityType === 'zip') {
          addressComponents.postalCode = mentionText;
        }
        continue;
      }

      if (!mappedField) {
        console.log(`[OCRService] Unknown entity type: ${entityType}`);
        continue;
      }

      // Handle different field types
      switch (mappedField) {
        case 'lastName':
          extractedData.lastName = mentionText;
          break;
        case 'firstName':
          extractedData.firstName = mentionText;
          break;
        case 'documentNumber':
          extractedData.documentNumber = mentionText;
          break;
        case 'dateOfBirth':
          extractedData.dateOfBirth = this.extractDateValue(normalizedValue, mentionText);
          break;
        case 'expiryDate':
          extractedData.expiryDate = this.extractDateValue(normalizedValue, mentionText);
          break;
        case 'issueDate':
          extractedData.issueDate = this.extractDateValue(normalizedValue, mentionText);
          break;
        case 'address':
          addressComponents.street = mentionText;
          break;
        case 'mrz':
          extractedData.mrz = mentionText;
          break;
        case 'gender':
          extractedData.gender = mentionText.charAt(0).toUpperCase();
          break;
        case 'nationality':
          extractedData.nationality = mentionText;
          break;
      }

      // Update confidence if available
      if (entity.confidence) {
        extractedData.confidence = Math.min(extractedData.confidence || 1, entity.confidence);
      }
    }

    // Construct full name from first and last name
    if (extractedData.firstName || extractedData.lastName) {
      extractedData.fullName = [extractedData.firstName, extractedData.lastName]
        .filter(Boolean)
        .join(' ');
    }

    // Construct address from components
    if (addressComponents.street || addressComponents.city || addressComponents.province) {
      extractedData.address = {
        street: addressComponents.street,
        city: addressComponents.city,
        state: addressComponents.province,
        postalCode: addressComponents.postalCode,
        country: this.detectCountryFromAddress(addressComponents)
      };
    }

    console.log('[OCRService] Document AI extracted data:', extractedData);

    return extractedData;
  }

  private extractDateValue(normalizedValue: any, mentionText: string): string {
    if (normalizedValue?.dateValue) {
      const dv = normalizedValue.dateValue;
      return `${dv.year}-${String(dv.month).padStart(2, '0')}-${String(dv.day).padStart(2, '0')}`;
    }
    // Try to parse the mention text as a date
    return this.normalizeDate(mentionText);
  }

  private detectCountryFromAddress(addressComponents: { province?: string; postalCode?: string }): string {
    // Canadian postal codes are in format A1A 1A1 (letter-digit-letter space digit-letter-digit)
    if (addressComponents.postalCode && /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(addressComponents.postalCode)) {
      return 'CAN';
    }
    // Canadian provinces
    const canadianProvinces = ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU'];
    if (addressComponents.province && canadianProvinces.includes(addressComponents.province.toUpperCase())) {
      return 'CAN';
    }
    // US ZIP codes are 5 digits or 5+4 format
    if (addressComponents.postalCode && /^\d{5}(-\d{4})?$/.test(addressComponents.postalCode)) {
      return 'USA';
    }
    return 'USA'; // Default fallback
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

  /**
   * Parse Permanent Resident Card (US Green Card, Canadian PR Card, etc.)
   */
  private parsePermanentResidentCard(text: string, confidence: number): ExtractedDocumentData {
    const data: ExtractedDocumentData = { confidence };
    const upperText = text.toUpperCase();

    console.log('[OCRService] Parsing Permanent Resident Card text:', text.substring(0, 500));

    // Extract names - PR cards typically have LAST NAME, FIRST NAME format
    // US Green Card format: "SURNAME\nGIVEN NAME"
    const lastNameMatch = text.match(/(?:SURNAME|LAST\s*NAME|FAMILY\s*NAME)[:\s]*([A-Z][A-Z\s\-']+)/i);
    if (lastNameMatch) {
      data.lastName = lastNameMatch[1].trim();
    }

    const firstNameMatch = text.match(/(?:GIVEN\s*NAME|FIRST\s*NAME|NOMBRE)[:\s]*([A-Z][A-Z\s\-']+)/i);
    if (firstNameMatch) {
      data.firstName = firstNameMatch[1].trim();
    }

    // Fallback: Look for name on a line by itself (common in cards)
    if (!data.firstName && !data.lastName) {
      const nameLineMatch = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)$/m);
      if (nameLineMatch) {
        data.fullName = nameLineMatch[1].trim();
      }
    } else if (data.firstName && data.lastName) {
      data.fullName = `${data.firstName} ${data.lastName}`;
    }

    // Document Number - US Green Card USCIS number (3 letters + 10 digits)
    // Look for patterns like "SRC1234567890" or labeled fields
    const uscisMatch = text.match(/(?:USCIS|Card|Number)[#:\s]*([A-Z]{3}\d{10})/i);
    if (uscisMatch) {
      data.documentNumber = uscisMatch[1].toUpperCase();
    } else {
      // Try to find the 13-character USCIS number pattern
      const cardNumberMatch = text.match(/\b([A-Z]{3}\d{10})\b/);
      if (cardNumberMatch) {
        data.documentNumber = cardNumberMatch[1];
      }
    }

    // Alien Registration Number (A-Number) - starts with A followed by 7-9 digits
    if (!data.documentNumber) {
      const aNumberMatch = text.match(/(?:A#|A-Number|Alien\s*(?:Registration\s*)?(?:Number|No))[:\s]*A?(\d{7,9})/i);
      if (aNumberMatch) {
        data.documentNumber = 'A' + aNumberMatch[1];
      } else {
        const aNumPattern = text.match(/\bA(\d{7,9})\b/);
        if (aNumPattern) {
          data.documentNumber = 'A' + aNumPattern[1];
        }
      }
    }

    // Canadian PR Card number
    if (!data.documentNumber) {
      const caPrMatch = text.match(/(?:Card|Document|PR)\s*(?:Number|No|#)[:\s]*([A-Z]{1,2}\d{6,9})/i);
      if (caPrMatch) {
        data.documentNumber = caPrMatch[1].toUpperCase();
      }
    }

    // Date of Birth - multiple patterns
    const dobPatterns = [
      /(?:DATE\s*OF\s*BIRTH|DOB|BIRTH\s*DATE|BORN)[:\s]*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i,
      /(?:DATE\s*OF\s*BIRTH|DOB|BIRTH\s*DATE|BORN)[:\s]*([A-Z]{3}\s+\d{1,2},?\s+\d{4})/i, // "JAN 15, 1990"
      /(?:DATE\s*OF\s*BIRTH|DOB)[:\s]*(\d{4}[-\/]\d{2}[-\/]\d{2})/i // YYYY-MM-DD
    ];

    for (const pattern of dobPatterns) {
      const dobMatch = text.match(pattern);
      if (dobMatch) {
        data.dateOfBirth = this.normalizeDate(dobMatch[1]);
        break;
      }
    }

    // Expiry Date - CRITICAL: Multiple patterns for PR cards
    // US Green Card: "CARD EXPIRES" or just "EXPIRES"
    // Canadian PR Card: "EXP" or "EXPIRY"
    const expiryPatterns = [
      /(?:CARD\s*EXPIRES?|EXPIRES?|EXPIRY|EXPIRATION|EXP\.?\s*DATE|VALID\s*(?:UNTIL|THRU|THROUGH))[:\s]*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i,
      /(?:CARD\s*EXPIRES?|EXPIRES?|EXPIRY|EXP)[:\s]*([A-Z]{3}\s+\d{1,2},?\s+\d{4})/i, // "JAN 15, 2030"
      /(?:CARD\s*EXPIRES?|EXPIRES?|EXP)[:\s]*(\d{4}[-\/]\d{2}[-\/]\d{2})/i, // YYYY-MM-DD
      /(?:CARD\s*EXPIRES?|EXPIRES?)[:\s]*(\d{2}[-\/]\d{2}[-\/]\d{4})/i, // MM/DD/YYYY
      /(?:CARD\s*EXPIRES?)[:\s]*(\d{2}\s*\d{2}\s*\d{4})/i // MMDDYYYY (no separators)
    ];

    for (const pattern of expiryPatterns) {
      const expiryMatch = text.match(pattern);
      if (expiryMatch) {
        console.log('[OCRService] Found expiry date match:', expiryMatch[1]);
        data.expiryDate = this.normalizeDate(expiryMatch[1]);
        break;
      }
    }

    // If still no expiry, look for any date that appears after "EXPIRES" keyword
    if (!data.expiryDate) {
      const expiresIndex = upperText.indexOf('EXPIRES');
      const cardExpiresIndex = upperText.indexOf('CARD EXPIRES');

      const searchStartIndex = cardExpiresIndex !== -1 ? cardExpiresIndex : expiresIndex;

      if (searchStartIndex !== -1) {
        const textAfterExpires = text.substring(searchStartIndex);
        const dateMatch = textAfterExpires.match(/(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/);
        if (dateMatch) {
          console.log('[OCRService] Found expiry date after EXPIRES keyword:', dateMatch[1]);
          data.expiryDate = this.normalizeDate(dateMatch[1]);
        }
      }
    }

    // Resident Since / Issue Date
    const residentSincePatterns = [
      /(?:RESIDENT\s*SINCE|SINCE|ISSUED?)[:\s]*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i,
      /(?:RESIDENT\s*SINCE|SINCE)[:\s]*([A-Z]{3}\s+\d{1,2},?\s+\d{4})/i
    ];

    for (const pattern of residentSincePatterns) {
      const issueMatch = text.match(pattern);
      if (issueMatch) {
        data.issueDate = this.normalizeDate(issueMatch[1]);
        break;
      }
    }

    // Country of Birth (common on PR cards)
    const countryMatch = text.match(/(?:COUNTRY\s*OF\s*BIRTH|COB|BIRTH\s*COUNTRY)[:\s]*([A-Z]{2,30})/i);
    if (countryMatch) {
      data.nationality = countryMatch[1].trim();
    }

    // Gender
    const genderMatch = text.match(/(?:SEX|GENDER)[:\s]*(M|F|MALE|FEMALE)/i);
    if (genderMatch) {
      data.gender = genderMatch[1].charAt(0).toUpperCase();
    }

    // Category (for reporting purposes)
    const categoryMatch = text.match(/(?:CATEGORY|CAT)[:\s]*([A-Z0-9]{1,5})/i);
    if (categoryMatch) {
      // Store in a way that can be logged but won't interfere with main data
      console.log('[OCRService] PR Card category:', categoryMatch[1]);
    }

    // Issuing Country - default based on detected patterns
    if (data.documentNumber) {
      if (/^[A-Z]{3}\d{10}$/.test(data.documentNumber)) {
        data.issuingCountry = 'US';
      } else if (/^[A-Z]{1,2}\d{6,9}$/.test(data.documentNumber)) {
        data.issuingCountry = 'CA';
      }
    }

    console.log('[OCRService] Parsed PR Card data:', data);

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

    // Try to detect Canadian postal code (A1A 1A1 format)
    const canadianPostalMatch = addressText.match(/\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i);
    // Try to detect US ZIP code
    const usZipMatch = addressText.match(/\b(\d{5}(?:-\d{4})?)\b/);

    const stateMatch = addressText.match(/\b([A-Z]{2})\b/);

    const isCanadian = !!canadianPostalMatch;

    return {
      street: parts[0] || undefined,
      city: parts[1] || undefined,
      state: stateMatch ? stateMatch[1] : undefined,
      postalCode: isCanadian
        ? canadianPostalMatch![1].toUpperCase()
        : (usZipMatch ? usZipMatch[1] : undefined),
      country: isCanadian ? 'CAN' : 'USA'
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
