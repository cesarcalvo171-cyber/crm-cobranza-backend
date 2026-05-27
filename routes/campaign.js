const express = require('express');
const router = express.Router();
const axios = require('axios');

module.exports = (supabase) => {

  /**
   * POST /api/campaigns/send
   * Dispara una campaña manual o automatizada hacia n8n.
   */
  router.post('/send', async (req, res) => {
    const { message_type, channel, selected_customer_ids } = req.body;

    console.log(`[CAMPAIGN] Petición de envío de campaña recibida. Tipo: ${message_type}, Canal: ${channel}`);

    if (!message_type || !channel) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Faltan campos mandatorios: message_type y channel.'
      });
    }

    try {
      // 1. Obtener la plantilla de mensaje de Supabase
      const { data: template, error: templateError } = await supabase
        .from('message_templates')
        .select('*')
        .eq('message_type', message_type)
        .single();

      if (templateError || !template) {
        return res.status(404).json({
          error: 'Not Found',
          message: `No se encontró ninguna plantilla para el tipo de mensaje: ${message_type}`
        });
      }

      // 2. Reunir destinatarios
      let customers = [];

      if (selected_customer_ids && selected_customer_ids.length > 0) {
        // Enviar solo a los clientes seleccionados
        const { data: selectedCustomers, error: selectError } = await supabase
          .from('customers')
          .select('*')
          .in('id', selected_customer_ids);

        if (selectError) {
          console.error('[DB ERROR] Error seleccionando destinatarios manuales:', selectError.message);
          return res.status(500).json({ error: 'DB Error', message: selectError.message });
        }
        customers = selectedCustomers || [];
      } else {
        // Si no se especifican IDs, enviar a todos los clientes 'active' u 'overdue' según plantilla
        const statusToFetch = message_type.startsWith('mora') ? 'overdue' : 'active';
        
        const { data: activeCustomers, error: fetchError } = await supabase
          .from('customers')
          .select('*')
          .eq('status', statusToFetch)
          .is('deleted_at', null);

        if (fetchError) {
          console.error('[DB ERROR] Error al buscar clientes para campaña masiva:', fetchError.message);
          return res.status(500).json({ error: 'DB Error', message: fetchError.message });
        }
        customers = activeCustomers || [];
      }

      if (customers.length === 0) {
        return res.status(200).json({
          success: false,
          message: 'No se encontraron clientes elegibles para esta campaña.',
          total_recipients: 0
        });
      }

      // 3. Obtener préstamos activos e información de montos para personalizar variables en n8n
      const customerIds = customers.map(c => c.id);
      const { data: loans, error: loansError } = await supabase
        .from('loans')
        .select('*')
        .in('customer_id', customerIds)
        .neq('status', 'paid'); // Préstamos vigentes o en mora

      if (loansError) {
        console.error('[DB ERROR] Error consultando créditos asociados a la campaña:', loansError.message);
      }

      // Mapear préstamos por ID de cliente para fácil lookup
      const loansMap = {};
      if (loans) {
        loans.forEach(loan => {
          // Guardamos el préstamo más crítico (priorizando el que tenga más días de mora)
          const existing = loansMap[loan.customer_id];
          if (!existing || loan.days_overdue > existing.days_overdue) {
            loansMap[loan.customer_id] = loan;
          }
        });
      }

      // 4. Crear registro de campaña en Supabase con estado 'processing'
      const campaignName = `Campaña ${template.name} - ${new Date().toLocaleDateString('es-ES')}`;
      const { data: campaign, error: campaignError } = await supabase
        .from('campaigns')
        .insert([{
          name: campaignName,
          message_type: message_type,
          channel: channel,
          status: 'processing',
          total_recipients: customers.length
        }])
        .select('*')
        .single();

      if (campaignError) {
        console.error('[DB ERROR] Error al crear registro de campaña:', campaignError.message);
        return res.status(500).json({ error: 'DB Error', message: campaignError.message });
      }

      // 5. Estructurar destinatarios enriquecidos para n8n
      const enrichedRecipients = customers.map(c => {
        const activeLoan = loansMap[c.id] || null;
        return {
          customer_id: c.id,
          customer_number: c.customer_number,
          name: c.name,
          whatsapp_number: c.whatsapp_number,
          sms_number: c.sms_number,
          email: c.email,
          loan: activeLoan ? {
            loan_id: activeLoan.id,
            loan_number: activeLoan.loan_number,
            balance: activeLoan.balance,
            days_overdue: activeLoan.days_overdue,
            due_date: activeLoan.due_date
          } : null
        };
      });

      // 6. Despachar petición asíncrona a n8n
      const n8nPayload = {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        message_type: template.message_type,
        template_content: template.content,
        channel: channel,
        recipients: enrichedRecipients
      };

      const n8nUrl = process.env.N8N_CAMPAIGN_WEBHOOK_URL;
      
      axios.post(n8nUrl, n8nPayload)
        .then(() => {
          console.log(`[n8n INTEGRATION] Campaña ${campaign.id} despachada exitosamente a n8n.`);
        })
        .catch(err => {
          console.error(`[n8n INTEGRATION ERROR] Falló el despacho de campaña ${campaign.id} a n8n:`, err.message);
          // Si n8n falla de inmediato, actualizamos el estado de la campaña en DB
          supabase
            .from('campaigns')
            .update({ status: 'failed', failed_count: customers.length })
            .eq('id', campaign.id)
            .then(() => console.log('[DB] Campaña marcada como fallida en base de datos.'));
        });

      // 7. Responder de inmediato al Frontend
      return res.status(200).json({
        success: true,
        message: 'Campaña encolada y enviada a n8n para despacho masivo.',
        campaign_id: campaign.id,
        campaign_name: campaignName,
        total_recipients: customers.length
      });

    } catch (error) {
      console.error('[CAMPAIGN EXCEPTION] Error en controlador de campaña:', error.message);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Ocurrió un error inesperado al orquestar la campaña.',
        detail: error.message
      });
    }
  });

  return router;
};
