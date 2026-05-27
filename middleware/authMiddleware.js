/**
 * authMiddleware.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Middleware de autenticación JWT para rutas privadas del CRM.
 *
 * Flujo:
 *   1. Leer cabecera Authorization: Bearer <token>
 *   2. Validar el token contra Supabase Auth (getUser)
 *   3. Adjuntar req.user con datos del usuario autenticado
 *   4. Retornar 401/403 si el token falta o es inválido
 *
 * Uso:
 *   const { requireAuth } = require('./middleware/authMiddleware');
 *   app.use('/api/contacts', requireAuth, contactsRouter);
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Factory que recibe el cliente Supabase (Admin) y retorna el middleware.
 * Mantiene la arquitectura de inyección de dependencias del proyecto.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Function} Express middleware
 */
function createAuthMiddleware(supabase) {
  return async function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];

    // ── 1. Verificar presencia del header ──────────────────────────────────
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: {
          type: 'Unauthorized',
          message: 'Token de autenticación requerido. Incluye el header: Authorization: Bearer <token>',
        },
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token || token.trim() === '') {
      return res.status(401).json({
        success: false,
        error: {
          type: 'Unauthorized',
          message: 'Token de autenticación vacío o malformado.',
        },
      });
    }

    try {
      // ── 2. Validar token contra Supabase Auth ────────────────────────────
      // getUser() verifica la firma del JWT y su expiración contra el servidor.
      // Es más seguro que decodificar localmente porque detecta revocaciones.
      const { data, error } = await supabase.auth.getUser(token);

      if (error) {
        // Distinguir entre token expirado y token completamente inválido
        const isExpired =
          error.message?.toLowerCase().includes('expired') ||
          error.message?.toLowerCase().includes('jwt expired');

        if (isExpired) {
          console.warn(`[AUTH] Token expirado para request ${req.method} ${req.path}`);
          return res.status(401).json({
            success: false,
            error: {
              type: 'TokenExpired',
              message: 'La sesión ha expirado. Por favor, inicia sesión nuevamente.',
            },
          });
        }

        console.warn(`[AUTH] Token inválido para request ${req.method} ${req.path}: ${error.message}`);
        return res.status(403).json({
          success: false,
          error: {
            type: 'Forbidden',
            message: 'Token de autenticación inválido o revocado.',
          },
        });
      }

      if (!data?.user) {
        return res.status(401).json({
          success: false,
          error: {
            type: 'Unauthorized',
            message: 'No se pudo identificar al usuario autenticado.',
          },
        });
      }

      // ── 3. Adjuntar datos del usuario al request ─────────────────────────
      req.user = {
        id:    data.user.id,
        email: data.user.email,
        role:  data.user.role,
        // Metadatos de la sesión para auditoría futura
        lastSignIn: data.user.last_sign_in_at,
      };

      next();

    } catch (err) {
      // Error inesperado en la validación (red, Supabase down, etc.)
      console.error('[AUTH EXCEPTION] Error inesperado al validar JWT:', err.message);
      return res.status(500).json({
        success: false,
        error: {
          type: 'AuthServiceError',
          message: 'Error interno al verificar la autenticación. Intenta nuevamente.',
        },
      });
    }
  };
}

module.exports = { createAuthMiddleware };
