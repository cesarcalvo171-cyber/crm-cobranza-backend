const express = require('express');
const router = express.Router();
const axios = require('axios');
const { verifyHmacSignature } = require('../middleware/signature');

// Traemos el cliente de Supabase desde app
module.exports = (supabase) => {

  /**
   * POST /api/webhooks/payment-received
   * Endpoint receptor de notificaciones de pago del banco.
   */
  router.post('/payment-received', verifyHmacSignature, async (req, res) => {
    const startTimestamp = new Date();
    
    // 1. Extraer datos del cuerpo
    const { 
      customer_number, 
      loan_number, 
      amount, 
      payment_date, 
      transaction_id 
    } = req.body;

    console.log(`[WEBHOOK] Pago recibido de Banco: CUST: ${customer_number}, LOAN: ${loan_number}, Cantidad: ${amount}, TX: ${transaction_id}`);

    // Validaciones básicas de campos mandatorios
    if (!customer_number || !amount || !transaction_id) {
      console.error('[WEBHOOK ERROR] Campos mandatorios faltantes.');
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Faltan campos obligatorios: customer_number, amount o transaction_id.'
      });
    }

    try {
      // 2. Registrar log de webhook inicial en Supabase
      const { data: logData, error: logError } = await supabase
        .from('webhook_logs')
        .insert([{
          webhook_type: 'payment_received',
          event_data: req.body,
          status: 'received'
        }])
        .select('*')
        .single();

      if (logError) {
        console.error('[DB ERROR] Error al crear log de webhook:', logError.message);
      }

      const logId = logData?.id;
       console.log('Customer recibido:', customer_number);
      // 3. Buscar cliente en la base de datos
      const { data: customer, error: customerError } = await supabase
        .from('customers')
        .select('*')
        .eq('customer_number', customer_number)
        .single();
        console.log('Resultado customer:', customer);
console.log('Error customer:', customerError);

      if (customerError || !customer) {
        const errorText = `Cliente con número ${customer_number} no fue encontrado en el sistema.`;
        console.error(`[WEBHOOK ERROR] ${errorText}`);

        if (logId) {
          await supabase
            .from('webhook_logs')
            .update({ status: 'failed', error_text: errorText })
            .eq('id', logId);
        }

        return res.status(404).json({ error: 'Not Found', message: errorText });
      }

      // 4. Buscar crédito correspondiente
      let loan = null;
      let loanUpdateError = null;
      let newBalance = 0;

      if (loan_number) {
        // Buscar préstamo específico
        const { data: specificLoan } = await supabase
          .from('loans')
          .select('*')
          .eq('loan_number', loan_number)
          .eq('customer_id', customer.id)
          .single();
        
        loan = specificLoan;
      } else {
        // Si no viene loan_number, buscar el primer préstamo activo o vencido del cliente
        const { data: generalLoans } = await supabase
          .from('loans')
          .select('*')
          .eq('customer_id', customer.id)
          .order('days_overdue', { ascending: false }) // Priorizar el que esté más vencido
          .limit(1);

        if (generalLoans && generalLoans.length > 0) {
          loan = generalLoans[0];
        }
      }

      if (loan) {
        // Calcular nuevo balance
        newBalance = Math.max(0, parseFloat(loan.balance) - parseFloat(amount));
        const newStatus = newBalance <= 0 ? 'paid' : loan.status;
        const newDaysOverdue = newBalance <= 0 ? 0 : loan.days_overdue;

        // Actualizar el préstamo
        const { error: updateError } = await supabase
          .from('loans')
          .update({
            balance: newBalance,
            status: newStatus,
            days_overdue: newDaysOverdue
          })
          .eq('id', loan.id);

        if (updateError) {
          loanUpdateError = updateError.message;
          console.error(`[DB ERROR] Error al actualizar el préstamo ${loan.loan_number}:`, updateError.message);
        } else {
          console.log(`[DB] Préstamo ${loan.loan_number} actualizado. Nuevo balance: $${newBalance}. Estado: ${newStatus}`);

          // Si el préstamo fue saldado, revisar si al cliente le quedan más préstamos en mora
          if (newBalance <= 0) {
            const { data: otherOverdueLoans } = await supabase
              .from('loans')
              .select('id')
              .eq('customer_id', customer.id)
              .eq('status', 'overdue')
              .neq('id', loan.id);

            if (!otherOverdueLoans || otherOverdueLoans.length === 0) {
              // Cliente ya no tiene créditos en mora, restauramos estado a 'active'
              await supabase
                .from('customers')
                .update({ status: 'active' })
                .eq('id', customer.id);
              console.log(`[DB] Cliente ${customer.name} restaurado a estado 'active' por liquidar mora.`);
            }
          }
        }
      } else {
        console.warn(`[WEBHOOK WARNING] No se encontró ningún préstamo activo para el cliente ${customer.name}.`);
      }

      // 5. Despachar a n8n en segundo plano (Asíncrono) para evitar latencias al banco
      const n8nPayload = {
        transaction_id,
        payment_date: payment_date || new Date().toISOString().split('T')[0],
        amount_paid: amount,
        customer: {
          id: customer.id,
          customer_number: customer.customer_number,
          name: customer.name,
          whatsapp_number: customer.whatsapp_number,
          sms_number: customer.sms_number,
          email: customer.email
        },
        loan: loan ? {
          id: loan.id,
          loan_number: loan.loan_number,
          original_amount: loan.amount,
          previous_balance: loan.balance,
          new_balance: newBalance,
          status: newBalance <= 0 ? 'paid' : loan.status
        } : null
      };

      const n8nUrl = process.env.N8N_PAYMENT_WEBHOOK_URL;
      
      // Llamada asíncrona no bloqueante
      axios.post(n8nUrl, n8nPayload)
        .then(() => {
          console.log('[n8n INTEGRATION] Evento de pago despachado exitosamente a n8n.');
        })
        .catch(err => {
          console.error('[n8n INTEGRATION ERROR] Falló el despacho del webhook a n8n:', err.message);
        });

      // 6. Actualizar log de webhook a procesado exitosamente
      if (logId) {
        await supabase
          .from('webhook_logs')
          .update({ 
            status: 'processed', 
            error_text: loanUpdateError ? `Aviso: Crédito no actualizado. Detalle: ${loanUpdateError}` : null 
          })
          .eq('id', logId);
      }

      // 7. Responder 200 al banco de inmediato
      return res.status(200).json({
        success: true,
        message: 'Pago recibido y procesándose en segundo plano.',
        transaction_id,
        received_at: startTimestamp.toISOString(),
        customer: {
          name: customer.name,
          customer_number: customer.customer_number
        },
        loan: loan ? {
          loan_number: loan.loan_number,
          new_balance: newBalance,
          status: newBalance <= 0 ? 'paid' : loan.status
        } : null
      });

    } catch (error) {
      console.error('[WEBHOOK EXCEPTION] Error catastrófico en webhook receptor:', error.message);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Ocurrió un error inesperado al procesar el pago.',
        detail: error.message
      });
    }
  });

  return router;
};
