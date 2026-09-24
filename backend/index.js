const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const linksRouter = require("./routes/links");
const paymentsRouter = require("./routes/payments");
const profilesRouter = require("./routes/profiles");
const arcscanRouter = require("./routes/arcscan");
const pinsRouter = require("./routes/pins");
const authRouter = require("./routes/auth");
const swapRouter = require("./routes/swap");
const earnRouter = require("./routes/earn");
const { router: walletsRouter, setSupabase: setWalletSupabase } = require("./routes/wallets");
const { setSupabase: setPinSupabase } = require("./services/pins");
const { setSupabase: setSwapSupabase } = require("./services/swaps");
const { setSupabase: setEarnSupabase } = require("./services/earn");
const { setSupabase: setSessionSupabase, probeSessionTables } = require("./services/sessions");
const { setSupabase: setAuditSupabase } = require("./services/audit");
const { setSupabase: setIdempotencySupabase } = require("./middleware/idempotency");
const { requireCavoSession } = require("./services/sessions");
const { supabase } = require("./supabase");

const app = express();
const PORT = process.env.PORT || 3001;
const isDevelopment = process.env.NODE_ENV !== "production";

// Correct client IPs behind a single proxy (rate limiting + audit log).
app.set("trust proxy", 1);

// Security headers for every response (incl. X-Powered-By removal).
app.use(helmet());

// Core middleware shared by all API routes.
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  credentials: true,
}));
app.use(express.json({ limit: "256kb" }));

// General limiter for all API routes.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 10_000 : 1000,
  skip: (req) => req.path === "/health",
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in 15 minutes." },
});

// Stricter limiter for username claiming.
const claimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDevelopment ? 100 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many username claims from this IP. Try again in an hour." },
});

// Moderate limiter for payment link creation.
const linkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 300 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many links created. Please slow down." },
});

// Moderate limiter for swap quotes and executions.
const swapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many swap requests. Please slow down." },
});

// Moderate limiter for earn quotes, deposits and withdrawals.
const earnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many earn requests. Please slow down." },
});

// Strict limiter for authentication: OTP, session creation, refresh.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});

// Strict limiter for the Payment PIN (money-movement step-up factor).
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many PIN requests. Please try again in 15 minutes." },
});

// Moderate limiter for payment logging.
const paymentsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment requests. Please slow down." },
});

// Moderate limiter for profiles and wallets reads/writes.
const profilesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many profile requests. Please slow down." },
});

const walletsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 2000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many wallet requests. Please slow down." },
});

// Limiter for the public Arcscan/RPC read proxy (quota + IP-ban protection).
const arcscanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 2000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many explorer requests. Please slow down." },
});

// Limiter for the unauthenticated Circle balance proxy (abuse vector).
const proxyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many proxy requests. Please slow down." },
});

app.use("/api/", generalLimiter);
app.post("/api/profiles", claimLimiter);
app.use("/api/links", linkLimiter);

app.use("/api/links", linksRouter);
app.use("/api/swap", swapLimiter, swapRouter);
app.use("/api/earn", earnLimiter, earnRouter);
app.use("/api/payments", paymentsLimiter, paymentsRouter);
app.use("/api/profiles", profilesLimiter, profilesRouter);
app.use("/api/arcscan", arcscanLimiter, arcscanRouter);
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/cavo-pin", pinLimiter, pinsRouter);
app.use("/api/wallets", walletsLimiter, walletsRouter);

setWalletSupabase(supabase);
setPinSupabase(supabase);
setSwapSupabase(supabase);
setEarnSupabase(supabase);
setSessionSupabase(supabase);
setAuditSupabase(supabase);
setIdempotencySupabase(supabase);
probeSessionTables().catch((err) => console.warn("Session table probe failed:", err.message || err));

// Proxy Circle balance requests when browser CORS blocks direct calls.
// Authenticated: strangers must not spend our Circle quota (L3).
app.post("/api/proxy-balances", proxyLimiter, requireCavoSession, async (req, res) => {
  try {
    const response = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Failed to fetch from Circle API" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Cavo API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
