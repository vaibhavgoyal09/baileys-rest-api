import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import errorHandler from './middlewares/errorHandler.js';
import responseHandler from './middlewares/responseHandler.js';
import sessionRoutes from './routes/session.js';
import messageRoutes from './routes/message.js';
import WhatsAppService from './services/baileys.js';
import { logger } from './utils/logger.js';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    res.sendError = errorHandler.bind(null, req, res);
    next();
});
app.use((req, res, next) => {
    res.sendResponse = responseHandler.bind(null, res);
    next();
});
const corsOptions = {
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.use('/api/session', sessionRoutes);
app.use('/api/message', messageRoutes);
const HOST = process.env.HOST || 'localhost';
const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, HOST, async () => {
    logger.info(`Server running at http://${HOST}:${PORT}/`);
    try {
        const isValid = await WhatsAppService.isSessionValid();
        if (isValid) {
            logger.info('Valid session found, attempting to auto-connect to WhatsApp...');
            const result = await WhatsAppService.initialize();
            if (result.success) {
                logger.info('WhatsApp auto-connection successful:', result.status);
            }
            else {
                logger.warn('WhatsApp auto-connection failed:', result.message);
            }
        }
        else {
            logger.info('No valid session found, skipping auto-connection. Use /api/session/start to create a new session.');
        }
    }
    catch (error) {
        logger.error('Error during WhatsApp auto-connection:', error);
    }
});
export default app;
//# sourceMappingURL=app.js.map