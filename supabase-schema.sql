-- ====================================================================
-- ESQUEMA DE BASE DE DATOS PARA CRM COBRANZA INTELIGENTE (CMR_Cobranza)
-- ====================================================================
-- Ejecuta este script completo en el Editor SQL de tu panel de Supabase.

-- Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Limpieza preventiva de tablas en caso de reinicio
DROP TABLE IF EXISTS webhook_logs CASCADE;
DROP TABLE IF EXISTS notifications_sent CASCADE;
DROP TABLE IF EXISTS campaigns CASCADE;
DROP TABLE IF EXISTS message_templates CASCADE;
DROP TABLE IF EXISTS loans CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS system_settings CASCADE;

-- 1. TABLA DE CLIENTES (CUSTOMERS)
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_number VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  whatsapp_number VARCHAR(20),
  sms_number VARCHAR(20),
  email VARCHAR(100),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'overdue')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- 2. TABLA DE CRÉDITOS / PRÉSTAMOS (LOANS)
CREATE TABLE loans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  loan_number VARCHAR(50) UNIQUE NOT NULL,
  amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0.00, -- Saldo pendiente actual en mora o cuota
  status VARCHAR(50) DEFAULT 'current' CHECK (status IN ('current', 'overdue', 'paid')),
  days_overdue INT DEFAULT 0,
  due_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- 3. TABLA DE PLANTILLAS DE MENSAJES (TEMPLATES)
CREATE TABLE message_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  message_type VARCHAR(50) NOT NULL UNIQUE, -- 'aviso', 'mora_1_dia', 'mora_7_dias', 'payment_confirmation'
  content TEXT NOT NULL,
  channel VARCHAR(50) DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms', 'email', 'all')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- 4. TABLA DE CAMPAÑAS (CAMPAIGNS)
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  message_type VARCHAR(50) REFERENCES message_templates(message_type),
  channel VARCHAR(50) CHECK (channel IN ('whatsapp', 'sms', 'email')),
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'completed', 'failed')),
  total_recipients INT DEFAULT 0,
  sent_count INT DEFAULT 0,
  delivered_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- 5. REGISTRO CENTRAL DE NOTIFICACIONES ENVIADAS (NOTIFICATIONS SENT)
CREATE TABLE notifications_sent (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  loan_id UUID REFERENCES loans(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  message_type VARCHAR(50) NOT NULL,
  channel VARCHAR(50) NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  message_content TEXT NOT NULL,
  recipient_phone_or_email VARCHAR(100) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'read')),
  sent_at TIMESTAMP WITH TIME ZONE,
  delivered_at TIMESTAMP WITH TIME ZONE,
  failed_reason TEXT,
  external_id VARCHAR(100), -- ID provisto por Twilio/n8n para trazar callbacks
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- 6. LOGS DE WEBHOOKS DEL BANCO E INTEGRACIONES
CREATE TABLE webhook_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_type VARCHAR(50) NOT NULL, -- 'payment_received', 'bank_error', 'delivery_callback'
  event_data JSONB NOT NULL,
  status VARCHAR(50) DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed')),
  error_text TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- 7. CONFIGURACIONES GLOBALES DEL SISTEMA (SETTINGS)
CREATE TABLE system_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- ====================================================================
-- CREACIÓN DE ÍNDICES DE ALTO RENDIMIENTO
-- ====================================================================
CREATE INDEX idx_customers_status ON customers(status);
CREATE INDEX idx_loans_status ON loans(status);
CREATE INDEX idx_loans_overdue ON loans(days_overdue) WHERE days_overdue > 0;
CREATE INDEX idx_notifications_status ON notifications_sent(status);
CREATE INDEX idx_notifications_created ON notifications_sent(created_at);
CREATE INDEX idx_notifications_external_id ON notifications_sent(external_id);

-- ====================================================================
-- INYECCIÓN DE PLANTILLAS Y DATOS POR DEFECTO
-- ====================================================================

-- 1. Insertar Plantillas de Mensajes
INSERT INTO message_templates (name, message_type, content, channel) VALUES
('Recordatorio Preventivo', 'aviso', 'Hola {name}, te recordamos que tu cuota de ${amount} vence el {due_date}. Evita recargos pagando de forma segura aquí: {payment_link}. ¡Gracias!', 'whatsapp'),
('Notificación de Mora Temprana', 'mora_1_dia', 'Hola {name}, detectamos que tu saldo de ${amount} presenta 1 día de atraso. Por favor, regulariza tu cuenta hoy para evitar cargos y reportes.', 'whatsapp'),
('Mora Avanzada (SMS Respaldo)', 'mora_avanzada_sms', 'Hola {name}, tu credito presenta mora. Comunica al canal de cobranzas de inmediato para estructurar una solucion. Saldo: ${amount}.', 'sms'),
('Confirmación de Pago Inmediata', 'payment_confirmation', 'Hola {name}, confirmamos la recepción exitosa de tu pago por ${amount} el día {date}. Tu transacción ID es: {transaction_id}. ¡Gracias por mantener tu cuenta al día! 🎉', 'whatsapp');

-- 2. Insertar Configuraciones del Sistema Iniciales
INSERT INTO system_settings (key, value, description) VALUES
('meta_api_version', 'v19.0', 'Versión de la API de Meta Cloud que utilizará n8n'),
('whatsapp_phone_number_id', 'YOUR_WHATSAPP_PHONE_NUMBER_ID', 'ID del número telefónico en Meta WhatsApp Business'),
('whatsapp_business_account_id', 'YOUR_WHATSAPP_BUSINESS_ACCOUNT_ID', 'ID de la cuenta comercial de WhatsApp Business');
