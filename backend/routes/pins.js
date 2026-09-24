const express = require("express");
const {
  changePin,
  createApproval,
  getPinStatus,
  recoverPin,
  setRecoveryQuestion,
  setupPin,
} = require("../services/pins");
const { requireMatchingUserKey, requireCavoSession } = require("../services/sessions");
const { recordAuditEvent, getClientIp } = require("../services/audit");
const { schemas, validateBody } = require("../middleware/validate");

const router = express.Router();

router.get("/status", requireCavoSession, requireMatchingUserKey, async (req, res) => {
  try {
    return res.json(await getPinStatus(req.authUserKey));
  } catch (err) {
    console.error("Cavo PIN status error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to fetch PIN status" });
  }
});

router.post("/setup", requireCavoSession, requireMatchingUserKey, validateBody(schemas.pinSetup), async (req, res) => {
  try {
    const { pin, recoveryAnswers, recoveryAnswer } = req.body;
    return res.status(201).json(await setupPin(req.authUserKey, pin, recoveryAnswers, recoveryAnswer));
  } catch (err) {
    console.error("Cavo PIN setup error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to set Cavo PIN" });
  }
});

router.post("/change", requireCavoSession, requireMatchingUserKey, validateBody(schemas.pinChange), async (req, res) => {
  try {
    return res.json(await changePin({ ...req.body, userKey: req.authUserKey }));
  } catch (err) {
    console.error("Cavo PIN change error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to change Cavo PIN", code: err.code });
  }
});

router.post("/recovery-question", requireCavoSession, requireMatchingUserKey, validateBody(schemas.pinRecoveryQuestion), async (req, res) => {
  try {
    return res.json(await setRecoveryQuestion({ ...req.body, userKey: req.authUserKey }));
  } catch (err) {
    console.error("Cavo PIN recovery question error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to save security question", code: err.code });
  }
});

router.post("/recover", requireCavoSession, requireMatchingUserKey, validateBody(schemas.pinRecover), async (req, res) => {
  try {
    return res.json(await recoverPin({ ...req.body, userKey: req.authUserKey }));
  } catch (err) {
    console.error("Cavo PIN recovery error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to recover Cavo PIN", code: err.code });
  }
});

router.post("/approve", requireCavoSession, requireMatchingUserKey, validateBody(schemas.pinApprove), async (req, res) => {
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
    console.error("Cavo PIN approval error:", err.message || err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to approve transaction",
      code: err.code,
    });
  }
});

module.exports = router;
