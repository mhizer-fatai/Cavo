const express = require("express");
const { supabase, memStore } = require("../supabase");
const { requireCavoSession } = require("../services/sessions");
const { schemas, validateBody } = require("../middleware/validate");

const router = express.Router();

const RESERVED_USERNAMES = [
  "dashboard", "pay", "home", "api", "login", "logout", "signup",
  "register", "settings", "profile", "user", "auth", "app", "dev",
  "test", "admin", "administrator", "support", "help", "cavo",
  "system", "root", "staff", "moderator", "billing", "security",
  "official", "team", "contact", "usdc", "eurc", "circle", "arc",
  "network", "wallet", "contract", "token", "checkout", "invoice",
  "payment", "withdraw"
];

function isValidOwnerKey(value) {
  return /^(0x[a-fA-F0-9]{40}|eoa:0x[a-fA-F0-9]{40}|google:[a-z0-9._:@-]{3,200}|email:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(:dev[0-9]+)?$/.test(value);
}

function isEoaAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function ownerEmail(value) {
  return String(value || "").match(/^email:([^:]+@[^:]+)(?::dev[0-9]+)?$/)?.[1] || null;
}

async function findCircleWalletForOwner(ownerAddress) {
  const exact = await supabase
    .from("user_wallets")
    .select("wallet_address")
    .eq("user_address", ownerAddress)
    .maybeSingle();
  if (exact.error) throw exact.error;
  if (exact.data?.wallet_address) return exact.data;

  const email = ownerEmail(ownerAddress);
  if (!email) return null;

  const accounts = await supabase
    .from("accounts")
    .select("id")
    .eq("email", email)
    .limit(10);
  if (accounts.error) return null;

  const accountIds = (accounts.data || []).map(account => account.id).filter(Boolean);
  if (!accountIds.length) return null;

  const linked = await supabase
    .from("user_wallets")
    .select("wallet_address")
    .in("account_id", accountIds)
    .limit(1)
    .maybeSingle();
  if (linked.error) throw linked.error;
  return linked.data;
}

// ─── Verify Supabase connection on startup ────────────────────────────────────
let useSupabase = false;
let hasOwnerAddress = false;
async function refreshProfileSchema() {
  if (!supabase) return;
  const { error } = await supabase.from("profiles").select("owner_address").limit(1);
  hasOwnerAddress = !error;
}

(async () => {
  if (!supabase) {
    console.log("⚠️  Profiles: No Supabase client — using memStore (data WILL be lost on restart).");
    return;
  }
  try {
    const { error } = await supabase.from("profiles").select("username").limit(1);
    if (error) {
      console.error("❌ Profiles: Supabase query failed:", error.message);
      console.log("⚠️  Profiles: Falling back to memStore.");
    } else {
      useSupabase = true;
      await refreshProfileSchema();
      console.log("✅ Profiles: Connected to Supabase — usernames will persist permanently.");
      if (!hasOwnerAddress) {
        console.log("⚠️  Profiles: owner_address column not found. Run the Circle-wallet profile migration.");
      }
    }
  } catch (e) {
    console.error("❌ Profiles: Supabase connection error:", e.message);
    console.log("⚠️  Profiles: Falling back to memStore.");
  }
})();

// ─── POST /api/profiles — Claim a username ────────────────────────────────────
function isValidAvatarUrl(value) {
  if (value === null || value === "") return true;
  if (typeof value !== "string") return false;
  if (value.length > 350_000) return false;
  return /^data:image\/(png|jpe?g|webp);base64,[a-zA-Z0-9+/=]+$/.test(value);
}

router.post("/", requireCavoSession, validateBody(schemas.profileCreate), async (req, res) => {
  try {
    let { username, walletAddress } = req.body;

    if (!username || !walletAddress) {
      return res.status(400).json({ error: "Username and walletAddress are required" });
    }

    username = username.toLowerCase().trim();
    walletAddress = walletAddress.toLowerCase().trim();

    // ─── Wallet address format check ──────────────────────────────────────────
    if (!isValidOwnerKey(walletAddress)) {
      return res.status(400).json({ error: "Invalid Cavo account identity format" });
    }


    if (!/^[a-z0-9_]+$/.test(username) || username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: "Username must be 3–20 characters, letters/numbers/underscores only" });
    }

    if (RESERVED_USERNAMES.includes(username)) {
      return res.status(400).json({ error: "This username is reserved and cannot be claimed" });
    }

    const ownerAddress = walletAddress;
    if (req.authUserKey !== ownerAddress) {
      return res.status(403).json({ error: "Cavo session does not match this account" });
    }
    let cavoWalletAddress = walletAddress;

    if (useSupabase) {
      await refreshProfileSchema();

      const circleWallet = await findCircleWalletForOwner(ownerAddress);

      if (circleWallet?.wallet_address) {
        cavoWalletAddress = circleWallet.wallet_address.toLowerCase();
      }
    }

    const createdAt = new Date().toISOString();
    const record = hasOwnerAddress
      ? { username, owner_address: ownerAddress, wallet_address: cavoWalletAddress, created_at: createdAt }
      : { username, wallet_address: cavoWalletAddress, created_at: createdAt };

    if (useSupabase) {
      // Check if this wallet already has a username
      const existingWalletQuery = supabase
        .from("profiles")
        .select("*")
        .maybeSingle();
      const { data: existingWallet, error: walletErr } = hasOwnerAddress
        ? await existingWalletQuery.eq("owner_address", ownerAddress)
        : await existingWalletQuery.eq("wallet_address", ownerAddress);

      if (walletErr) throw walletErr;

      if (existingWallet) {
        // Wallet already has a username — return it instead of erroring
        return res.status(200).json(existingWallet);
      }

      // Check if username is taken
      const { data: existingUsername, error: usernameErr } = await supabase
        .from("profiles")
        .select("username")
        .eq("username", username)
        .maybeSingle();

      if (usernameErr) throw usernameErr;

      if (existingUsername) {
        return res.status(400).json({ error: "Username is already taken" });
      }

      // Insert the new profile
      const { data, error: insertErr } = await supabase
        .from("profiles")
        .insert(record)
        .select()
        .single();

      if (insertErr) throw insertErr;

      return res.status(201).json(data);
    } else {
      // --- memStore fallback (dev only) ---
      for (const prof of memStore.profiles.values()) {
        if (prof.owner_address === ownerAddress || prof.wallet_address === ownerAddress) {
          return res.status(200).json(prof); // Return existing profile
        }
      }
      if (memStore.profiles.has(username)) {
        return res.status(400).json({ error: "Username is already taken" });
      }
      memStore.profiles.set(username, record);
      return res.status(201).json(record);
    }
  } catch (err) {
    console.error("Error claiming profile:", err);
    return res.status(500).json({
      error: "Failed to claim username. Please try again.",
      details: process.env.NODE_ENV !== "production" ? (err.message || err.details || String(err)) : undefined,
    });
  }
});

