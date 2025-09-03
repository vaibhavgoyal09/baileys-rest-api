import { Response } from 'express';
import { logger } from '../utils/logger.js';

const responseHandler = (res: Response, statusCode: number = 200, data: any = {}): void => {
  try {
    if (typeof data !== 'object') {
      data = { message: data };
    }

    if (typeof statusCode !== 'number') {
      statusCode = 500;
    }

    res.status(statusCode);
    res.json(data);
    res.end();

    logger.info({
      status: statusCode,
      data,
    });
  } catch (error) {
    logger.error(error);
    res.status(500);
    res.json({ message: 'Internal Server Error' });
    res.end();
  }
};

export default responseHandler;