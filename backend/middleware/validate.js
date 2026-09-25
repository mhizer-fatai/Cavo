// Request validation + transformation. Every mutating route (and the public
// read proxies) runs its body/query through a zod schema BEFORE the handler.
// Schemas enforce shape and type; handlers keep business rules (ownership,
// allowlists, on-chain checks). Unknown fields are stripped by default.
const { z } = require("zod");

// ---- shared atoms ----

// Accepts JSON strings or numbers, always yields a trimmed string.
const str = z.union([z.string(), z.number()]).transform((v) => String(v).trim());

// Strict token amount: digits with up to 6 decimals, in range, no trailing
// garbage (parseFloat("10abc") === 10 is exactly what this prevents).
const amount = str.pipe(
  z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Invalid amount")
    .refine(
      (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 && n <= 1_000_000_000;
      },
      "Amount out of range"
    )
);

const email = z.string().trim().toLowerCase().email("Valid email is required").max(254);
const otpCode = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");
const pin = z.string().trim().regex(/^\d{4}$/, "PIN must be 4 digits");
const evmAddress = z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/i, "Invalid address format");
// Chain-exact address check stays in the route (Solana is base58, EVM is 0x).
const anyAddress = z.string().trim().min(26).max(64);
const token = z.enum(["USDC", "EURC", "usdc", "eurc"]).transform((v) => v.toUpperCase());
const uuid = z.string().trim().uuid("Invalid id format");
const txHash = z.string().trim().regex(/^0x[a-fA-F0-9]{64}$/i, "Invalid transaction hash format");
const chainName = z.string().trim().min(1).max(64);
const username = z.string().trim().toLowerCase().min(3).max(20);
const ownerKey = z.string().trim().min(1).max(128);
const note = z.string().trim().max(500).nullable().optional();
const displayName = z.string().trim().max(128).optional();
const answer = z.string().trim().min(1).max(200);

// Loose variant for machine amounts (vault shares in wei units can exceed
// token ranges and decimal places). Still strictly numeric — no trailing junk.
const looseAmount = str.pipe(
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Invalid amount")
    .refine(
      (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0;
      },
      "Amount out of range"
    )
);

const blankToUndefined = (v) => (v === "" ? undefined : v);

const optionalAmount = z.preprocess(blankToUndefined, amount.nullable().optional());

const schemas = {
  authRequestCode: z.object({ email }),
  authVerifyCode: z.object({ email, code: otpCode }),
  authSession: z.object({
    loginTicket: z.string().trim().min(1).max(4096).optional(),
    userToken: z.string().trim().min(1).max(8192).optional(),
    displayName,
  }),

  pinSetup: z.object({
    pin,
    recoveryAnswers: z.array(answer).max(2).optional(),
    recoveryAnswer: answer.optional(),
  }),
  pinChange: z.object({ currentPin: pin, newPin: pin }),
  pinRecoveryQuestion: z.object({
    pin,
    recoveryAnswers: z.array(answer).max(2).optional(),
    recoveryAnswer: answer.optional(),
  }),
  pinRecover: z.object({
    newPin: pin,
    recoveryAnswers: z.array(answer).max(2).optional(),
    recoveryAnswer: answer.optional(),
  }),
  pinApprove: z.object({
    pin,
    walletAddress: evmAddress,
    walletId: uuid,
    destinationAddress: anyAddress,
    destinationChain: chainName.optional(),
    bridgeTo: chainName.optional(),
    bridgeAddress: anyAddress.optional(),
    amount: looseAmount,
    token,
    tokenOut: token.optional(),
    transactionType: z.enum(["send", "swap", "earn", "SEND", "SWAP", "EARN"]).transform((v) => v.toLowerCase()).optional(),
  }),

  walletSend: z.object({
    walletAddress: evmAddress,
    walletId: uuid,
    destinationAddress: evmAddress,
    destinationChain: chainName.optional(),
    amount,
    token,
    approvalId: uuid,
  }),
  walletBridge: z.object({
    walletAddress: evmAddress,
    walletId: uuid,
    destinationAddress: anyAddress,
    destinationChain: chainName,
    amount,
    approvalId: uuid,
  }),

  earnDeposit: z.object({
    walletAddress: evmAddress,
    walletId: uuid,
    token,
    amount: amount.optional(),
    amountIn: amount.optional(),
    approvalId: uuid,
  }),
  earnWithdraw: z.object({
    walletAddress: evmAddress,
    walletId: uuid,
    token,
    shares: str.pipe(z.string().regex(/^\d+(\.\d+)?$/, "Invalid shares")),
    approvalId: uuid,
    destinationChain: chainName.optional(),
    destinationAddress: anyAddress.optional(),
  }),

  swapQuote: z.object({
    tokenIn: token,
    tokenOut: token,
    amountIn: amount,
    walletAddress: evmAddress.optional(),
  }),
  swapExecute: z.object({
    walletAddress: evmAddress,
    walletId: uuid,
    tokenIn: token,
    tokenOut: token,
    amountIn: amount,
    minOut: amount.optional(),
    approvalId: uuid,
  }),

  paymentLog: z.object({
    linkId: uuid.nullable().optional(),
    payerAddress: evmAddress,
    recipientAddress: anyAddress.nullable().optional(),
    sourceChain: chainName.optional(),
    destinationChain: chainName.optional(),
    txHash,
    amount: optionalAmount,
    token: token.optional(),
  }),

  linkCreate: z.object({
    creatorAddress: evmAddress,
    amount: optionalAmount,
    token,
    note,
  }),

  profileCreate: z.object({ username, walletAddress: ownerKey }),
  profileAvatar: z.object({
    avatarUrl: z.string().trim().max(350000).nullable().optional(),
    avatar_url: z.string().trim().max(350000).nullable().optional(),
  }),

  arcscanBalance: z.object({ address: evmAddress, contractaddress: evmAddress }),
  arcscanNative: z.object({ address: evmAddress }),
  arcscanTransfers: z.object({ address: evmAddress, contractaddress: evmAddress }),
};

function invalidResponse(res, issues) {
  return res.status(400).json({
    error: "Invalid request",
    details: issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
    })),
  });
}

// Parses + transforms, then REPLACES req.body / req.query with the clean
// output (unknown fields stripped). Must run after auth middlewares.
function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return invalidResponse(res, parsed.error.issues);
    req.body = parsed.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return invalidResponse(res, parsed.error.issues);
    req.query = parsed.data;
    next();
  };
}

module.exports = { schemas, validateBody, validateQuery };
