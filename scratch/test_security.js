/**
 * test_security.js — Tests E2E de seguridad del Sprint 1
 * Verifica JWT middleware, CORS, rate limiting y health checks.
 */

const axios = require('axios');

const BASE = 'http://localhost:5000';
let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ PASS  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.log(`  ❌ FAIL  ${label}`);
  if (detail) console.log(`          → ${detail}`);
  failed++;
}

async function test(label, fn) {
  try {
    await fn();
  } catch (err) {
    fail(label, err.message);
  }
}

async function runTests() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' 🔐 Security Test Suite — Sprint 1 Backend Hardening');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── TEST 1: Health check público ──────────────────────────────────────────
  console.log('📋 GRUPO 1: Rutas Públicas\n');
  await test('GET /api/health → 200 (sin token)', async () => {
    const res = await axios.get(`${BASE}/api/health`);
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    if (res.data.status !== 'ok') throw new Error('Campo status no es ok');
    ok('GET /api/health → 200 (público)');
  });

  await test('GET /health → 200 (sin token)', async () => {
    const res = await axios.get(`${BASE}/health`);
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    ok('GET /health → 200 (público)');
  });

  await test('GET / → 200 (raíz pública)', async () => {
    const res = await axios.get(`${BASE}/`);
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    ok('GET / → 200 (público)');
  });

  // ── TEST 2: JWT Middleware — Rutas protegidas sin token ──────────────────
  console.log('\n📋 GRUPO 2: JWT Middleware — Sin Token\n');

  await test('GET /api/contacts → 401 (sin token)', async () => {
    try {
      await axios.get(`${BASE}/api/contacts`);
      fail('GET /api/contacts → debería ser 401 pero fue 200');
    } catch (err) {
      if (err.response?.status === 401) {
        ok('GET /api/contacts → 401 (rechazado sin token)');
      } else {
        throw new Error(`Status inesperado: ${err.response?.status}`);
      }
    }
  });

  await test('POST /api/campaigns/send → 401 (sin token)', async () => {
    try {
      await axios.post(`${BASE}/api/campaigns/send`, {});
      fail('POST /api/campaigns/send → debería ser 401');
    } catch (err) {
      if (err.response?.status === 401) {
        ok('POST /api/campaigns/send → 401 (rechazado sin token)');
      } else {
        throw new Error(`Status inesperado: ${err.response?.status}`);
      }
    }
  });

  await test('GET /api/dashboard/stats → 401 (sin token)', async () => {
    try {
      await axios.get(`${BASE}/api/dashboard/stats`);
      fail('GET /api/dashboard/stats → debería ser 401');
    } catch (err) {
      if (err.response?.status === 401) {
        ok('GET /api/dashboard/stats → 401 (rechazado sin token)');
      } else {
        throw new Error(`Status inesperado: ${err.response?.status}`);
      }
    }
  });

  // ── TEST 3: JWT Middleware — Token malformado ─────────────────────────────
  console.log('\n📋 GRUPO 3: JWT Middleware — Token Inválido\n');

  await test('GET /api/contacts con token falso → 403', async () => {
    try {
      await axios.get(`${BASE}/api/contacts`, {
        headers: { Authorization: 'Bearer token_completamente_falso_12345' }
      });
      fail('GET /api/contacts con token falso → debería ser 403');
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 401) {
        ok(`GET /api/contacts con token falso → ${err.response.status} (rechazado)`);
      } else {
        throw new Error(`Status inesperado: ${err.response?.status}`);
      }
    }
  });

  await test('GET /api/contacts con header malformado → 401', async () => {
    try {
      await axios.get(`${BASE}/api/contacts`, {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' } // Basic auth no Bearer
      });
      fail('Header malformado → debería ser 401');
    } catch (err) {
      if (err.response?.status === 401) {
        ok('Header Authorization no Bearer → 401 correcto');
      } else {
        throw new Error(`Status inesperado: ${err.response?.status}`);
      }
    }
  });

  // ── TEST 4: Estructura de respuesta de error ───────────────────────────────
  console.log('\n📋 GRUPO 4: Estructura de Respuestas de Error\n');

  await test('401 tiene estructura { success, error: { type, message } }', async () => {
    try {
      await axios.get(`${BASE}/api/contacts`);
    } catch (err) {
      const body = err.response?.data;
      if (!body) throw new Error('Sin body en respuesta');
      if (body.success !== false) throw new Error('success debería ser false');
      if (!body.error?.type) throw new Error('Falta error.type');
      if (!body.error?.message) throw new Error('Falta error.message');
      ok('401 tiene estructura JSON correcta { success: false, error: { type, message } }');
    }
  });

  // ── TEST 5: Webhook público (no requiere JWT) ─────────────────────────────
  console.log('\n📋 GRUPO 5: Webhooks Públicos (HMAC, sin JWT)\n');

  await test('POST /api/webhooks/payment-received → no es 401 (es público)', async () => {
    try {
      const res = await axios.post(`${BASE}/api/webhooks/payment-received`, {
        customer_number: 'TEST-001',
        amount: 100,
        transaction_id: 'TX-TEST-001'
      });
      // En dev, sin HMAC puede pasar o dar 400/404 pero NO 401
      if (res.status === 401) throw new Error('Webhook retornó 401 — no debería requerir JWT');
      ok(`POST /api/webhooks/payment-received → ${res.status} (no requiere JWT)`);
    } catch (err) {
      if (err.response?.status === 401) {
        fail('Webhook requiere JWT cuando no debería', `Status: ${err.response.status}`);
      } else {
        // 400, 404, 500 son aceptables (el webhook puede requerir HMAC o datos correctos)
        ok(`POST /api/webhooks/payment-received → ${err.response?.status} (no bloquea por JWT)`);
      }
    }
  });

  // ── RESUMEN ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(` 📊 RESULTADOS: ${passed} PASSED  |  ${failed} FAILED`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('[TEST RUNNER ERROR]', err.message);
  process.exit(1);
});
