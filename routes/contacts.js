const express = require('express');
const router = express.Router();

module.exports = (supabase) => {

  // Flag de detección de columna `deleted_at` para resiliencia del esquema
  let hasDeletedAtColumn = null;

  const checkDbSchema = async () => {
    if (hasDeletedAtColumn !== null) return hasDeletedAtColumn;
    try {
      // Intenta seleccionar la columna deleted_at
      const { error } = await supabase
        .from('customers')
        .select('deleted_at')
        .limit(1);

      if (error && (
        error.message.includes('column customers.deleted_at does not exist') ||
        error.message.includes('column "deleted_at" does not exist') ||
        error.code === '42703' // Código Postgres para Undefined Column
      )) {
        console.warn('\n====================================================================');
        console.warn('⚠️  [DB SCHEMA WARNING] La columna "deleted_at" no existe en la tabla "customers".');
        console.warn('⚠️  Soft Delete no estará disponible hasta que actualices el esquema.');
        console.warn('👉  Ejecuta el script "migration_add_deleted_at.sql" en tu editor de Supabase.');
        console.warn('====================================================================\n');
        hasDeletedAtColumn = false;
      } else {
        hasDeletedAtColumn = true;
      }
    } catch (err) {
      hasDeletedAtColumn = false;
    }
    return hasDeletedAtColumn;
  };

  // ==========================================
  // HELPERS DE RESPUESTA Y VALIDACIÓN
  // ==========================================

  const sendError = (res, statusCode, errorType, message, details = null) => {
    return res.status(statusCode).json({
      success: false,
      error: {
        type: errorType,
        message,
        details
      }
    });
  };

  const sendSuccess = (res, data, extra = {}) => {
    return res.status(200).json({
      success: true,
      data,
      ...extra
    });
  };

  // Validación de contacto individual para creación o edición
  const validateContact = (data, isUpdate = false, existingData = null) => {
    const errors = [];
    const name = data.name !== undefined ? data.name : null;
    const customer_number = data.customer_number !== undefined ? data.customer_number : null;
    const whatsapp_number = data.whatsapp_number !== undefined ? data.whatsapp_number : null;
    const sms_number = data.sms_number !== undefined ? data.sms_number : null;
    const email = data.email !== undefined ? data.email : null;
    const status = data.status !== undefined ? data.status : null;

    // Validación de Nombre
    if (!isUpdate || data.name !== undefined) {
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        errors.push('El nombre ("name") es requerido y debe ser un texto válido.');
      }
    }

    // Validación de Número de Cliente
    if (!isUpdate || data.customer_number !== undefined) {
      if (!customer_number || typeof customer_number !== 'string' || customer_number.trim().length === 0) {
        errors.push('El número de cliente ("customer_number") es requerido.');
      }
    }

    // Validación de canales de contacto (debe existir al menos un medio)
    // Para actualizaciones parciales, combinamos con el registro existente
    if (isUpdate && existingData) {
      const finalWhatsApp = data.whatsapp_number !== undefined ? data.whatsapp_number : existingData.whatsapp_number;
      const finalSMS = data.sms_number !== undefined ? data.sms_number : existingData.sms_number;
      
      const wa = finalWhatsApp !== null ? finalWhatsApp.toString().trim() : '';
      const sms = finalSMS !== null ? finalSMS.toString().trim() : '';
      
      if (!wa && !sms) {
        errors.push('Debe proporcionar al menos un número de WhatsApp ("whatsapp_number") o Teléfono para SMS ("sms_number").');
      }
    } else if (!isUpdate) {
      // Creación manual estándar
      const wa = whatsapp_number !== null ? whatsapp_number.toString().trim() : '';
      const sms = sms_number !== null ? sms_number.toString().trim() : '';
      if (!wa && !sms) {
        errors.push('Debe proporcionar al menos un número de WhatsApp ("whatsapp_number") o Teléfono para SMS ("sms_number").');
      }
    }

    // Validación de Email
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.toString().trim())) {
        errors.push('El formato del correo electrónico ("email") no es válido.');
      }
    }

    // Validación de Estado
    if (status) {
      const validStatuses = ['active', 'inactive', 'overdue'];
      if (!validStatuses.includes(status)) {
        errors.push('El estado ("status") debe ser uno de los siguientes: active, inactive, overdue.');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  };

  // Auxiliar para determinar si un string es un UUID válido
  const isUUID = (str) => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  };

  // ==========================================
  // RUTAS / ENDPOINTS
  // ==========================================

  /**
   * GET /api/contacts
   * Listado de contactos con paginación, búsqueda, filtros y exclusión de soft deletes.
   */
  router.get('/', async (req, res) => {
    try {
      const hasSoftDelete = await checkDbSchema();
      const { page = 1, limit = 10, search, status, includeDeleted = 'false' } = req.query;

      console.log(`[CONTACTS GET] Listado solicitado. Filtros -> Status: ${status || 'todos'}, Search: "${search || ''}"`);

      // Inicializar constructor de consulta
      let query = supabase
        .from('customers')
        .select('*', { count: 'exact' });

      // Filtrar por soft delete por defecto si la columna existe
      if (hasSoftDelete && includeDeleted !== 'true') {
        query = query.is('deleted_at', null);
      }

      // Aplicar filtro por estado
      if (status) {
        query = query.eq('status', status);
      }

      // Aplicar búsqueda global multi-columna (name, customer_number, whatsapp_number, sms_number, email)
      if (search) {
        const cleanSearch = search.trim();
        query = query.or(`name.ilike.%${cleanSearch}%,customer_number.ilike.%${cleanSearch}%,whatsapp_number.ilike.%${cleanSearch}%,sms_number.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%`);
      }

      // Calcular límites de paginación
      const pageNum = Math.max(1, parseInt(page, 10));
      const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)));
      const from = (pageNum - 1) * limitNum;
      const to = from + limitNum - 1;

      // Ordenamiento por fecha de creación descendente
      query = query.range(from, to).order('created_at', { ascending: false });

      const { data, error, count } = await query;

      if (error) {
        console.error('[DB ERROR] Error al consultar clientes en Supabase:', error.message);
        return sendError(res, 500, 'DatabaseError', 'Error al consultar los contactos en la base de datos.', error.message);
      }

      const totalPages = Math.ceil(count / limitNum);

      return sendSuccess(res, data, {
        pagination: {
          total: count,
          page: pageNum,
          limit: limitNum,
          totalPages
        },
        schemaWarning: !hasSoftDelete ? 'El soft-delete está inactivo temporalmente. Por favor ejecuta migration_add_deleted_at.sql en Supabase.' : undefined
      });

    } catch (err) {
      console.error('[CONTACTS EXCEPTION] Error en listado de contactos:', err.message);
      return sendError(res, 500, 'ServerError', 'Ocurrió un error inesperado al procesar el listado de contactos.', err.message);
    }
  });

  /**
   * GET /api/contacts/:id
   * Obtiene un contacto por su UUID único o por su customer_number. Excluye por defecto eliminados.
   */
  router.get('/:id', async (req, res) => {
    try {
      const hasSoftDelete = await checkDbSchema();
      const { id } = req.params;
      const { includeDeleted = 'false' } = req.query;

      console.log(`[CONTACTS GET BY ID] Buscando cliente por identificador: ${id}`);

      let query = supabase.from('customers');
      
      if (isUUID(id)) {
        query = query.select('*').eq('id', id);
      } else {
        query = query.select('*').eq('customer_number', id);
      }

      if (hasSoftDelete && includeDeleted !== 'true') {
        query = query.is('deleted_at', null);
      }

      const { data, error } = await query.maybeSingle();

      if (error) {
        console.error('[DB ERROR] Error al buscar cliente por ID:', error.message);
        return sendError(res, 500, 'DatabaseError', 'Error al buscar el contacto.', error.message);
      }

      if (!data) {
        return sendError(res, 404, 'NotFound', `Contacto con identificador '${id}' no encontrado.`);
      }

      return sendSuccess(res, data);

    } catch (err) {
      console.error('[CONTACTS EXCEPTION] Error al buscar contacto:', err.message);
      return sendError(res, 500, 'ServerError', 'Ocurrió un error inesperado al buscar el contacto.', err.message);
    }
  });

  /**
   * POST /api/contacts
   * Crea un nuevo contacto de manera manual con validación completa.
   */
  router.post('/', async (req, res) => {
    try {
      const hasSoftDelete = await checkDbSchema();
      console.log('[CONTACTS POST] Creando nuevo contacto manualmente:', req.body);

      // 1. Validar datos de entrada
      const { isValid, errors } = validateContact(req.body, false);
      if (!isValid) {
        return sendError(res, 400, 'ValidationError', 'Los datos proporcionados no son válidos.', errors);
      }

      const { customer_number, name, whatsapp_number, sms_number, email, status = 'active' } = req.body;

      // 2. Comprobar si ya existe un cliente activo con ese customer_number
      let queryCheck = supabase
        .from('customers')
        .select('id, customer_number' + (hasSoftDelete ? ', deleted_at' : ''))
        .eq('customer_number', customer_number.trim());

      const { data: existing, error: checkError } = await queryCheck.maybeSingle();

      if (checkError) {
        return sendError(res, 500, 'DatabaseError', 'Error al verificar disponibilidad del número de cliente.', checkError.message);
      }

      // Si existe y no está eliminado suavemente (si la columna existe)
      if (existing) {
        if (!hasSoftDelete || !existing.deleted_at) {
          return sendError(res, 409, 'Conflict', `Ya existe un contacto activo con el número de cliente '${customer_number}'.`);
        }
      }

      const payload = {
        customer_number: customer_number.trim(),
        name: name.trim(),
        whatsapp_number: whatsapp_number ? whatsapp_number.toString().trim() : null,
        sms_number: sms_number ? sms_number.toString().trim() : null,
        email: email ? email.toString().trim() : null,
        status,
        updated_at: new Date()
      };

      if (hasSoftDelete) {
        payload.deleted_at = null; // Restaurar si estaba soft-deleted
      }

      let dbResult;
      if (hasSoftDelete && existing && existing.deleted_at) {
        dbResult = await supabase
          .from('customers')
          .update(payload)
          .eq('id', existing.id)
          .select()
          .single();
      } else {
        dbResult = await supabase
          .from('customers')
          .insert([payload])
          .select()
          .single();
      }

      const { data, error } = dbResult;

      if (error) {
        console.error('[DB ERROR] Error al guardar nuevo contacto:', error.message);
        return sendError(res, 500, 'DatabaseError', 'Error al persistir el contacto en la base de datos.', error.message);
      }

      return res.status(201).json({
        success: true,
        message: 'Contacto creado exitosamente.',
        data
      });

    } catch (err) {
      console.error('[CONTACTS EXCEPTION] Error al crear contacto:', err.message);
      return sendError(res, 500, 'ServerError', 'Ocurrió un error inesperado al registrar el contacto.', err.message);
    }
  });

  /**
   * PUT /api/contacts/:id
   * Actualiza los datos de un contacto (UUID o customer_number).
   */
  router.put('/:id', async (req, res) => {
    try {
      const hasSoftDelete = await checkDbSchema();
      const { id } = req.params;
      console.log(`[CONTACTS PUT] Actualizando cliente ${id}:`, req.body);

      // 1. Buscar contacto existente
      let queryCheck = supabase.from('customers');
      if (isUUID(id)) {
        queryCheck = queryCheck.select('*').eq('id', id);
      } else {
        queryCheck = queryCheck.select('*').eq('customer_number', id);
      }

      if (hasSoftDelete) {
        queryCheck = queryCheck.is('deleted_at', null);
      }

      const { data: existing, error: checkError } = await queryCheck.maybeSingle();

      if (checkError) {
        return sendError(res, 500, 'DatabaseError', 'Error al verificar la existencia del contacto.', checkError.message);
      }

      if (!existing) {
        return sendError(res, 404, 'NotFound', `Contacto '${id}' no encontrado.`);
      }

      // 2. Validar datos de entrada (Validación parcial / flexible)
      const { isValid, errors } = validateContact(req.body, true, existing);
      if (!isValid) {
        return sendError(res, 400, 'ValidationError', 'Los datos para la actualización son incorrectos.', errors);
      }

      // 3. Preparar payload de actualización
      const { name, whatsapp_number, sms_number, email, status } = req.body;
      const updatePayload = {
        updated_at: new Date()
      };

      if (name !== undefined) updatePayload.name = name.trim();
      if (whatsapp_number !== undefined) updatePayload.whatsapp_number = whatsapp_number ? whatsapp_number.toString().trim() : null;
      if (sms_number !== undefined) updatePayload.sms_number = sms_number ? sms_number.toString().trim() : null;
      if (email !== undefined) updatePayload.email = email ? email.toString().trim() : null;
      if (status !== undefined) updatePayload.status = status;

      // 4. Ejecutar actualización en Supabase
      const { data: updated, error: updateError } = await supabase
        .from('customers')
        .update(updatePayload)
        .eq('id', existing.id)
        .select()
        .single();

      if (updateError) {
        console.error('[DB ERROR] Falló la actualización del contacto:', updateError.message);
        return sendError(res, 500, 'DatabaseError', 'Error al actualizar los datos en el servidor.', updateError.message);
      }

      return sendSuccess(res, updated, { message: 'Contacto actualizado correctamente.' });

    } catch (err) {
      console.error('[CONTACTS EXCEPTION] Error al actualizar contacto:', err.message);
      return sendError(res, 500, 'ServerError', 'Ocurrió un error inesperado al actualizar el contacto.', err.message);
    }
  });

  /**
   * DELETE /api/contacts/:id
   * Soft delete de un contacto. Asigna deleted_at = NOW() en lugar de borrar la fila física.
   */
  router.delete('/:id', async (req, res) => {
    try {
      const hasSoftDelete = await checkDbSchema();
      
      if (!hasSoftDelete) {
        return sendError(
          res, 
          400, 
          'SchemaIncomplete', 
          'La funcionalidad de Soft Delete requiere que apliques la migración en tu base de datos Supabase.', 
          'Por favor, ejecuta el script SQL contenido en el archivo "migration_add_deleted_at.sql" en tu panel de control de Supabase.'
        );
      }

      const { id } = req.params;
      console.log(`[CONTACTS DELETE] Petición de eliminación suave para: ${id}`);

      // 1. Identificar registro
      let queryCheck = supabase.from('customers');
      if (isUUID(id)) {
        queryCheck = queryCheck.select('id, name, deleted_at').eq('id', id);
      } else {
        queryCheck = queryCheck.select('id, name, deleted_at').eq('customer_number', id);
      }

      const { data: existing, error: checkError } = await queryCheck.maybeSingle();

      if (checkError) {
        return sendError(res, 500, 'DatabaseError', 'Error al validar la existencia del contacto.', checkError.message);
      }

      if (!existing) {
        return sendError(res, 404, 'NotFound', `El contacto '${id}' no existe en la base de datos.`);
      }

      if (existing.deleted_at) {
        return sendError(res, 400, 'BadRequest', `El contacto '${existing.name}' ya se encontraba eliminado suavemente.`);
      }

      // 2. Realizar soft-delete aplicando timestamp en deleted_at
      const { error: deleteError } = await supabase
        .from('customers')
        .update({
          deleted_at: new Date(),
          updated_at: new Date()
        })
        .eq('id', existing.id);

      if (deleteError) {
        console.error('[DB ERROR] Error al aplicar soft-delete en Supabase:', deleteError.message);
        return sendError(res, 500, 'DatabaseError', 'No se pudo dar de baja el contacto.', deleteError.message);
      }

      return sendSuccess(res, { id: existing.id }, { message: `Contacto '${existing.name}' dado de baja exitosamente (Soft Delete).` });

    } catch (err) {
      console.error('[CONTACTS EXCEPTION] Error en soft-delete de contacto:', err.message);
      return sendError(res, 500, 'ServerError', 'Ocurrió un error inesperado al eliminar el contacto.', err.message);
    }
  });

  /**
   * POST /api/contacts/upload-csv
   * Mantiene compatibilidad total con la carga CSV bulk original
   */
  router.post('/upload-csv', async (req, res) => {
    const { rows } = req.body;

    console.log(`[CSV UPLOAD] Solicitud de carga recibida. Total filas: ${rows ? rows.length : 0}`);

    if (!rows || !Array.isArray(rows)) {
      return sendError(res, 400, 'BadRequest', 'El cuerpo de la petición debe contener un arreglo de filas en la propiedad "rows".');
    }

    if (rows.length > 500) {
      return sendError(res, 400, 'LimitExceeded', 'El archivo supera el límite de 500 contactos permitidos por carga.');
    }

    try {
      const hasSoftDelete = await checkDbSchema();
      const validRows = [];
      const errors = [];
      let skipped = 0;

      rows.forEach((row, index) => {
        const rowNum = index + 1;
        const name = row.name ? row.name.trim() : null;
        const customer_number = row.customer_number ? row.customer_number.trim() : null;
        
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

        const payloadRow = {
          customer_number,
          name,
          whatsapp_number: whatsapp || null,
          sms_number: sms || null,
          email: email || null,
          status: row.status || 'active',
          updated_at: new Date()
        };

        if (hasSoftDelete) {
          payloadRow.deleted_at = null; // Si se vuelve a subir por CSV, se reactiva
        }

        validRows.push(payloadRow);
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

      const { data, error: dbError } = await supabase
        .from('customers')
        .upsert(validRows, { onConflict: 'customer_number' })
        .select('id, customer_number');

      if (dbError) {
        console.error('[DB ERROR] Falló la inserción en lote en Supabase:', dbError.message);
        return sendError(res, 500, 'DatabaseError', 'Error al persistir los datos en Supabase.', dbError.message);
      }

      console.log(`[DB] Carga bulk exitosa. ${validRows.length} registros cargados/actualizados.`);

      return res.status(200).json({
        success: true,
        message: 'Procesamiento de carga completado.',
        total: rows.length,
        created: validRows.length,
        skipped,
        errors: errors.slice(0, 20),
        summary: `Se cargaron/actualizaron exitosamente ${validRows.length} clientes en el sistema.`
      });

    } catch (error) {
      console.error('[CSV UPLOAD EXCEPTION] Error en controlador de carga:', error.message);
      return sendError(res, 500, 'ServerError', 'Ocurrió un error inesperado al procesar la carga de clientes.', error.message);
    }
  });

  return router;
};
