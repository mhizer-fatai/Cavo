const express = require("express");
const {
  changePin,
  createApproval,
  getPinStatus,
  recoverPin,
  setRecoveryQuestion,
  setupPin,
} = require("../services/pins");
const { requireMatchingUserKey, requireCavopaySession } = require("../services/sessions");
const { recordAuditEvent, getClientIp } = require("../services/audit");
const { schemas, validateBody } = require("../middleware/validate");

const router = express.Router();

router.get("/status", requireCavopaySession, requireMatchingUserKey, async (req, res) => {
  try {
    return res.json(await getPinStatus(req.authUserKey));
  } catch (err) {
    console.error("Cavopay PIN status error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to fetch PIN status" });
  }
});

router.post("/setup", requireCavopaySession, requireMatchingUserKey, validateBody(schemas.pinSetup), async (req, res) => {
  try {
    const { pin, recoveryAnswers, recoveryAnswer } = req.body;
    return res.status(201).json(await setupPin(req.authUserKey, pin, recoveryAnswers, recoveryAnswer));
  } catch (err) {
    console.error("Cavopay PIN setup error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to set Cavopay PIN" });
  }
});

router.post("/change", requireCavopaySession, requireMatchingUserKey, validateBody(schemas.pinChange), async (req, res) => {
  try {
    return res.json(await changePin({ ...req.body, userKey: req.authUserKey }));
  } catch (err) {
    console.error("Cavopay PIN change error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to change Cavopay PIN", code: err.code });
  }
});

router.post("/recovery-question", requireCavopaySession, requireMatchingUserKey, validateBody(schemas.pinRecoveryQuestion), async (req, res) => {
  try {
    return res.json(await setRecoveryQuestion({ ...req.body, userKey: req.authUserKey }));
  } catch (err) {
    console.error("Cavopay PIN recovery question error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to save security question", code: err.code });
  }
});

router.post("/recover", requireCavopaySession, requireMatchingUserKey, validateBody(schemas.pinRecover), async (req, res) => {
  try {
    return res.json(await recoverPin({ ...req.body, userKey: req.authUserKey }));
  } catch (err) {
    console.error("Cavopay PIN recovery error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to recover Cavopay PIN", code: err.code });
  }
});

router.post("/approve", requireCavopaySession, requireMatchingUserKey, validateBody(schemas.pinApprove), async (req, res) => {
  const auditBase = {
    userKey: req.authUserKey || null,
    ip: getClientIp(req),
    userAgent: req.get("User-Agent"),
  };
  try {
    const approval = await createApproval({ ...req.body, userKey: req.authUserKey });
    recordAuditEvent({
      ...auditBase,
      action: "pin.approve",
      outcome: "ok",
      detail: {
        amount: req.body?.amount !== undefined ? String(req.body.amount).slice(0, 32) : null,
        token: req.body?.token ? String(req.body.token).slice(0, 16) : null,
        destinationChain: req.body?.destinationChain ? String(req.body.destinationChain).slice(0, 64) : null,
      },
    });
    return res.json(approval);
  } catch (err) {
    recordAuditEvent({ ...auditBase, action: "pin.approve", outcome: "fail", detail: { reason: err.message } });
    console.error("Cavopay PIN approval error:", err.message || err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to approve transaction",
      code: err.code,
    });
  }
});

module.exports = router;
