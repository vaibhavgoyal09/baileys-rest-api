import { Response } from 'express';

declare global {
  namespace Express {
    interface Response {
      sendError: (statusCode: number, data?: any) => void;
      sendResponse: (statusCode: number, data?: any) => void;
    }
  }
}