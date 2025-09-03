import { Request, Response, NextFunction } from 'express';
import errorHandler from './errorHandler.js';

const middleware = (schema: any, property: string = 'body') => (req: Request, res: Response, next: NextFunction): void => {
  try {
    const result = schema.validate(req[property as keyof Request], { abortEarly: false });

    if (result.error) {
      const { details } = result.error;
      const message = details.map((i: any) => ({ message: i.message.replace(/['"]/g, "'"), field: i?.context?.label || i?.context?.key }));
      (res as any).sendError(422, message);
    } else {
      next();
    }
  } catch (error) {
    (res as any).sendError(500, error);
  }
};

export default middleware;