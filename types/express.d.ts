import { Response, Request } from "express";

declare global {
  namespace Express {
    interface Response {
      sendError: (statusCode: number, data?: any) => void;
      sendResponse: (statusCode: number, data?: any) => void;
    }
    interface UserPayload {
      userId: string;
    }
    interface Request {
      user?: UserPayload;
    }
  }
}
