/**
 * Deploy-pending flag — /api/admin/deploy-pending
 *
 * POST sets it; the pre-push gate calls this right after its idle verdict, so the
 * Test Lab refuses new runs during the 2-3 minutes Railway needs to build and
 * restart the container. GET reads it. See server/lib/deployPending.js.
 */
const express = require('express');
const router = express.Router();

const { authenticateToken, requireAdmin } = require('../../middleware/auth');
const { isDatabaseMode } = require('../../services/database');
const { setDeployPending, getDeployPending } = require('../../lib/deployPending');
const { log } = require('../../utils/logger');

router.use(authenticateToken, requireAdmin, (req, res, next) => {
  if (!isDatabaseMode()) return res.status(501).json({ error: 'Database mode required' });
  next();
});

router.post('/', async (req, res) => {
  const { commit, setBy } = req.body || {};
  try {
    const flag = await setDeployPending({ targetCommit: commit, setBy: setBy || req.user.username || String(req.user.id) });
    res.json({ ok: true, deployPending: flag });
  } catch (err) {
    const bad = /targetCommit must be/.test(err.message);
    if (!bad) log.error(`[DEPLOY-PENDING] set failed: ${err.message}`);
    res.status(bad ? 400 : 500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    res.json({ deployPending: await getDeployPending() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