// ─── GET /api/profiles/wallet/:walletAddress — Lookup by wallet ───────────────
// IMPORTANT: This route must be defined BEFORE /:username to avoid routing conflicts
router.patch("/:username/avatar", requireCavoSession, validateBody(schemas.profileAvatar), async (req, res) => {
  try {
    const username = req.params.username.toLowerCase().trim();
    const avatarUrl = req.body?.avatarUrl ?? req.body?.avatar_url ?? null;

    if (!isValidAvatarUrl(avatarUrl)) {
      return res.status(400).json({ error: "Avatar must be a PNG, JPEG, or WebP image under 350 KB" });
    }

    if (useSupabase) {
      await refreshProfileSchema();

      const { data: existingProfile, error: lookupErr } = await supabase
        .from("profiles")
        .select("*")
        .eq("username", username)
        .maybeSingle();

      if (lookupErr) throw lookupErr;
      if (!existingProfile) return res.status(404).json({ error: "Profile not found" });
      if (existingProfile.owner_address !== req.authUserKey) {
        return res.status(403).json({ error: "Cavo session does not own this profile" });
      }

      const { data, error } = await supabase
        .from("profiles")
        .update({ avatar_url: avatarUrl || null })
        .eq("username", username)
        .select()
        .single();

      if (error) throw error;
      return res.json(data);
    }

    const record = memStore.profiles.get(username);
    if (!record) return res.status(404).json({ error: "Profile not found" });
    if (record.owner_address !== req.authUserKey) {
      return res.status(403).json({ error: "Cavo session does not own this profile" });
    }
    const nextRecord = { ...record, avatar_url: avatarUrl || null };
    memStore.profiles.set(username, nextRecord);
    return res.json(nextRecord);
  } catch (err) {
    console.error("Error updating profile avatar:", err);
    return res.status(500).json({ error: "Failed to update profile avatar" });
  }
});

router.get("/wallet/:walletAddress", async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress.toLowerCase().trim();

    if (useSupabase) {
      await refreshProfileSchema();
      let data;
      let error;

      if (hasOwnerAddress) {
        const result = isEoaAddress(walletAddress)
          ? await supabase
              .from("profiles")
              .select("*")
              .or(`owner_address.eq.${walletAddress},wallet_address.eq.${walletAddress}`)
              .maybeSingle()
          : await supabase
              .from("profiles")
              .select("*")
              .eq("owner_address", walletAddress)
              .maybeSingle();
        data = result.data;
        error = result.error;
      } else {
        const result = await supabase
          .from("profiles")
          .select("*")
          .eq("wallet_address", walletAddress)
          .maybeSingle();
        data = result.data;
        error = result.error;
      }

      if (error) throw error;
      if (!data) return res.json(null);

      return res.json(data);
    } else {
      const record = Array.from(memStore.profiles.values()).find(
        (p) => p.wallet_address === walletAddress
      );
      if (!record) return res.json(null);
      return res.json(record);
    }
  } catch (err) {
    console.error("Error fetching profile by wallet:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ─── GET /api/profiles/:username — Lookup by username ────────────────────────
router.get("/:username", async (req, res) => {
  try {
    const username = req.params.username.toLowerCase().trim();

    if (useSupabase) {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("username", username)
        .single();

      if (error || !data) return res.status(404).json({ error: "Profile not found" });

      return res.json(data);
    } else {
      const record = memStore.profiles.get(username);
      if (!record) return res.status(404).json({ error: "Profile not found" });
      return res.json(record);
    }
  } catch (err) {
    console.error("Error fetching profile:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

module.exports = router;
