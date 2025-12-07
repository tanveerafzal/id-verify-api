import { config } from '../config';
import { logger } from '../utils/logger';

interface EmailOptions {
  to: string;
  subject: string;
  body: string;
}

export class EmailService {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  private async getAuthToken(): Promise<string> {
    // Check if we have a valid token
    if (this.token && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return this.token;
    }

    try {
      logger.info('[EmailService] Authenticating with Ultrareach360 API');

      const response = await fetch(`${config.ultrareach360.apiUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: config.ultrareach360.username,
          password: config.ultrareach360.password,
          apiKey: config.ultrareach360.apiKey
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('[EmailService] Authentication failed:', errorText);
        throw new Error(`Authentication failed: ${response.status}`);
      }

      const data = await response.json() as { token?: string; data?: { token?: string } };
      this.token = data.token || data.data?.token || null;

      if (!this.token) {
        throw new Error('No token received from authentication');
      }

      // Set token expiry to 1 hour from now
      this.tokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

      logger.info('[EmailService] Successfully authenticated');
      return this.token;
    } catch (error) {
      logger.error('[EmailService] Authentication error:', error);
      throw error;
    }
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      logger.info(`[EmailService] Sending email to ${options.to}`);

      const token = await this.getAuthToken();

      const response = await fetch(`${config.ultrareach360.apiUrl}/messaging/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          businessGroup: config.ultrareach360.businessGroup,
          to: options.to,
          subject: options.subject,
          body: options.body
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('[EmailService] Send email failed:', errorText);
        throw new Error(`Send email failed: ${response.status}`);
      }

      const data = await response.json();
      logger.info('[EmailService] Email sent successfully:', data);

      return true;
    } catch (error) {
      logger.error('[EmailService] Failed to send email:', error);
      throw error;
    }
  }

  async sendVerificationEmail(
    userEmail: string,
    userName: string,
    verificationLink: string
  ): Promise<boolean> {
    const subject = 'Identity Verification Required';
    const body = `
Hello ${userName},

You have been requested to complete an identity verification process.

Please click the link below to start your verification:

${verificationLink}

This verification is secure and will only take a few minutes to complete.

If you have any questions, please contact the organization that requested this verification.

Thank you!

---
This is an automated message from ID Verify - Identity Verification Platform
    `.trim();

    return this.sendEmail({
      to: userEmail,
      subject,
      body
    });
  }

  async sendPasswordResetEmail(
    email: string,
    name: string,
    resetLink: string
  ): Promise<boolean> {
    const subject = 'Password Reset Request - ID Verify';
    const body = `
Hello ${name},

We received a request to reset your password for your ID Verify partner account.

Click the link below to reset your password:

${resetLink}

This link will expire in 1 hour for security reasons.

If you did not request a password reset, please ignore this email or contact support if you have concerns about your account security.

Thank you!

---
This is an automated message from ID Verify - Identity Verification Platform
    `.trim();

    return this.sendEmail({
      to: email,
      subject,
      body
    });
  }

  async sendVerificationCompleteEmail(
    partnerEmail: string,
    partnerName: string,
    userName: string,
    userEmail: string,
    verificationResult: {
      passed: boolean;
      score: number;
      riskLevel: string;
      extractedData: {
        fullName?: string;
        dateOfBirth?: string;
        documentNumber?: string;
        expiryDate?: string;
        issuingCountry?: string;
      };
      flags: string[];
    }
  ): Promise<boolean> {
    const statusEmoji = verificationResult.passed ? '✅' : '❌';
    const statusText = verificationResult.passed ? 'PASSED' : 'FAILED';
    const scorePercent = Math.round(verificationResult.score * 100);

    const extractedDataSection = Object.keys(verificationResult.extractedData).length > 0 ? `

Extracted Information:
${verificationResult.extractedData.fullName ? `- Full Name: ${verificationResult.extractedData.fullName}` : ''}
${verificationResult.extractedData.dateOfBirth ? `- Date of Birth: ${verificationResult.extractedData.dateOfBirth}` : ''}
${verificationResult.extractedData.documentNumber ? `- Document Number: ${verificationResult.extractedData.documentNumber}` : ''}
${verificationResult.extractedData.expiryDate ? `- Expiry Date: ${verificationResult.extractedData.expiryDate}` : ''}
${verificationResult.extractedData.issuingCountry ? `- Issuing Country: ${verificationResult.extractedData.issuingCountry}` : ''}
    `.trim() : '';

    const flagsSection = verificationResult.flags.length > 0 ? `

Flags & Alerts:
${verificationResult.flags.map(flag => `- ${flag.replace(/_/g, ' ')}`).join('\n')}
    `.trim() : '';

    const subject = `Verification ${statusText} - ${userName}`;
    const body = `
Hello ${partnerName},

${userName} (${userEmail}) has completed the identity verification process.

Verification Result: ${statusEmoji} ${statusText}
Verification Score: ${scorePercent}%
Risk Level: ${verificationResult.riskLevel}
${extractedDataSection}
${flagsSection}

You can view the full verification details in your partner dashboard.

---
This is an automated message from ID Verify - Identity Verification Platform
    `.trim();

    return this.sendEmail({
      to: partnerEmail,
      subject,
      body
    });
  }
}
