import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  error: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (error instanceof AppError) {
    logger.error(`AppError: ${error.message}`, {
      statusCode: error.statusCode,
      path: req.path,
      method: req.method
    });

    return res.status(error.statusCode).json({
      success: false,
      error: error.message
    });
  }

  logger.error(`Unhandled error: ${error.message}`, {
    stack: error.stack,
    path: req.path,
    method: req.method
  });

  return res.status(500).json({
    success: false,
    error: 'An unexpected error occurred'
  });
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
