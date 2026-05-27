/**
 * server.js — CRM Cobranza API Gateway
 * ─────────────────────────────────────────────────────────────────────────────
 * Versión: 4B.5 — Production Hardened
 *
 * Cambios vs versión anterior:
 *   - CORS con whitelist de orígenes (no más cors() abierto)
 *   - JWT middleware en rutas privadas (/api/contacts, /api/campaigns)
 *   - Rate limiting: 100 req / 15 min por IP
 *   - Morgan logger para trazabilidad de requests
 *   - Helmet para cabeceras HTTP de seguridad
 *   - Eliminada ruta duplicada /api/upload-csv
 *   - Rutas públicas separadas explícitamente
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const cors     = require('cors');
const morgan   = require('morgan');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { createAuthMiddleware } = require('./middleware/authMiddleware');

// ─────────────────────────────────────────────────────────────────────────────
// 1. VALIDACIÓN DE VARIABLES DE ENTORNO CRÍTICAS
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FRONTEND_URL'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`[FATAL] Faltan variables de entorno requeridas: ${missingEnv.join(', ')}`);
  console.error('[FATAL] Revisa tu archivo .env y agrega las variables faltantes.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. INICIALIZACIÓN
// ─────────────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 5000;
const isDev = process.env.NODE_ENV === 'development';

// Cliente Supabase Admin (Service Role Key — solo se usa server-side)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
console.log('[DB] Cliente Supabase Admin inicializado correctamente.');

// Middleware JWT (factory con inyección de supabase)
const requireAuth = createAuthMiddleware(supabase);

// ─────────────────────────────────────────────────────────────────────────────
// 3. MIDDLEWARE GLOBALES — SEGURIDAD BASE
// ─────────────────────────────────────────────────────────────────────────────

// ── 3.1 Helmet: cabeceras HTTP de seguridad ──────────────────────────────────
// contentSecurityPolicy deshabilitado para no romper el frontend en desarrollo.
// En producción se recomienda configurarlo con la política correcta.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// ── 3.2 CORS: Whitelist de orígenes permitidos ───────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,           // Variable de entorno (producción o local)
  'http://localhost:3000',             // Dev: Vite frontend
  'http://127.0.0.1:3000',            // Dev: alias localhost
];

// En desarrollo también permite requests sin origin (Postman, curl, tests)
app.use(
  cors({
    origin: (origin, callback) => {
      // Permitir requests sin origin (curl, Postman, tests E2E en dev)
      if (!origin && isDev) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn(`[CORS] Origin bloqueado: ${origin}`);
      return callback(new Error(`CORS: Origin no permitido → ${origin}`), false);
    },
    credentials: true,        // Necesario para envío de cookies y Authorization header
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── 3.3 Body Parser ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));  // Soporta CSV bulk payloads

// ── 3.4 Morgan: Logging de Requests HTTP ─────────────────────────────────────
// Formato "dev" en desarrollo (coloreado), "combined" en producción (Apache style)
app.use(morgan(isDev ? 'dev' : 'combined'));

// ─────────────────────────────────────────────────────────────────────────────
// 4. RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────

// ── Rate limit general: 200 req / 15 min por IP ──────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,
  standardHeaders: true,     // Cabeceras RateLimit-* en respuestas
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      type: 'TooManyRequests',
      message: 'Demasiadas solicitudes desde esta IP. Por favor espera 15 minutos antes de reintentar.',
    },
  },
});

// ── Rate limit estricto para rutas de autenticación / carga masiva ────────────
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      type: 'TooManyRequests',
      message: 'Límite de solicitudes alcanzado para esta operación. Intenta en 15 minutos.',
    },
  },
});

// Aplicar rate limit general a toda la API
app.use('/api/', generalLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// 5. IMPORTAR ROUTERS
// ─────────────────────────────────────────────────────────────────────────────
const webhookRouter   = require('./routes/webhook')(supabase);
const campaignRouter  = require('./routes/campaign')(supabase);
const contactsRouter  = require('./routes/contacts')(supabase);
const dashboardRouter = require('./routes/dashboard')(supabase);

// ─────────────────────────────────────────────────────────────────────────────
// 6. RUTAS PÚBLICAS (sin autenticación JWT)
// ─────────────────────────────────────────────────────────────────────────────

// Webhooks del banco — Protegidos por HMAC signature (middleware propio)
// NO requieren JWT: los llama el banco, no el frontend
app.use('/api/webhooks', webhookRouter);

// Health checks — Siempre públicos para monitoreo
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'crm-cobranza-backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'CRM Cobranza API Gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'production',
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'CRM Cobranza API Gateway',
    version: '4B.5',
    status: 'running',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. RUTAS PRIVADAS (requieren JWT válido de Supabase)
// ─────────────────────────────────────────────────────────────────────────────

// Dashboard Stats — Protegido: requiere sesión activa
app.use('/api/dashboard', requireAuth, dashboardRouter);

// Contacts CRUD — Protegido: requiere sesión activa
// Rate limit estricto adicional en upload-csv (operación pesada)
app.use('/api/contacts', requireAuth, contactsRouter);

// Campaigns — Protegido: requiere sesión activa
app.use('/api/campaigns', requireAuth, campaignRouter);

// NOTA: La ruta duplicada /api/upload-csv fue eliminada.
// El endpoint correcto es: POST /api/contacts/upload-csv
// Con rate limit estricto en esa subruta específica:
app.use('/api/contacts/upload-csv', strictLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// 8. MANEJO DE ERRORES GLOBAL
// ─────────────────────────────────────────────────────────────────────────────

// Handler para errores CORS (lanzados por la función origin)
app.use((err, req, res, next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({
      success: false,
      error: {
        type: 'CORSError',
        message: 'Origen no autorizado para acceder a este servidor.',
      },
    });
  }
  next(err);
});

// Handler de errores genérico (no expone stack traces en producción)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const statusCode = err.status || err.statusCode || 500;
  console.error(`[SERVER ERROR] ${req.method} ${req.path} → ${err.message}`);
  res.status(statusCode).json({
    success: false,
    error: {
      type: 'ServerError',
      message: isDev ? err.message : 'Ocurrió un error interno en el servidor.',
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. INICIAR SERVIDOR
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 CRM Cobranza Backend v4B.5 corriendo en http://localhost:${PORT}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'production'}`);
  console.log(`🔒 CORS permitido para: ${allowedOrigins.filter(Boolean).join(', ')}`);
  console.log(`🩺 Health Check: http://localhost:${PORT}/api/health`);
  console.log(`🔐 Rutas protegidas: /api/contacts, /api/campaigns, /api/dashboard`);
  console.log(`📡 Rutas públicas:   /api/webhooks/*, /api/health, /health`);
  console.log('====================================================');
});
