const crypto = require('crypto');

/**
 * Middleware para validar firmas HMAC-SHA256 en webhooks entrantes (banco / pasarela).
 *
 * Comportamiento por entorno:
 *   - development : la firma es OPCIONAL. Si está ausente o NODE_ENV=development,
 *                   la petición pasa con un warning en consola.
 *   - production  : la firma es OBLIGATORIA. Ausente o inválida → 401 Unauthorized.
 */
function verifyHmacSignature(req, res, next) {
  const signatureHeaderName = 'x-bank-signature';
  const signature = req.headers[signatureHeaderName];
  const secret = process.env.WEBHOOK_SECRET;
  const isDevelopment = process.env.NODE_ENV === 'development';

  // ──────────────────────────────────────────────────────────────────────────
  // MODO DESARROLLO: omitir validación con warning claro
  // ──────────────────────────────────────────────────────────────────────────
  if (isDevelopment) {
    console.warn('┌─────────────────────────────────────────────────────────┐');
    console.warn('│  ⚠️  [DEV MODE] Validación HMAC deshabilitada            │');
    console.warn('│  Requests sin firma aceptados. NO usar en producción.   │');
    console.warn('└─────────────────────────────────────────────────────────┘');
    return next();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MODO PRODUCCIÓN: validación HMAC estricta
  // ──────────────────────────────────────────────────────────────────────────

  // Fallar rápido si el secreto no fue configurado en producción
  if (!secret || secret === 'your_bank_webhook_hmac_secret_here') {
    console.error('[SECURITY FATAL] WEBHOOK_SECRET no está configurado en producción. Rechazando petición.');
    return res.status(500).json({
      error: 'Server Misconfiguration',
      message: 'El servidor no está correctamente configurado para recibir webhooks seguros.'
    });
  }

  // Firma ausente en producción → rechazar
  if (!signature) {
    console.error(`[SECURITY ERROR] Firma ausente en cabecera "${signatureHeaderName}". Petición rechazada.`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Firma de seguridad ausente en la petición.'
    });
  }

  try {
    // Calcular el HMAC esperado sobre el body serializado
    const bodyStr = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(bodyStr)
      .digest('hex');

    // Comparación segura contra ataques de temporización (Timing Attacks)
    const sigBuffer      = Buffer.from(signature, 'utf-8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');

    // timingSafeEqual requiere longitudes iguales
    if (sigBuffer.length !== expectedBuffer.length) {
      console.error('[SECURITY ERROR] Longitud de firma HMAC inválida.');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Firma de seguridad inválida.'
      });
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    if (!isValid) {
      console.error('[SECURITY ERROR] Firma HMAC inválida. La firma recibida no coincide con la esperada.');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Firma de seguridad inválida.'
      });
    }

    console.log('[SECURITY] Firma HMAC verificada exitosamente.');
    next();
  } catch (error) {
    console.error('[SECURITY ERROR] Error procesando verificación de firma HMAC:', error.message);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Error al verificar la firma de seguridad.'
    });
  }
}

module.exports = { verifyHmacSignature };
