import "dotenv/config";
import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";

// Error Handler
import errorHandler from "./middlewares/errorHandler.js";

// Response Handler
import responseHandler from "./middlewares/responseHandler.js";

// Routes
import sessionRoutes from "./routes/session.js";
import messageRoutes from "./routes/message.js";
import businessRoutes from "./routes/business.js";
import authRoutes from "./routes/auth.js";

// Services
import ingestion from "./services/ingestion.js";
import Store from "./services/sqliteStore.js";
import waManager from "./services/waManager.js";

// Logger
import { logger } from "./utils/logger.js";

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
  origin: "*",
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-access-token"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/session", sessionRoutes);
app.use("/api/message", messageRoutes);
app.use("/api/business", businessRoutes);

// Health/Readiness and Metrics
app.get("/health", async (req: Request, res: Response): Promise<void> => {
  const db = await Store.ping();
  const snapshot = ingestion.getMetricsSnapshot();
  res.status(db ? 200 : 503).json({
    ok: db,
    db,
    queueDepth: snapshot.queueDepth,
    counters: snapshot.counters,
  });
});

app.get("/ready", async (req: Request, res: Response): Promise<void> => {
  const db = await Store.ping();
  const snapshot = ingestion.getMetricsSnapshot();
  const cap = Number(process.env.INGEST_QUEUE_CAPACITY || 5000);
  const threshold = Number(
    process.env.INGEST_READY_MAX_QUEUE_DEPTH || Math.floor(cap * 0.9),
  );
  const backlogOk = snapshot.queueDepth < threshold;
  const ready = db && backlogOk;
  res.status(ready ? 200 : 503).json({
    ready,
    db,
    backlogOk,
    queueDepth: snapshot.queueDepth,
    threshold,
  });
});

app.get("/metrics", (req: Request, res: Response): void => {
  res.json(ingestion.getMetricsSnapshot());
});

// 404
// app.use((req, res) => { res.status(404).send(null); });

const HOST = process.env.HOST || "localhost";
const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, HOST, async () => {
  logger.info(`Server running at http://${HOST}:${PORT}/`);

  // Start ingestion service
  try {
    await ingestion.start();
    logger.info("Ingestion service started");
  } catch (e: any) {
    logger.error({
      msg: "Failed to start ingestion service",
      error: e?.message || e,
    });
  }

  // Auto-connect to all available sessions on startup
  try {
    await waManager.autoConnectAll();
    logger.info("Auto-connect routine completed");
  } catch (e: any) {
    logger.error({
      msg: "Auto-connect routine failed",
      error: e?.message || e,
    });
  }
});

export default app;
