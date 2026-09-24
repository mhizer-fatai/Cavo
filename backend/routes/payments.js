const express = require("express");
const { supabase, memStore } = require("../supabase");
const { v4: uuidv4 } = require("uuid");
const { isValidAddressForChain, normalizeAccountAddress } = require("../services/arc");
const { requireCavoSession, ownsWalletAddress } = require("../services/sessions");
const { recordAuditEvent, getClientIp } = require("../services/audit");
const { schemas, validateBody } = require("../middleware/validate");

const router = express.Router();

const CHAIN_RPC = {
  Arc_Testnet: "https://rpc.testnet.arc.network",
  Ethereum_Sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  Base_Sepolia: "https://base-sepolia-rpc.publicnode.com",
  Arbitrum_Sepolia: "https://arbitrum-sepolia-rpc.publicnode.com",
  Optimism_Sepolia: "https://optimism-sepolia-rpc.publicnode.com",
  Polygon_Amoy_Testnet: "https://polygon-amoy-bor-rpc.publicnode.com",
};

// ─── POST /api/payments ───────────────────────────────────────────────────────
// Log a confirmed on-chain payment (authenticated: callers prove their session)
router.post("/", requireCavoSession, validateBody(schemas.paymentLog), async (req, res) => {
  try {
    const { linkId, payerAddress, recipientAddress, sourceChain, destinationChain, txHash, amount, token } = req.body;
    const normalizedSourceChain = sourceChain || "Arc_Testnet";
    const rpcUrl = CHAIN_RPC[normalizedSourceChain];

    if (!payerAddress || !txHash) {
      return res.status(400).json({
        error: "payerAddress and txHash are required",
      });
    }

    // ─── Wallet address format check (chain-aware: Solana is base58) ──────────
    if (!/^0x[a-fA-F0-9]{40}$/i.test(payerAddress)) {
      return res.status(400).json({ error: "Invalid wallet address format" });
    }

    // The payer must be the caller's own wallet (anti-forgery attribution).
    if (!(await ownsWalletAddress(req.authUserKey, payerAddress))) {
      return res.status(403).json({ error: "Payer wallet does not belong to this Cavo account" });
    }
    const destChain = destinationChain || "Arc_Testnet";
    if (recipientAddress && !isValidAddressForChain(destChain, recipientAddress)) {
      return res.status(400).json({ error: "Invalid recipient wallet address format" });
    }

    // ─── tx_hash validation: format check ───────────────────────────────────────
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return res.status(400).json({ error: "Invalid transaction hash format" });
    }
    if (!rpcUrl) {
      return res.status(400).json({ error: "Unsupported source chain" });
    }

    // ─── tx_hash validation: on-chain verification ────────────────────────────
    // Ask the source blockchain directly: does this transaction actually exist?
    try {
      const rpcRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionReceipt",
          params: [txHash],
          id: 1,
        }),
      });
      const rpcData = await rpcRes.json();

      if (!rpcData.result) {
        return res.status(400).json({ error: "Transaction not found on the blockchain" });
      }

      // Check transaction was actually successful (status 0x1 = success)
      if (rpcData.result.status !== "0x1") {
        return res.status(400).json({ error: "Transaction failed on-chain" });
      }

      // The logged payer must actually be the transaction's sender.
      if (String(rpcData.result.from || "").toLowerCase() !== payerAddress.toLowerCase()) {
        return res.status(400).json({ error: "Transaction sender does not match the payer address" });
      }
    } catch (rpcErr) {
      console.error("RPC verification error:", rpcErr.message);
      // If the RPC is down, reject the payment to be safe
      return res.status(503).json({ error: "Unable to verify transaction on-chain. Please try again." });
    }

    const record = {
      id: uuidv4(),
      link_id: linkId || null,
      payer_address: payerAddress.toLowerCase(),
      recipient_address: recipientAddress ? normalizeAccountAddress(destChain, recipientAddress) : null,
      source_chain: normalizedSourceChain,
      destination_chain: destinationChain || "Arc_Testnet",
      tx_hash: txHash,
      amount: amount ? parseFloat(amount) : null,
      token: token || "USDC",
      created_at: new Date().toISOString(),
    };

    if (supabase) {
      const { data: dupe } = await supabase.from("payments").select("id").eq("tx_hash", txHash).maybeSingle();
      if (dupe) return res.status(409).json({ error: "This transaction has already been logged" });
      const { error } = await supabase.from("payments").insert(record);
      if (error) throw error;
    } else {
      if (memStore.payments.some(p => p.tx_hash === txHash)) {
        return res.status(409).json({ error: "This transaction has already been logged" });
      }
      memStore.payments.push(record);
    }

    recordAuditEvent({
      userKey: req.authUserKey || null,
      action: "payment.log",
      outcome: "ok",
      ip: getClientIp(req),
      userAgent: req.get("User-Agent"),
      detail: { txHash, amount: amount ? String(amount).slice(0, 32) : null, token: token || "USDC" },
    });

    return res.status(201).json(record);
  } catch (err) {
    console.error("Error logging payment:", err);
    return res.status(500).json({ error: "Failed to log payment" });
  }
});

