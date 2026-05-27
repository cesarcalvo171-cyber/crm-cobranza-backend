const express = require('express');
const router = express.Router();

module.exports = (supabase) => {

  /**
   * POST /api/upload-csv
   * Recibe datos de clientes parseados en formato JSON desde el Frontend.
   * Realiza validación y carga en lote en Supabase (UPSERT por customer_number).
   */
  router.post('/upload-csv', async (req, res) => {
    const { rows } = req.body;

    console.log(`[CSV UPLOAD] Solicitud de carga recibida. Total filas: ${rows ? rows.length : 0}`);

    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'El cuerpo de la petición debe contener un arreglo de filas en la propiedad "rows".'
      });
    }

    try {
      const validRows = [];
      const errors = [];
      let skipped = 0;

      // 1. Validar fila por fila antes de insertar
      rows.forEach((row, index) => {
        const rowNum = index + 1;
        const name = row.name ? row.name.trim() : null;
        const customer_number = row.customer_number ? row.customer_number.trim() : null;
        
        // WhatsApp & SMS numbers cleanups
        let whatsapp = row.whatsapp_number || row.phone || '';
        let sms = row.sms_number || row.phone || '';
        let email = row.email ? row.email.trim() : null;

        whatsapp = whatsapp.toString().trim();
        sms = sms.toString().trim();

        if (!name || !customer_number) {
          errors.push(`Fila ${rowNum}: Falta el nombre o el número de cliente.`);
          skipped++;
          return;
        }

        if (!whatsapp && !sms) {
          errors.push(`Fila ${rowNum} (${name}): Debe tener al menos un número de WhatsApp o Teléfono para SMS.`);
          skipped++;
          return;
        }

        // Agregar fila al listado para upsert
        validRows.push({
          customer_number,
          name,
          whatsapp_number: whatsapp || null,
          sms_number: sms || null,
          email: email || null,
          status: row.status || 'active',
          updated_at: new Date()
        });
      });

      if (validRows.length === 0) {
        return res.status(200).json({
          success: false,
          message: 'No se encontraron registros válidos para cargar.',
          total: rows.length,
          created: 0,
          skipped,
          errors
        });
      }

      // 2. Ejecutar bulk upsert en Supabase
      // En Supabase, .upsert realiza un insert o update si hay conflicto en el campo UNIQUE definido.
      // 'customer_number' es la clave única que controlará la duplicación.
      const { data, error: dbError } = await supabase
        .from('customers')
        .upsert(validRows, { onConflict: 'customer_number' })
        .select('id, customer_number');

      if (dbError) {
        console.error('[DB ERROR] Falló la inserción en lote en Supabase:', dbError.message);
        return res.status(500).json({
          error: 'Database Error',
          message: 'Error al persistir los datos en Supabase.',
          detail: dbError.message
        });
      }

      console.log(`[DB] Carga bulk exitosa. ${validRows.length} registros cargados/actualizados.`);

      return res.status(200).json({
        success: true,
        message: 'Procesamiento de carga completado.',
        total: rows.length,
        created: validRows.length,
        skipped,
        errors: errors.slice(0, 20), // Devolver los primeros 20 errores para no saturar
        summary: `Se cargaron/actualizaron exitosamente ${validRows.length} clientes en el sistema.`
      });

    } catch (error) {
      console.error('[CSV UPLOAD EXCEPTION] Error en controlador de carga:', error.message);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Ocurrió un error inesperado al procesar la carga de clientes.',
        detail: error.message
      });
    }
  });

  return router;
};
