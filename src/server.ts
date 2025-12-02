import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.routes';
import verificationRoutes from './routes/verification.routes';
import partnerRoutes from './routes/partner.routes';
import { config } from './config';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/error-handler';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/v1', limiter);

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/partners', partnerRoutes);
app.use('/api/v1', verificationRoutes);

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.use(errorHandler);

const PORT = config.server.port;

app.listen(PORT, () => {
  logger.info(`ID Verification Server running on port ${PORT}`);
  logger.info(`Environment: ${config.server.nodeEnv}`);
});

export default app;