// ─── GET /api/payments/creator/:address ───────────────────────────────────────
// Financial history: the address must belong to the caller (M1).
router.get("/creator/:address", requireCavoSession, async (req, res) => {
  try {
    if (!(await ownsWalletAddress(req.authUserKey, req.params.address))) {
      return res.status(403).json({ error: "History does not belong to this Cavo account" });
    }
    const address = req.params.address.toLowerCase();

    let records;
    if (supabase) {
      const linkResult = await supabase
        .from("payments")
        .select(`
          *,
          payment_links!inner(creator_address, note, token)
        `)
        .eq("payment_links.creator_address", address)
        .order("created_at", { ascending: false });
      if (linkResult.error) throw linkResult.error;

      const directResult = await supabase
        .from("payments")
        .select("*")
        .eq("recipient_address", address)
        .order("created_at", { ascending: false });
      if (directResult.error) throw directResult.error;

      records = [...(linkResult.data || []), ...(directResult.data || [])]
        .filter((payment, index, all) => all.findIndex(row => row.tx_hash === payment.tx_hash) === index)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else {
      // In-memory: cross-reference
      const creatorLinkIds = Array.from(memStore.links.values())
        .filter((l) => l.creator_address === address)
        .map((l) => l.id);
      records = memStore.payments.filter((p) =>
        creatorLinkIds.includes(p.link_id) || p.recipient_address === address
      );
    }

    return res.json(records);
  } catch (err) {
    console.error("Error fetching creator payments:", err);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }
});

// ─── GET /api/payments/payer/:address ─────────────────────────────────────────
// Financial history: the address must belong to the caller (M1).
router.get("/payer/:address", requireCavoSession, async (req, res) => {
  try {
    if (!(await ownsWalletAddress(req.authUserKey, req.params.address))) {
      return res.status(403).json({ error: "History does not belong to this Cavo account" });
    }
    const address = req.params.address.toLowerCase();

    let records;
    if (supabase) {
      const { data, error } = await supabase
        .from("payments")
        .select(`
          *,
          payment_links(creator_address, note, token)
        `)
        .eq("payer_address", address)
        .order("created_at", { ascending: false });
      if (error) throw error;
      records = data || [];
    } else {
      records = memStore.payments.filter((p) => p.payer_address === address);
    }

    return res.json(records);
  } catch (err) {
    console.error("Error fetching payer payments:", err);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }
});

// ─── GET /api/payments/link/:linkId ───────────────────────────────────────────
// Fetch payments for a specific link
router.get("/link/:linkId", async (req, res) => {
  try {
    const { linkId } = req.params;

    let records;
    if (supabase) {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("link_id", linkId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      records = data || [];
    } else {
      records = memStore.payments.filter((p) => p.link_id === linkId);
    }

    return res.json(records);
  } catch (err) {
    console.error("Error fetching link payments:", err);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }
});

module.exports = router;
