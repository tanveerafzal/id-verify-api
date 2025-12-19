import { DocumentType } from '../types/verification.types';

export interface DocumentIdValidationResult {
  isValid: boolean;
  documentType: DocumentType;
  documentNumber: string;
  normalizedNumber: string;
  country?: string;
  state?: string;
  errors: string[];
  warnings: string[];
}

export interface ExtractedPersonData {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  dateOfBirth?: string;
}

interface ValidationPattern {
  pattern: RegExp;
  description: string;
  country?: string;
  state?: string;
  normalize?: (value: string) => string;
}

export class DocumentIdValidatorService {

  /**
   * Validate a document ID number based on document type
   * @param documentNumber - The document ID number to validate
   * @param documentType - The type of document
   * @param issuingCountry - Optional issuing country code
   * @param personData - Optional extracted person data for cross-validation
   */
  validateDocumentId(
    documentNumber: string,
    documentType: DocumentType,
    issuingCountry?: string,
    personData?: ExtractedPersonData
  ): DocumentIdValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!documentNumber || documentNumber.trim().length === 0) {
      return {
        isValid: false,
        documentType,
        documentNumber: documentNumber || '',
        normalizedNumber: '',
        errors: ['Document number is required'],
        warnings: []
      };
    }

    // Normalize the document number (remove spaces, convert to uppercase)
    const normalizedNumber = this.normalizeDocumentNumber(documentNumber);

    // Basic length check
    if (normalizedNumber.length < 4) {
      errors.push('Document number is too short (minimum 4 characters)');
    }

    if (normalizedNumber.length > 20) {
      errors.push('Document number is too long (maximum 20 characters)');
    }

    // Type-specific validation
    let validationResult: { isValid: boolean; country?: string; state?: string; errors: string[]; warnings: string[] };

    switch (documentType) {
      case 'PASSPORT':
        validationResult = this.validatePassportNumber(normalizedNumber, issuingCountry);
        break;
      case 'DRIVERS_LICENSE':
        validationResult = this.validateDriversLicenseNumber(normalizedNumber, issuingCountry, personData);
        break;
      case 'NATIONAL_ID':
        validationResult = this.validateNationalIdNumber(normalizedNumber, issuingCountry);
        break;
      case 'RESIDENCE_PERMIT':
        validationResult = this.validateResidencePermitNumber(normalizedNumber, issuingCountry);
        break;
      case 'PERMANENT_RESIDENT_CARD':
        validationResult = this.validatePermanentResidentCardNumber(normalizedNumber, issuingCountry);
        break;
      default:
        validationResult = this.validateGenericDocumentNumber(normalizedNumber);
    }

    errors.push(...validationResult.errors);
    warnings.push(...validationResult.warnings);

    return {
      isValid: errors.length === 0,
      documentType,
      documentNumber,
      normalizedNumber,
      country: validationResult.country || issuingCountry,
      state: validationResult.state,
      errors,
      warnings
    };
  }

  /**
   * Normalize document number - remove spaces, special chars, uppercase
   */
  private normalizeDocumentNumber(documentNumber: string): string {
    return documentNumber
      .toUpperCase()
      .replace(/[\s\-\.]/g, '') // Remove spaces, hyphens, dots
      .trim();
  }

  /**
   * Validate passport number format
   */
  private validatePassportNumber(
    number: string,
    country?: string
  ): { isValid: boolean; country?: string; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Passport number patterns by country
    const passportPatterns: Record<string, ValidationPattern> = {
      // US Passport: 9 digits or 1 letter + 8 digits
      US: {
        pattern: /^[0-9]{9}$|^[A-Z][0-9]{8}$/,
        description: 'US passport: 9 digits or 1 letter followed by 8 digits',
        country: 'US'
      },
      // Canadian Passport: 2 letters + 6 digits (+ optional check digit = 9 chars)
      CA: {
        pattern: /^[A-Z]{2}[0-9]{6}[0-9]?$/,
        description: 'Canadian passport: 2 letters followed by 6 digits (+ optional check digit)',
        country: 'CA'
      },
      // UK Passport: 9 digits
      GB: {
        pattern: /^[0-9]{9}$/,
        description: 'UK passport: 9 digits',
        country: 'GB'
      },
      // Indian Passport: 1 letter + 7 digits
      IN: {
        pattern: /^[A-Z][0-9]{7}$/,
        description: 'Indian passport: 1 letter followed by 7 digits',
        country: 'IN'
      },
      // Australian Passport: 1-2 letters + 7 digits
      AU: {
        pattern: /^[A-Z]{1,2}[0-9]{7}$/,
        description: 'Australian passport: 1-2 letters followed by 7 digits',
        country: 'AU'
      },
      // German Passport: 9-10 alphanumeric characters
      DE: {
        pattern: /^[A-Z0-9]{9,10}$/,
        description: 'German passport: 9-10 alphanumeric characters',
        country: 'DE'
      },
      // French Passport: 9 alphanumeric characters
      FR: {
        pattern: /^[A-Z0-9]{9}$/,
        description: 'French passport: 9 alphanumeric characters',
        country: 'FR'
      }
    };

    // Generic passport pattern (fallback)
    const genericPassportPattern = /^[A-Z0-9]{6,12}$/;

    // Try country-specific validation first
    if (country && passportPatterns[country.toUpperCase()]) {
      const pattern = passportPatterns[country.toUpperCase()];
      if (!pattern.pattern.test(number)) {
        errors.push(`Invalid ${country} passport number format. Expected: ${pattern.description}`);
      } else {
        // Additional checksum validation for Canadian passports
        if (country.toUpperCase() === 'CA') {
          if (!this.validateCanadianPassportChecksum(number)) {
            errors.push('Canadian passport number checksum validation failed. Please verify the passport number is correct.');
          }
        }
      }
      return { isValid: errors.length === 0, country: country.toUpperCase(), errors, warnings };
    }

    // Try to detect country from pattern
    for (const [countryCode, pattern] of Object.entries(passportPatterns)) {
      if (pattern.pattern.test(number)) {
        // Additional checksum validation for Canadian passports
        if (countryCode === 'CA') {
          if (!this.validateCanadianPassportChecksum(number)) {
            errors.push('Canadian passport number checksum validation failed. Please verify the passport number is correct.');
            return { isValid: false, country: countryCode, errors, warnings };
          }
        }
        warnings.push(`Passport number matches ${countryCode} format`);
        return { isValid: true, country: countryCode, errors, warnings };
      }
    }

    // Fall back to generic validation
    if (!genericPassportPattern.test(number)) {
      errors.push('Invalid passport number format. Must be 6-12 alphanumeric characters');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate driver's license number format
   * @param number - The normalized DL number
   * @param country - Optional country code
   * @param personData - Optional person data for cross-validation (e.g., Ontario DL starts with last name initial)
   */
  private validateDriversLicenseNumber(
    number: string,
    country?: string,
    personData?: ExtractedPersonData
  ): { isValid: boolean; country?: string; state?: string; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // US State driver's license patterns
    const usStatePatterns: Record<string, ValidationPattern> = {
      // California: 1 letter + 7 digits
      CA: {
        pattern: /^[A-Z][0-9]{7}$/,
        description: 'California DL: 1 letter followed by 7 digits',
        state: 'CA',
        country: 'US'
      },
      // New York: 9 digits or 1 letter + 18 characters
      NY: {
        pattern: /^[0-9]{9}$|^[A-Z][A-Z0-9]{17}$/,
        description: 'New York DL: 9 digits or 1 letter + 17 characters',
        state: 'NY',
        country: 'US'
      },
      // Texas: 8 digits
      TX: {
        pattern: /^[0-9]{8}$/,
        description: 'Texas DL: 8 digits',
        state: 'TX',
        country: 'US'
      },
      // Florida: 1 letter + 12 digits or 13 digits
      FL: {
        pattern: /^[A-Z][0-9]{12}$|^[0-9]{13}$/,
        description: 'Florida DL: 1 letter + 12 digits or 13 digits',
        state: 'FL',
        country: 'US'
      },
      // Illinois: 1 letter + 11 digits
      IL: {
        pattern: /^[A-Z][0-9]{11}$/,
        description: 'Illinois DL: 1 letter followed by 11 digits',
        state: 'IL',
        country: 'US'
      },
      // Pennsylvania: 8 digits
      PA: {
        pattern: /^[0-9]{8}$/,
        description: 'Pennsylvania DL: 8 digits',
        state: 'PA',
        country: 'US'
      },
      // Ohio: 2 letters + 6 digits
      OH: {
        pattern: /^[A-Z]{2}[0-9]{6}$/,
        description: 'Ohio DL: 2 letters followed by 6 digits',
        state: 'OH',
        country: 'US'
      },
      // Michigan: 1 letter + 12 digits
      MI: {
        pattern: /^[A-Z][0-9]{12}$/,
        description: 'Michigan DL: 1 letter followed by 12 digits',
        state: 'MI',
        country: 'US'
      }
    };

    // Canadian province patterns
    const canadianPatterns: Record<string, ValidationPattern> = {
      // Ontario: 1 letter + 14 digits (usually hyphenated)
      ON: {
        pattern: /^[A-Z][0-9]{14}$|^[A-Z][0-9]{4}[0-9]{5}[0-9]{5}$/,
        description: 'Ontario DL: 1 letter followed by 14 digits',
        state: 'ON',
        country: 'CA'
      },
      // British Columbia: 7 digits
      BC: {
        pattern: /^[0-9]{7}$/,
        description: 'British Columbia DL: 7 digits',
        state: 'BC',
        country: 'CA'
      },
      // Alberta: 6-9 digits
      AB: {
        pattern: /^[0-9]{6,9}$/,
        description: 'Alberta DL: 6-9 digits',
        state: 'AB',
        country: 'CA'
      },
      // Quebec: 1 letter + 12 alphanumeric characters
      QC: {
        pattern: /^[A-Z][A-Z0-9]{12}$/,
        description: 'Quebec DL: 1 letter followed by 12 alphanumeric characters',
        state: 'QC',
        country: 'CA'
      }
    };

    // Generic driver's license pattern
    const genericDLPattern = /^[A-Z0-9]{5,18}$/;

    // Try US state patterns
    for (const [state, pattern] of Object.entries(usStatePatterns)) {
      if (pattern.pattern.test(number)) {
        return { isValid: true, country: 'US', state, errors, warnings };
      }
    }

    // Try Canadian province patterns
    for (const [province, pattern] of Object.entries(canadianPatterns)) {
      if (pattern.pattern.test(number)) {
        // Special validation for Ontario: first letter must match last name initial
        if (province === 'ON' && personData) {
          const lastNameInitial = this.getLastNameInitial(personData);
          if (lastNameInitial) {
            const dlFirstLetter = number.charAt(0).toUpperCase();
            if (dlFirstLetter !== lastNameInitial) {
              errors.push(`Ontario DL number must start with the first letter of your last name. Expected '${lastNameInitial}' but found '${dlFirstLetter}'`);
              return { isValid: false, country: 'CA', state: province, errors, warnings };
            }
            console.log(`[DocumentIdValidator] Ontario DL validated: first letter '${dlFirstLetter}' matches last name initial '${lastNameInitial}'`);
          }
        }
        return { isValid: true, country: 'CA', state: province, errors, warnings };
      }
    }

    // Fall back to generic validation
    if (!genericDLPattern.test(number)) {
      errors.push('Invalid driver\'s license number format. Must be 5-18 alphanumeric characters');
    }

    return { isValid: errors.length === 0, country, errors, warnings };
  }

  /**
   * Validate national ID number format
   */
  private validateNationalIdNumber(
    number: string,
    country?: string
  ): { isValid: boolean; country?: string; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // National ID patterns by country
    const nationalIdPatterns: Record<string, ValidationPattern> = {
      // US Social Security Number: 9 digits (XXX-XX-XXXX)
      US: {
        pattern: /^[0-9]{9}$/,
        description: 'US SSN: 9 digits',
        country: 'US'
      },
      // Canadian SIN: 9 digits
      CA: {
        pattern: /^[0-9]{9}$/,
        description: 'Canadian SIN: 9 digits',
        country: 'CA'
      },
      // UK National Insurance Number: 2 letters + 6 digits + 1 letter
      GB: {
        pattern: /^[A-Z]{2}[0-9]{6}[A-Z]$/,
        description: 'UK NI Number: 2 letters + 6 digits + 1 letter',
        country: 'GB'
      },
      // Indian Aadhaar: 12 digits
      IN: {
        pattern: /^[0-9]{12}$/,
        description: 'Indian Aadhaar: 12 digits',
        country: 'IN'
      },
      // Mexican CURP: 18 alphanumeric characters
      MX: {
        pattern: /^[A-Z]{4}[0-9]{6}[A-Z]{6}[A-Z0-9]{2}$/,
        description: 'Mexican CURP: 18 alphanumeric characters',
        country: 'MX'
      }
    };

    // Generic national ID pattern
    const genericNationalIdPattern = /^[A-Z0-9]{6,18}$/;

    // Try country-specific validation
    if (country && nationalIdPatterns[country.toUpperCase()]) {
      const pattern = nationalIdPatterns[country.toUpperCase()];
      if (!pattern.pattern.test(number)) {
        errors.push(`Invalid ${country} national ID format. Expected: ${pattern.description}`);
      }
      return { isValid: errors.length === 0, country: country.toUpperCase(), errors, warnings };
    }

    // Try to detect country from pattern
    for (const [countryCode, pattern] of Object.entries(nationalIdPatterns)) {
      if (pattern.pattern.test(number)) {
        warnings.push(`National ID matches ${countryCode} format`);
        return { isValid: true, country: countryCode, errors, warnings };
      }
    }

    // Fall back to generic validation
    if (!genericNationalIdPattern.test(number)) {
      errors.push('Invalid national ID format. Must be 6-18 alphanumeric characters');
    }

    return { isValid: errors.length === 0, country, errors, warnings };
  }

  /**
   * Validate residence permit number format
   */
  private validateResidencePermitNumber(
    number: string,
    country?: string
  ): { isValid: boolean; country?: string; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Residence permit patterns
    const residencePermitPatterns: Record<string, ValidationPattern> = {
      // US Green Card: 13 alphanumeric characters
      US: {
        pattern: /^[A-Z]{3}[0-9]{10}$/,
        description: 'US Green Card: 3 letters followed by 10 digits',
        country: 'US'
      },
      // UK BRP: 9 alphanumeric characters
      GB: {
        pattern: /^[A-Z0-9]{9}$/,
        description: 'UK BRP: 9 alphanumeric characters',
        country: 'GB'
      }
    };

    // Generic residence permit pattern
    const genericPattern = /^[A-Z0-9]{6,15}$/;

    // Try country-specific validation
    if (country && residencePermitPatterns[country.toUpperCase()]) {
      const pattern = residencePermitPatterns[country.toUpperCase()];
      if (!pattern.pattern.test(number)) {
        errors.push(`Invalid ${country} residence permit format. Expected: ${pattern.description}`);
      }
      return { isValid: errors.length === 0, country: country.toUpperCase(), errors, warnings };
    }

    // Fall back to generic validation
    if (!genericPattern.test(number)) {
      errors.push('Invalid residence permit number format. Must be 6-15 alphanumeric characters');
    }

    return { isValid: errors.length === 0, country, errors, warnings };
  }

  /**
   * Validate permanent resident card number format
   * Includes US Green Card (I-551), Canadian PR Card, and other countries
   */
  private validatePermanentResidentCardNumber(
    number: string,
    country?: string
  ): { isValid: boolean; country?: string; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Permanent Resident Card patterns by country
    const prCardPatterns: Record<string, ValidationPattern> = {
      // US Green Card (I-551): 3 letters (receipt center code) + 10 digits
      // Examples: SRC1234567890, EAC0987654321
      US: {
        pattern: /^[A-Z]{3}[0-9]{10}$/,
        description: 'US Green Card: 3 letters followed by 10 digits (e.g., SRC1234567890)',
        country: 'US'
      },
      // Canadian PR Card: Alphanumeric, typically 8-10 characters
      // Format varies but commonly starts with letters
      CA: {
        pattern: /^[A-Z]{1,2}[0-9]{6,9}$/,
        description: 'Canadian PR Card: 1-2 letters followed by 6-9 digits',
        country: 'CA'
      },
      // Australian Permanent Resident (evidence number): Alphanumeric
      AU: {
        pattern: /^[A-Z0-9]{9,13}$/,
        description: 'Australian PR evidence number: 9-13 alphanumeric characters',
        country: 'AU'
      },
      // UK Indefinite Leave to Remain (ILR) - uses BRP number
      GB: {
        pattern: /^[A-Z0-9]{9}$/,
        description: 'UK ILR/BRP: 9 alphanumeric characters',
        country: 'GB'
      }
    };

    // Generic PR card pattern
    const genericPattern = /^[A-Z0-9]{6,15}$/;

    // Try country-specific validation
    if (country && prCardPatterns[country.toUpperCase()]) {
      const pattern = prCardPatterns[country.toUpperCase()];
      if (!pattern.pattern.test(number)) {
        errors.push(`Invalid ${country} Permanent Resident Card format. Expected: ${pattern.description}`);
      }
      return { isValid: errors.length === 0, country: country.toUpperCase(), errors, warnings };
    }

    // Try to auto-detect country from format
    for (const [countryCode, pattern] of Object.entries(prCardPatterns)) {
      if (pattern.pattern.test(number)) {
        warnings.push(`Detected as ${countryCode} Permanent Resident Card format`);
        return { isValid: true, country: countryCode, errors, warnings };
      }
    }

    // Fall back to generic validation
    if (!genericPattern.test(number)) {
      errors.push('Invalid Permanent Resident Card number format. Must be 6-15 alphanumeric characters');
    }

    return { isValid: errors.length === 0, country, errors, warnings };
  }

  /**
   * Generic document number validation
   */
  private validateGenericDocumentNumber(
    number: string
  ): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Generic pattern: alphanumeric, 5-20 characters
    const genericPattern = /^[A-Z0-9]{5,20}$/;

    if (!genericPattern.test(number)) {
      errors.push('Invalid document number format. Must be 5-20 alphanumeric characters');
    }

    // Check for suspicious patterns
    if (/^(.)\1+$/.test(number)) {
      errors.push('Document number appears to contain repeated characters');
    }

    if (/^(012345|123456|234567|ABCDEF|QWERTY)/i.test(number)) {
      errors.push('Document number appears to be a sequential or keyboard pattern');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate document number with checksum (for supported formats)
   * This can be expanded for specific document types that have check digits
   */
  validateWithChecksum(documentNumber: string, documentType: DocumentType): boolean {
    switch (documentType) {
      case 'PASSPORT':
        // Try Canadian passport MRZ checksum
        return this.validateCanadianPassportChecksum(documentNumber);
      case 'NATIONAL_ID':
        // Luhn algorithm for SSN/SIN could be added here
        return true;
      default:
        return true;
    }
  }

  /**
   * Validate Canadian passport number with MRZ checksum
   * Canadian passport format: 2 letters + 6 digits (e.g., AB123456)
   * MRZ format: passport number (8 chars) + check digit (1 char) = 9 chars total
   *
   * @param passportNumber - The passport number (with or without check digit)
   * @returns true if valid or cannot be validated, false if checksum fails
   */
  validateCanadianPassportChecksum(passportNumber: string): boolean {
    const normalized = passportNumber.toUpperCase().replace(/[\s\-]/g, '');

    // Canadian passport format: 2 letters + 6 digits = 8 characters
    // With check digit: 9 characters
    if (normalized.length === 8) {
      // Just the passport number, no check digit to validate
      // Validate format only
      return /^[A-Z]{2}[0-9]{6}$/.test(normalized);
    }

    if (normalized.length === 9) {
      // Has check digit - validate it
      const passportPart = normalized.substring(0, 8);
      const providedCheckDigit = normalized.charAt(8);

      // Validate format
      if (!/^[A-Z]{2}[0-9]{6}$/.test(passportPart)) {
        return false;
      }

      // Calculate expected check digit
      const calculatedCheckDigit = this.calculateMRZCheckDigit(passportPart);

      if (providedCheckDigit !== calculatedCheckDigit.toString()) {
        console.log(`[DocumentIdValidator] Canadian passport checksum failed: expected ${calculatedCheckDigit}, got ${providedCheckDigit}`);
        return false;
      }

      console.log(`[DocumentIdValidator] Canadian passport checksum validated successfully`);
      return true;
    }

    // Not a Canadian passport format
    return true;
  }

  /**
   * Calculate MRZ check digit using ICAO 9303 standard
   * Algorithm:
   * 1. Convert each character to numeric value (0-9 = 0-9, A-Z = 10-35, < = 0)
   * 2. Apply weights in pattern: 7, 3, 1, 7, 3, 1, ...
   * 3. Multiply each value by its weight
   * 4. Sum all products
   * 5. Check digit = sum mod 10
   */
  calculateMRZCheckDigit(data: string): number {
    const weights = [7, 3, 1];
    let sum = 0;

    for (let i = 0; i < data.length; i++) {
      const char = data.charAt(i).toUpperCase();
      const value = this.getMRZCharValue(char);
      const weight = weights[i % 3];
      sum += value * weight;
    }

    return sum % 10;
  }

  /**
   * Get MRZ numeric value for a character
   * ICAO 9303 standard:
   * - Digits 0-9: value is the digit
   * - Letters A-Z: A=10, B=11, ..., Z=35
   * - '<' (filler): 0
   */
  private getMRZCharValue(char: string): number {
    if (char >= '0' && char <= '9') {
      return parseInt(char, 10);
    }
    if (char >= 'A' && char <= 'Z') {
      return char.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
    }
    if (char === '<') {
      return 0;
    }
    // Unknown character, treat as 0
    return 0;
  }

  /**
   * Generate MRZ check digit for a passport number
   * Useful for validating or generating check digits
   */
  generatePassportCheckDigit(passportNumber: string, country: string = 'CA'): string {
    const normalized = passportNumber.toUpperCase().replace(/[\s\-]/g, '');

    if (country === 'CA') {
      // Canadian passport: 2 letters + 6 digits
      if (!/^[A-Z]{2}[0-9]{6}$/.test(normalized)) {
        throw new Error('Invalid Canadian passport number format');
      }
    }

    const checkDigit = this.calculateMRZCheckDigit(normalized);
    return checkDigit.toString();
  }

  /**
   * Validate full MRZ line (for future expansion)
   * Can validate entire MRZ lines from passport scans
   */
  validateMRZLine(mrzLine: string): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Remove any whitespace
    const line = mrzLine.replace(/\s/g, '');

    // MRZ line 2 for passport is 44 characters
    // Format: P<COUNTRY<SURNAME<<GIVENNAMES<<<<<<<<<<<<<<<<<<
    // Or line 2: PASSPORT#<CHECK<NATIONALITY<DOB<CHECK<SEX<EXPIRY<CHECK<<<<<<<<CHECK

    if (line.length !== 44) {
      errors.push(`Invalid MRZ line length: expected 44, got ${line.length}`);
    }

    // Basic character validation
    if (!/^[A-Z0-9<]+$/.test(line)) {
      errors.push('MRZ contains invalid characters');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Extract the first letter of the last name from person data
   * Handles both separate firstName/lastName and fullName formats
   */
  private getLastNameInitial(personData: ExtractedPersonData): string | null {
    // If lastName is directly available
    if (personData.lastName && personData.lastName.trim().length > 0) {
      return personData.lastName.trim().charAt(0).toUpperCase();
    }

    // Try to extract from fullName (assume format: "FirstName LastName" or "LastName, FirstName")
    if (personData.fullName && personData.fullName.trim().length > 0) {
      const fullName = personData.fullName.trim();

      // Check for "LastName, FirstName" format
      if (fullName.includes(',')) {
        const lastName = fullName.split(',')[0].trim();
        if (lastName.length > 0) {
          return lastName.charAt(0).toUpperCase();
        }
      }

      // Assume "FirstName LastName" or "FirstName MiddleName LastName" format
      const nameParts = fullName.split(/\s+/).filter(part => part.length > 0);
      if (nameParts.length >= 2) {
        // Last part is the last name
        const lastName = nameParts[nameParts.length - 1];
        return lastName.charAt(0).toUpperCase();
      }
    }

    return null;
  }
}

// Export singleton instance
export const documentIdValidator = new DocumentIdValidatorService();
