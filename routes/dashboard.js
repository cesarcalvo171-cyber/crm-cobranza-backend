/**
 * routes/dashboard.js — Endpoint de métricas del Dashboard
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/dashboard/stats
 *
 * Retorna las 4 métricas principales del panel:
 *   - totalCustomers     : Clientes activos (sin soft delete)
 *   - overdueCustomers   : Clientes con status = 'overdue'
 *   - totalDebt          : Suma de balances de préstamos en mora
 *   - notificationsToday : Notificaciones enviadas en últimas 24h
 *
 * Requiere: requireAuth middleware aplicado en server.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();

module.exports = (supabase) => {

  // Resistencia a esquemas sin deleted_at
  let hasDeletedAtColumn = null;

  const checkDbSchema = async () => {
    if (hasDeletedAtColumn !== null) return hasDeletedAtColumn;
    try {
      const { error } = await supabase
        .from('customers')
        .select('deleted_at')
        .limit(1);

      if (error && (
        error.message.includes('column customers.deleted_at does not exist') ||
        error.message.includes('column "deleted_at" does not exist') ||
        error.code === '42703'
      )) {
        hasDeletedAtColumn = false;
      } else {
        hasDeletedAtColumn = true;
      }
    } catch (err) {
      hasDeletedAtColumn = false;
    }
    return hasDeletedAtColumn;
  };

  /**
   * GET /api/dashboard/stats
   * Ejecuta las 4 queries en paralelo para máxima performance.
   */
  router.get('/stats', async (req, res) => {
    try {
      const hasSoftDelete = await checkDbSchema();
      const past24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Construcción de consultas base
      let totalQuery = supabase.from('customers').select('*', { count: 'exact', head: true });
      let overdueQuery = supabase.from('customers').select('*', { count: 'exact', head: true }).eq('status', 'overdue');

      if (hasSoftDelete) {
        totalQuery = totalQuery.is('deleted_at', null);
        overdueQuery = overdueQuery.is('deleted_at', null);
      }

      // ── Ejecutar las 4 consultas en paralelo ────────────────────────────
      const [
        totalResult,
        overdueResult,
        debtResult,
        notificationsResult,
      ] = await Promise.all([
        totalQuery,
        overdueQuery,

        // 3. Suma de deuda en mora (loans con status overdue)
        supabase
          .from('loans')
          .select('balance')
          .eq('status', 'overdue'),

        // 4. Notificaciones enviadas en últimas 24h
        supabase
          .from('notifications_sent')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', past24Hours),
      ]);

      // ── Manejo de errores parciales (no romper todo si una tabla falla) ──
      const errors = [];

      if (totalResult.error)         errors.push(`customers: ${totalResult.error.message}`);
      if (overdueResult.error)        errors.push(`overdue: ${overdueResult.error.message}`);
      if (debtResult.error)           errors.push(`loans: ${debtResult.error.message}`);
      if (notificationsResult.error)  errors.push(`notifications: ${notificationsResult.error.message}`);

      if (errors.length > 0) {
        console.warn('[DASHBOARD] Errores parciales en consultas de stats:', errors);
      }

      // ── Calcular suma de deuda ──────────────────────────────────────────
      const totalDebt = (debtResult.data || [])
        .reduce((acc, loan) => acc + Number(loan.balance || 0), 0);

      // ── Respuesta unificada ─────────────────────────────────────────────
      return res.status(200).json({
        success: true,
        data: {
          totalCustomers:     totalResult.count     ?? 0,
          overdueCustomers:   overdueResult.count   ?? 0,
          totalDebt:          totalDebt,
          notificationsToday: notificationsResult.count ?? 0,
        },
        warnings: errors.length > 0 ? errors : undefined,
        timestamp: new Date().toISOString(),
      });

    } catch (err) {
      console.error('[DASHBOARD EXCEPTION] Error inesperado en stats:', err.message);
      return res.status(500).json({
        success: false,
        error: {
          type: 'ServerError',
          message: 'Error al obtener métricas del dashboard.',
          details: err.message,
        },
      });
    }
  });

  return router;
};
