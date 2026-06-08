import { db } from '../lib/firebaseAdmin.js';
import { verifyAuth } from '../lib/auth.js';
import { sanitizePayload } from '../lib/sanitize.js';
import { Resend } from 'resend';

export default async function handler(request, response) {
    const { action, id, evoId } = request.query;

    // 🛡️ CONTROL DE SEGURIDAD: Identificamos si la acción es para el paciente (pública) o para el terapeuta (privada)
    const isPublicAction = (action === 'getPublicEvo' || action === 'saveEvoSignature');

    if (!isPublicAction) {
        if (!verifyAuth(request)) {
            return response.status(401).json({ message: 'Acceso Denegado. Sesión inválida, inexistente o expirada.' });
        }
    }

    try {
        if (request.method === 'GET') {
            // Acción pública: Obtener datos básicos de una sesión para que el paciente la firme
            if (action === 'getPublicEvo') {
                if (!id || !evoId) return response.status(400).json({ message: 'Faltan parámetros.' });
                
                // Necesitamos el nombre del paciente y la evolución
                const docHist = await db.collection('historias_clinicas').doc(id).get();
                if (!docHist.exists) return response.status(404).json({ message: 'Historia no encontrada.' });
                
                const dataHist = docHist.data();
                let fechaEvo, cierreEvo, yaFirmadoEvo;

                if (evoId === 'sesionCero') {
                    fechaEvo = dataHist.fechaSesionCero || new Date().toISOString().split('T')[0];
                    cierreEvo = dataHist.cierreSesionCero || 'Encuadre y diagnóstico inicial (Sesión 0).';
                    yaFirmadoEvo = !!dataHist.firmaSesionCero;
                } else {
                    const evolucion = (dataHist.evoluciones || []).find(e => e.id === evoId);
                    if (!evolucion) return response.status(404).json({ message: 'Sesión no encontrada.' });
                    fechaEvo = evolucion.fecha;
                    cierreEvo = evolucion.cierre || 'Continuación de proceso terapéutico.';
                    yaFirmadoEvo = !!evolucion.firmaPaciente;
                }

                // Traer nombre del paciente desde consents
                let nombrePaciente = "Paciente";
                const docIndiv = await db.collection('consents').doc(id).get();
                if (docIndiv.exists) {
                    nombrePaciente = docIndiv.data().demograficos?.nombre || "Paciente";
                } else {
                    const docPareja = await db.collection('consents_parejas').doc(id).get();
                    if (docPareja.exists) {
                        const d = docPareja.data();
                        const n1 = d.paciente1?.nombre || d.demograficos?.nombreCompleto1 || "P1";
                        const n2 = d.paciente2?.nombre || d.demograficos?.nombreCompleto2 || "P2";
                        nombrePaciente = `${n1.split(' ')[0]} y ${n2.split(' ')[0]}`;
                    }
                }

                // Devolvemos solo lo necesario, NO toda la historia
                return response.status(200).json({
                    fecha: fechaEvo,
                    cierre: cierreEvo,
                    nombre: nombrePaciente,
                    yaFirmado: yaFirmadoEvo
                });
            }

            // Acción Privada: Obtener historia completa para el terapeuta
            if (!id) return response.status(400).json({ message: 'Falta el ID del paciente.' });
            
            const doc = await db.collection('historias_clinicas').doc(id).get();
            if (!doc.exists) {
                return response.status(200).json({ isNew: true });
            }
            return response.status(200).json(doc.data());
        }

        if (request.method === 'POST') {
            const data = sanitizePayload(request.body);

            // Acción Pública: Guardar la firma del paciente en una evolución específica y disparar correos
            if (action === 'saveEvoSignature') {
                if (!data.pacienteId || !data.evoId || !data.firmaDigital) return response.status(400).json({ message: 'Faltan datos de firma.' });
                
                const docRef = db.collection('historias_clinicas').doc(data.pacienteId);
                const doc = await docRef.get();
                if (!doc.exists) return response.status(404).json({ message: 'Historia no encontrada.' });

                const dataHist = doc.data();
                let fechaSesionMail = "";

                if (data.evoId === 'sesionCero') {
                    await docRef.set({
                        firmaSesionCero: data.firmaDigital,
                        fechaFirmaSesionCero: new Date().toISOString(),
                        userAgentFirmaSesionCero: request.headers['user-agent'] || 'Desconocido'
                    }, { merge: true });
                    fechaSesionMail = dataHist.fechaSesionCero || new Date().toISOString().split('T')[0];
                } else {
                    let evoluciones = dataHist.evoluciones || [];
                    const evoIndex = evoluciones.findIndex(e => e.id === data.evoId);
                    if (evoIndex === -1) return response.status(404).json({ message: 'Evolución no encontrada.' });

                    evoluciones[evoIndex].firmaPaciente = data.firmaDigital;
                    evoluciones[evoIndex].fechaFirmaPaciente = new Date().toISOString();
                    evoluciones[evoIndex].userAgentFirma = request.headers['user-agent'] || 'Desconocido';

                    await docRef.set({ evoluciones: evoluciones }, { merge: true });
                    fechaSesionMail = evoluciones[evoIndex].fecha;
                }

                // --- ENVÍO DE CORREOS DE CONFIRMACIÓN (RESEND) ---
                const resendApiKey = process.env.RESEND2_API_KEY;
                if (resendApiKey) {
                    const resend = new Resend(resendApiKey);
                    
                    // Buscar email del paciente
                    let emailPaciente = "";
                    let nombreCompleto = "";
                    const docIndiv = await db.collection('consents').doc(data.pacienteId).get();
                    if (docIndiv.exists) {
                        emailPaciente = docIndiv.data().demograficos?.email;
                        nombreCompleto = docIndiv.data().demograficos?.nombre;
                    } else {
                        const docPareja = await db.collection('consents_parejas').doc(data.pacienteId).get();
                        if (docPareja.exists) {
                            emailPaciente = docPareja.data().paciente1?.email || docPareja.data().demograficos?.email1;
                            nombreCompleto = "Pareja";
                        }
                    }

                    if (emailPaciente) {
                        const fechaSesion = new Date(`${fechaSesionMail}T12:00:00`).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
                        
                        const htmlContent = `
                            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 10px; overflow: hidden;">
                                <div style="background-color: #10b981; padding: 20px; text-align: center;">
                                    <h2 style="color: white; margin: 0;">Validación de Sesión Exitosa</h2>
                                </div>
                                <div style="padding: 30px;">
                                    <h3 style="color: #003366;">Confirmación de Servicio</h3>
                                    <p>Este correo certifica que la sesión psicológica programada para la fecha <strong>${fechaSesion}</strong> se ha realizado a entera satisfacción.</p>
                                    <div style="background-color: #f4f6f8; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0;">
                                        <p style="margin: 0 0 10px 0;"><strong>ID de Seguridad (No Repudio):</strong><br><span style="font-family: monospace; font-size: 11px; color: #666;">${data.pacienteId}-${data.evoId}</span></p>
                                        <p style="margin: 0;"><strong>Registro Digital:</strong> Firma capturada correctamente.</p>
                                    </div>
                                    <p style="font-size: 12px; color: #666; margin-top: 30px;">Gracias por confiar en Caminos del Ser - Gestión Existencial.</p>
                                </div>
                            </div>
                        `;

                        // Enviar al paciente
                        await resend.emails.send({
                            from: 'Caminos del Ser <caminosdelser@emcotic.com>',
                            to: emailPaciente,
                            subject: `✅ Confirmación de Sesión Realizada - ${fechaSesion}`,
                            html: htmlContent
                        });

                        // Enviar al terapeuta (Soporte legal)
                        await resend.emails.send({
                            from: 'Sistema CInformado <caminosdelser@emcotic.com>',
                            to: 'caminosdelser@emcotic.com',
                            subject: `Validación de Sesión: ${nombreCompleto || 'Paciente'}`,
                            html: `<p>El paciente ha validado con firma digital la sesión del ${fechaSesion}.</p><p>La firma y el User-Agent se han adjuntado a la historia clínica de forma segura para efectos de auditoría legal.</p>`
                        });
                    }
                }

                return response.status(200).json({ message: 'Firma guardada correctamente.' });
            }

            switch (action) {
                case 'saveHistoria':
                    if (!data.pacienteId) return response.status(400).json({ message: 'Falta ID.' });
                    const historiaData = {
                        fechaSesionCero: data.fechaSesionCero || '',
                        valorSesionCero: Number(data.valorSesionCero) || 0,
                        pagadoSesionCero: data.pagadoSesionCero === true,
                        contextoVital: {
                            ocupacion: data.ocupacion || '', convivencia: data.convivencia || '', hobbies: data.hobbies || '', noHobbies: data.noHobbies || '', antecedentesMedicos: data.antecedentesMedicos || ''
                        },
                        halcon: {
                            motivoConsulta: data.motivoConsulta || '', habilidades: data.habilidades || '', aspiracion: data.aspiracion || '', creencias: data.creencias || '', construccion: data.construccion || '', orientacion: data.orientacion || '', nutricion: data.nutricion || ''
                        },
                        cierreSesionCero: data.cierreSesionCero || '',
                        acuerdoStrikes: data.acuerdoStrikes === true,
                        ultimaActualizacion: new Date().toISOString()
                    };
                    await db.collection('historias_clinicas').doc(data.pacienteId).set(historiaData, { merge: true });
                    return response.status(200).json({ message: 'Sesión Cero guardada.' });

                case 'savePlan':
                    if (!data.pacienteId) return response.status(400).json({ message: 'Falta ID.' });
                    await db.collection('historias_clinicas').doc(data.pacienteId).set({ planTrabajo: data.planTrabajo || [], ultimaActualizacionPlan: new Date().toISOString() }, { merge: true });
                    return response.status(200).json({ message: 'Plan de trabajo guardado.' });

                case 'saveEvolucion':
                    if (!data.pacienteId) return response.status(400).json({ message: 'Falta ID.' });
                    await db.collection('historias_clinicas').doc(data.pacienteId).set({ evoluciones: data.evoluciones || [], strikes: data.strikes || 0, ultimaActualizacionEvo: new Date().toISOString() }, { merge: true });
                    return response.status(200).json({ message: 'Bitácora guardada.' });

                case 'savePerfil':
                    if (!data.pacienteId) return response.status(400).json({ message: 'Falta ID.' });
                    await db.collection('historias_clinicas').doc(data.pacienteId).set({ perfilEjecutivo: data.perfilEjecutivo || '', propositoVida: data.propositoVida || '', ultimaActualizacionPerfil: new Date().toISOString() }, { merge: true });
                    return response.status(200).json({ message: 'Perfil y propósito guardados.' });

                default:
                    return response.status(400).json({ message: 'Acción POST no reconocida.' });
            }
        }

        return response.status(405).json({ message: 'Método no soportado.' });

    } catch (error) {
        console.error("Error en controlador de historia:", error);
        return response.status(500).json({ message: 'Error interno del servidor.', detail: error.message });
    }
}
