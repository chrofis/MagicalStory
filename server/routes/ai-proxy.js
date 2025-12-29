/**
 * AI Proxy Routes
 *
 * Proxy endpoints for Claude and Gemini APIs.
 * Extracted from server.js for better code organization.
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { aiProxyLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');
const { logActivity } = require('../services/database');
const fs = require('fs').promises;
const path = require('path');

// Config file path for fallback API keys
const CONFIG_FILE = path.join(__dirname, '../../config.json');

/**
 * Read JSON file helper
 */
async function readJSON(filepath) {
  try {
    const content = await fs.readFile(filepath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

/**
 * POST /api/claude
 * Proxy endpoint for Claude/Anthropic API
 */
router.post('/claude', aiProxyLimiter, authenticateToken, async (req, res) => {
  log.debug('📖 === CLAUDE/ANTHROPIC ENDPOINT CALLED ===');
  log.debug(`  User: ${req.user?.username || 'unknown'}`);
  log.debug(`  Time: ${new Date().toISOString()}`);

  try {
    // Prioritize environment variable, fallback to config file
    let anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    log.debug('🔑 Anthropic API key check:');
    log.debug(`  From env: ${anthropicApiKey ? 'SET (length: ' + anthropicApiKey.length + ', starts with: ' + anthropicApiKey.substring(0, 6) + ')' : 'NOT SET'}`);

    if (!anthropicApiKey) {
      const config = await readJSON(CONFIG_FILE);
      anthropicApiKey = config.anthropicApiKey;
      log.debug(`  From config file: ${anthropicApiKey ? 'SET' : 'NOT SET'}`);
    }

    if (!anthropicApiKey) {
      log.debug('  ❌ No API key found!');
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    const { prompt, max_tokens } = req.body;

    await logActivity(req.user.id, req.user.username, 'CLAUDE_API_CALL', {
      promptLength: prompt?.length || 0,
      maxTokens: max_tokens
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: max_tokens || 8192,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      log.error('Claude API error response:', JSON.stringify(data, null, 2));
      const errorMsg = data.error?.message || data.error?.type || JSON.stringify(data.error) || 'Claude API request failed';
      throw new Error(errorMsg);
    }

    // Log token usage
    if (data.usage) {
      log.debug('📊 Token Usage:');
      log.debug(`  Input tokens:  ${data.usage.input_tokens.toLocaleString()}`);
      log.debug(`  Output tokens: ${data.usage.output_tokens.toLocaleString()}`);
      log.debug(`  Total tokens:  ${(data.usage.input_tokens + data.usage.output_tokens).toLocaleString()}`);
      log.debug(`  Max requested: ${max_tokens?.toLocaleString() || 'default'}`);

      // Warn if output limit was reached
      if (data.stop_reason === 'max_tokens') {
        log.warn('⚠️  WARNING: Output was truncated - max_tokens limit reached!');
      }
    }

    res.json(data);
  } catch (err) {
    log.error('Claude API error:', err.message);
    log.error('Full error:', err);
    res.status(500).json({ error: err.message || 'Failed to call Claude API' });
  }
});

/**
 * POST /api/gemini
 * Proxy endpoint for Gemini API
 */
router.post('/gemini', aiProxyLimiter, authenticateToken, async (req, res) => {
  log.debug('🎨 === GEMINI ENDPOINT CALLED ===');
  log.debug(`  User: ${req.user?.username || 'unknown'}`);
  log.debug(`  Time: ${new Date().toISOString()}`);

  try {
    // Prioritize environment variable, fallback to config file
    let geminiApiKey = process.env.GEMINI_API_KEY;

    log.debug('🔑 Gemini API key check:');
    console.log(`  From env: ${geminiApiKey ? 'SET (length: ' + geminiApiKey.length + ', starts with: ' + geminiApiKey.substring(0, 6) + ')' : 'NOT SET'}`);

    if (!geminiApiKey) {
      const config = await readJSON(CONFIG_FILE);
      geminiApiKey = config.geminiApiKey;
      console.log(`  From config file: ${geminiApiKey ? 'SET' : 'NOT SET'}`);
    }

    if (!geminiApiKey) {
      log.debug('  ❌ No API key found!');
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const { model, contents, safetySettings, generationConfig } = req.body;

    await logActivity(req.user.id, req.user.username, 'GEMINI_API_CALL', {
      model: model || 'gemini-2.5-flash-image'
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash-image'}:generateContent?key=${geminiApiKey}`;

    const requestBody = { contents };
    if (safetySettings) {
      requestBody.safetySettings = safetySettings;
    }
    // Add generationConfig with aspectRatio if not provided (for image generation)
    if (generationConfig) {
      requestBody.generationConfig = generationConfig;
    } else {
      // Default config for image generation - ensures 1:1 aspect ratio
      requestBody.generationConfig = {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 0.5,
        imageConfig: {
          aspectRatio: "1:1"
        }
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      log.error('❌ Gemini API error response:');
      log.error('  Status:', response.status);
      log.error('  Response:', JSON.stringify(data, null, 2));
      log.error('  Request URL:', url.substring(0, 100) + '...');
      log.error('  Model:', model || 'gemini-2.5-flash-image');
      throw new Error(data.error?.message || `Gemini API request failed: ${response.status}`);
    }

    res.json(data);
  } catch (err) {
    log.error('Gemini API error:', err);
    res.status(500).json({ error: err.message || 'Failed to call Gemini API' });
  }
});

module.exports = router;
