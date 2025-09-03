import 'dotenv/config';
import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';

// Error Handler
import errorHandler from './middlewares/errorHandler.js';

// Response Handler
import responseHandler from './middlewares/responseHandler.js';

// Routes
import sessionRoutes from './routes/session.js';
import messageRoutes from './routes/message.js';

// Logger
import { logger } from './utils/logger.js';

const app: Application = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Error Handler
app.use((req: Request, res: Response, next: NextFunction) => {
  res.sendError = errorHandler.bind(null, req, res);
  next();
});

// Response Handler
app.use((req: Request, res: Response, next: NextFunction) => {
  res.sendResponse = responseHandler.bind(null, res);
  next();
});

// CORS
const corsOptions = {
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));

// Routes
app.use('/api/session', sessionRoutes);
app.use('/api/message', messageRoutes);

// 404
// app.use((req, res) => { res.status(404).send(null); });

const HOST = process.env.HOST || 'localhost';
const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, HOST, () => {
  logger.info(`Server running at http://${HOST}:${PORT}/`);
});

export default app;