import { pino } from 'pino';
const errorDest = pino.destination('./error.log');
const errorLogger = pino({}, errorDest);
const fileDest = pino.destination('./logs');
const fileLogger = pino({}, fileDest);
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            singleLine: true,
        },
    },
});
export { fileLogger, errorLogger, logger, };
//# sourceMappingURL=logger.js.map