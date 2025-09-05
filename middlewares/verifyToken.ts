import { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../utils/jwt.js';

const verifyToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Accept Authorization: Bearer <jwt> or x-access-token: <jwt>
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const token = bearer || (typeof req.headers['x-access-token'] === 'string' ? String(req.headers['x-access-token']) : undefined);

    console.log(token);

    if (!token) {
      (res as any).sendError(401, 'Unauthorized: token missing');
      return;
    }

    const payload = verifyJwt(token);
    (req as any).user = { userId: payload.userId };
    next();
  } catch (e: any) {
    (res as any).sendError(401, 'Unauthorized: invalid token');
  }
};

export default verifyToken;