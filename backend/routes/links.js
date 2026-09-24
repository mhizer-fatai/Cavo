const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { supabase, memStore } = require("../supabase");
const { requireCavopaySession, ownsWalletAddress } = require("../services/sessions");
const { schemas, validateBody } = require("../middleware/validate");

const router = express.Router();

// ─── POST /api/links ─────────────────────────────────────────────────────────
// Create a new payment link
router.post("/", requireCavopaySession, validateBody(schemas.linkCreate), async (req, res) => {
  try {
    const { creatorAddress, amount, token, note } = req.body;

    if (!creatorAddress) {
      return res.status(400).json({ error: "creatorAddress is required" });
    }

    if (!/^0x[a-fA-F0-9]{40}$/i.test(creatorAddress)) {
      return res.status(400).json({ error: "Invalid wallet address format" });
    }

    if (supabase) {
      const { data: wallet, error: walletErr } = await supabase
        .from("user_wallets")
        .select("wallet_address")
        .eq("user_address", req.authUserKey)
        .eq("wallet_address", creatorAddress.toLowerCase())
        .eq("wallet_type", "developer_controlled")
        .maybeSingle();
      if (walletErr) throw walletErr;
      if (!wallet) return res.status(403).json({ error: "Cavopay session does not own this wallet" });
    }

    if (!["USDC", "EURC"].includes(token)) {
      return res.status(400).json({ error: "token must be USDC or EURC" });
    }

    // ─── Amount validation ────────────────────────────────────────────────────
    if (amount !== undefined && amount !== null && amount !== "") {
      const parsed = parseFloat(amount);
      if (isNaN(parsed) || parsed <= 0 || parsed > 1_000_000_000) {
        return res.status(400).json({ error: "Amount must be a positive number no greater than 1,000,000,000" });
      }
    }

    const createdAt = new Date();

    const expiresAt = new Date(createdAt.getTime() + 30 * 60000); // 30 mins

    const id = uuidv4();
    const record = {
      id,
      creator_address: creatorAddress.toLowerCase(),
      amount: amount ? parseFloat(amount) : null,
      token: token || "USDC",
      note: note || null,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    if (supabase) {
      const { error } = await supabase.from("payment_links").insert(record);
      if (error) throw error;
    } else {
      memStore.links.set(id, record);
    }

    const linkUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/pay/${id}`;
    return res.status(201).json({ id, linkUrl, ...record });
  } catch (err) {
    console.error("Error creating link:", err);
    return res.status(500).json({ error: "Failed to create payment link" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    let record;
    if (supabase) {
      // 1. Fetch the link
      const { data: linkData, error: linkErr } = await supabase
        .from("payment_links")
        .select("*")
        .eq("id", id)
        .single();

      if (linkErr || !linkData) {
        return res.status(404).json({ error: "Payment link not found" });
      }

      // 2. Check if expired
      if (new Date() > new Date(linkData.expires_at)) {
        await supabase.from("payment_links").delete().eq("id", id);
        return res.status(410).json({ error: "Payment link has expired" });
      }

      // 3. Check if already paid
      const { data: payData } = await supabase
        .from("payments")
        .select("tx_hash")
        .eq("link_id", id)
        .maybeSingle();

      record = {
        ...linkData,
        is_paid: !!payData,
        tx_hash: payData ? payData.tx_hash : null,
      };
    } else {
      record = memStore.links.get(id);
      if (!record) return res.status(404).json({ error: "Payment link not found" });

      if (new Date() > new Date(record.expires_at)) {
        memStore.links.delete(id);
        return res.status(410).json({ error: "Payment link has expired" });
      }

      const payment = memStore.payments.find(p => p.link_id === id);
      record = {
        ...record,
        is_paid: !!payment,
        tx_hash: payment ? payment.tx_hash : null,
      };
    }

    return res.json(record);
  } catch (err) {
    console.error("Error fetching link:", err);
    return res.status(500).json({ error: "Failed to fetch payment link" });
  }
});

// ─── GET /api/links/creator/:address ─────────────────────────────────────────
// The address must belong to the caller (M1).
router.get("/creator/:address", requireCavopaySession, async (req, res) => {
  try {
    if (!(await ownsWalletAddress(req.authUserKey, req.params.address))) {
      return res.status(403).json({ error: "Links do not belong to this Cavopay account" });
    }
    const address = req.params.address.toLowerCase();

    let records;
    if (supabase) {
      const { data, error } = await supabase
        .from("payment_links")
        .select("*")
        .eq("creator_address", address)
        .gt("expires_at", new Date().toISOString()) // Only non-expired links
        .order("created_at", { ascending: false });
      if (error) throw error;
      records = data || [];
    } else {
      records = Array.from(memStore.links.values()).filter(
        (l) => l.creator_address === address
      );
    }

    return res.json(records);
  } catch (err) {
    console.error("Error fetching creator links:", err);
    return res.status(500).json({ error: "Failed to fetch links" });
  }
});

module.exports = router;
