const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// 1. Inicializar Express
const app = express();
const PORT = process.env.PORT || 5000;

// Configurar middlewares generales
app.use(express.json({ limit: '10mb' })); // Permitir JSONs grandes para cargas CSV bulk
app.use(cors());

// 2. Validar variables de entorno críticas antes de iniciar
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL ERROR] Falta configurar SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el archivo .env');
  process.exit(1);
}

// 3. Inicializar Cliente Supabase con rol Administrativo (Service Role Key)
// Esto permite omitir políticas RLS para registros automáticos de pasarelas bancarias y n8n
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log('[DB] Cliente Supabase Admin inicializado exitosamente.');

// 4. Importar Rutas Modulares pasando el cliente Supabase
const webhookRouter = require('./routes/webhook')(supabase);
const campaignRouter = require('./routes/campaign')(supabase);
const contactsRouter = require('./routes/contacts')(supabase);

// 5. Mapear Rutas de la API
app.use('/api/webhooks', webhookRouter);
app.use('/api/campaigns', campaignRouter);
app.use('/api/contacts', contactsRouter);

// Compatibilidad directa con endpoints alternativos
app.use('/api/upload-csv', contactsRouter); 
app.post('/api/upload', (req, res) => {
  // Redireccionar o delegar al mismo controlador de contactos
  res.redirect(307, '/api/contacts/upload-csv');
});

// 6. Endpoints de Monitoreo (Health Check)
// Endpoint compacto de validación rápida
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'crm-cobranza-backend'
  });
});

// Endpoint extendido con métricas de uptime
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'CRM Cobranza API Gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.send('Servidor API Gateway de CRM Cobranza Inteligente Activo.');
});

// 7. Iniciar Escucha de Servidor
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 Servidor CRM Cobranza corriendo en http://localhost:${PORT}`);
  console.log(`🩺 Health Check (test): http://localhost:${PORT}/api/health`);
  console.log(`📡 Endpoint Webhook Pago: http://localhost:${PORT}/api/webhooks/payment-received`);
  console.log(`📡 Endpoint Campañas: http://localhost:${PORT}/api/campaigns/send`);
  console.log(`📡 Endpoint Carga CSV: http://localhost:${PORT}/api/contacts/upload-csv`);
  console.log('====================================================');
});
