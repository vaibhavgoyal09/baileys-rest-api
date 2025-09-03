import { Request, Response, NextFunction } from 'express';

const { ACCESS_TOKEN_SECRET } = process.env;

const verifyToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!req.headers['x-access-token']) {
    (res as any).sendError(401, 'Unauthorized access: No token provided');
    return;
  }

  if (req.headers['x-access-token'] !== ACCESS_TOKEN_SECRET) {
    (res as any).sendError(401, 'Unauthorized access: Invalid token');
    return;
  }

  next();
};

export default verifyToken;