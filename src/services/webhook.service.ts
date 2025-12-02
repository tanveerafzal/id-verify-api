import axios from 'axios';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { WebhookPayload } from '../types/verification.types';
import { config } from '../config';

const prisma = new PrismaClient();

export class WebhookService {
  private maxRetries = 3;
  private retryDelays = [1000, 5000, 15000];

  async sendWebhook(url: string, payload: WebhookPayload, verificationId?: string): Promise<void> {
    const webhookEvent = verificationId ? await prisma.webhookEvent.create({
      data: {
        verificationId: verificationId || payload.verificationId,
        eventType: payload.event,
        payload: payload as any,
        delivered: false,
        deliveryAttempts: 0
      }
    }) : null;

    const signature = this.generateSignature(payload);

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-Event': payload.event,
            'X-Webhook-ID': webhookEvent?.id || 'none'
          },
          timeout: 10000
        });

        if (webhookEvent) {
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: {
              delivered: true,
              deliveryAttempts: attempt + 1,
              lastAttemptAt: new Date(),
              deliveredAt: new Date(),
              responseStatus: response.status,
              responseBody: JSON.stringify(response.data)
            }
          });
        }

        return;
      } catch (error) {
        if (webhookEvent) {
          await prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: {
              deliveryAttempts: attempt + 1,
              lastAttemptAt: new Date(),
              responseStatus: axios.isAxiosError(error) ? error.response?.status : undefined,
              responseBody: axios.isAxiosError(error) ? JSON.stringify(error.response?.data) : String(error)
            }
          });
        }

        if (attempt < this.maxRetries - 1) {
          await this.delay(this.retryDelays[attempt]);
        } else {
          console.error(`Failed to deliver webhook after ${this.maxRetries} attempts:`, error);
        }
      }
    }
  }

  private generateSignature(payload: WebhookPayload): string {
    const payloadString = JSON.stringify(payload);
    return crypto
      .createHmac('sha256', config.security.webhookSecret)
      .update(payloadString)
      .digest('hex');
  }

  verifySignature(payload: string, signature: string): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', config.security.webhookSecret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retryFailedWebhooks(): Promise<void> {
    const failedWebhooks = await prisma.webhookEvent.findMany({
      where: {
        delivered: false,
        deliveryAttempts: {
          lt: this.maxRetries
        }
      },
      include: {
        verification: true
      }
    });

    for (const webhook of failedWebhooks) {
      if (webhook.verification.webhookUrl) {
        await this.sendWebhook(
          webhook.verification.webhookUrl,
          webhook.payload as unknown as WebhookPayload,
          webhook.verificationId
        );
      }
    }
  }
}
