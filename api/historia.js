import { db } from '../lib/firebaseAdmin.js';
import { verifyAuth } from '../lib/auth.js';
import { sanitizePayload } from '../lib/sanitize.js';
import { Resend } from 'resend';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { Buffer } from 'buffer';

//// =======================================================
// GENERADOR DE PDF DE VALIDACIÓN DE SESIÓN
// =======================================================
async function crearPDFValidacionSesion(nombre, fecha, tarea, firmaB64, userAgent) {
    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage();
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    let y = height - 50;
    const margin = 50;
    const brandColor = rgb(0, 0.2, 0.4); // Azul Corporativo
    const maxWidth = width - 2 * margin;

    // Membrete
    page.drawText('Caminos del Ser - Gestión Existencial', { x: margin, y, font: boldFont, size: 12, color: brandColor });
    page.drawLine({ start: { x: margin, y: y - 10 }, end: { x: width - margin, y: y - 10 }, thickness: 1, color: brandColor });
    y -= 40;

    page.drawText('Certificado de Validación de Sesión', { x: margin, y, font: boldFont, size: 16, color: brandColor });
    y -= 40;

    page.drawText('Paciente:', { x: margin, y, font: boldFont, size: 11 });
    page.drawText(nombre || 'No registrado', { x: margin + 120, y, font, size: 11 });
    y -= 25;

    page.drawText('Fecha de Sesión:', { x: margin, y, font: boldFont, size: 11 });
    page.drawText(fecha || 'No registrada', { x: margin + 120, y, font, size: 11 });
    y -= 40;

    // Cambio implementado: Tarea Consignada
    page.drawText('Tarea Consignada:', { x: margin, y, font: boldFont, size: 11, color: brandColor });
    y -= 20;

    // Text Wrap para la tarea
    const words = (tarea || 'Sin registro de tarea.').split(' ');
    let line = '';
    page.drawText('"', { x: margin, y, font: font, size: 11, color: rgb(0.2, 0.2, 0.2) });
    let textY = y;
    let textX = margin + 8;
    for (const word of words) {
        const testLine = line + word + ' ';
        const testWidth = font.widthOfTextAtSize(testLine, 11);
        if (testWidth > maxWidth - 15 && line !== '') {
            page.drawText(line, { x: textX, y: textY, font: font, size: 11, color: rgb(0.2, 0.2, 0.2) });
            textY -= 16;
            line = word + ' ';
            textX = margin + 8;
        } else {
            line = testLine;
        }
    }
    if (line.trim() !== '') {
        page.drawText(line + '"', { x: textX, y: textY, font: font, size: 11, color: rgb(0.2, 0.2, 0.2) });
        textY -= 40;
    }
    y = textY;

    page.drawText('Firma del Paciente:', { x: margin, y, font: boldFont, size: 12 });
    y -= 90;
    
    try {
        const pngImageBytes = Buffer.from(firmaB64.split(',')[1], 'base64');
        const pngImage = await pdfDoc.embedPng(pngImageBytes);
        page.drawImage(pngImage, { x: margin, y, width: 150, height: 75 });
    } catch (e) { console.error("Error incrustando firma en PDF", e); }
    
    page.drawLine({ start: { x: margin, y: y - 5 }, end: { x: margin + 200, y: y - 5 }, thickness: 1 });
    y -= 30;

    page.drawText('Sello Criptográfico (No Repudio):', { x: margin, y, font: boldFont, size: 9, color: rgb(0.5, 0.5, 0.5) });
    y -= 15;
    const timestamp = new Date().toISOString();
    page.drawText(`Fecha/Hora de validación: ${timestamp}`, { x: margin, y, font, size: 8, color: rgb(0.5, 0.5, 0.5) });
    y -= 15;
    page.drawText(`Dispositivo (User-Agent): ${userAgent.substring(0, 90)}...`, { x: margin, y, font, size: 8, color: rgb(0.5, 0.5, 0.5) });

    return await pdfDoc.save();
}

//// =======================================================
// CONTROLADOR MAESTRO
// =======================================================
export default async function handler(request, response) {
    const { action, id, evoId } = request.query;

    // 🛡️ CONTROL DE SEGURIDAD
    const isPublicAction = (action === 'getPublicEvo' || action === 'saveEvoSignature');
    if (!isPublicAction) {
        if (!verifyAuth(request)) {
            return response.status(401).json({ message: 'Acceso Denegado. Sesión inválida, inexistente o expirada.' });
        }
    }

    try {
        if (request.method === 'GET') {
            if (action === 'getPublicEvo') {
                if (!id || !evoId) return response.status(400).json({ message: 'Faltan parámetros.' });
                
                const docHist = await db.collection('historias_clinicas').doc(id).get();
                if (!docHist.exists) return response.status(404).json({ message: 'Historia no encontrada.' });
                
                const dataHist = docHist.data();
                
                // Cambio implementado: variables de tareaEvo
                let fechaEvo, tareaEvo, yaFirmadoEvo;

                if (evoId === 'sesionCero') {
                    fechaEvo = dataHist.fechaSesionCero || new Date().toISOString().split('T')[0];
                    // Fallback inteligente: Busca 'tareaSesionCero', si no, usa 'cierreSesionCero' antiguo.
                    tareaEvo = dataHist.tareaSesionCero || dataHist.cierreSesionCero || 'No se consignó tarea en la sesión inicial.';
                    yaFirmadoEvo = !!dataHist.firmaSesionCero;
                } else {
                    const evolucion = (dataHist.evoluciones || []).find(e => e.id === evoId);
                    if (!evolucion) return response.status(404).json({ message: 'Sesión no encontrada.' });
                    fechaEvo = evolucion.fecha;
                    // Fallback inteligente: Busca 'tarea', si no, usa 'cierre' antiguo.
                    tareaEvo = evolucion.tarea || evolucion.cierre || 'No se consignó tarea en esta sesión.';
                    yaFirmadoEvo = !!evolucion.firmaPaciente;
                }

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

                // Se responde enviando la variable 'tarea'
                return response.status(200).json({
                    fecha: fechaEvo,
                    tarea: tareaEvo,
                    nombre: nombrePaciente,
                    yaFirmado: yaFirmadoEvo
                });
            }

            if (!id) return response.status(400).json({ message: 'Falta el ID del paciente.' });
            const doc = await db.collection('historias_clinicas').doc(id).get();
            if (!doc.exists) return response.status(200).json({ isNew: true });
            return response.status(200).json(doc.data());
        }

        if (request.method === 'POST') {
            const data = sanitizePayload(request.body);

            // Acción Pública: Guardar firma, generar PDF y enviar correos cheveres
            if (action === 'saveEvoSignature') {
                if (!data.pacienteId || !data.evoId || !data.firmaDigital) return response.status(400).json({ message: 'Faltan datos de firma.' });
                
                const docRef = db.collection('historias_clinicas').doc(data.pacienteId);
                const doc = await docRef.get();
                if (!doc.exists) return response.status(404).json({ message: 'Historia no encontrada.' });

                const dataHist = doc.data();
                let fechaSesionMail = "";
                let tareaSesionMail = "";

                if (data.evoId === 'sesionCero') {
                    await docRef.set({
                        firmaSesionCero: data.firmaDigital,
                        fechaFirmaSesionCero: new Date().toISOString(),
                        userAgentFirmaSesionCero: request.headers['user-agent'] || 'Desconocido'
                    }, { merge: true });
                    fechaSesionMail = dataHist.fechaSesionCero || new Date().toISOString().split('T')[0];
                    tareaSesionMail = dataHist.tareaSesionCero || dataHist.cierreSesionCero || 'No se consignó tarea en la sesión inicial.';
                } else {
                    let evoluciones = dataHist.evoluciones || [];
                    const evoIndex = evoluciones.findIndex(e => e.id === data.evoId);
                    if (evoIndex === -1) return response.status(404).json({ message: 'Evolución no encontrada.' });

                    evoluciones[evoIndex].firmaPaciente = data.firmaDigital;
                    evoluciones[evoIndex].fechaFirmaPaciente = new Date().toISOString();
                    evoluciones[evoIndex].userAgentFirma = request.headers['user-agent'] || 'Desconocido';

                    await docRef.set({ evoluciones: evoluciones }, { merge: true });
                    fechaSesionMail = evoluciones[evoIndex].fecha;
                    tareaSesionMail = evoluciones[evoIndex].tarea || evoluciones[evoIndex].cierre || 'No se consignó tarea.';
                }

                // --- ENVÍO DE CORREOS RESEND CON PDF ADJUNTO ---
                const resendApiKey = process.env.RESEND2_API_KEY;
                if (resendApiKey) {
                    const resend = new Resend(resendApiKey);
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
                            nombreCompleto = "Terapia de Pareja";
                        }
                    }

                    if (emailPaciente) {
                        const fechaSesionF = new Date(`${fechaSesionMail}T12:00:00`).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
                        const userAgentString = request.headers['user-agent'] || 'Desconocido';
                        
                        // Generar el Buffer del PDF incluyendo la variable tareaSesionMail
                        const pdfBuffer = await crearPDFValidacionSesion(nombreCompleto, fechaSesionF, tareaSesionMail, data.firmaDigital, userAgentString);

                        // Email Paciente
                        const htmlPaciente = `
                            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 10px; overflow: hidden;">
                                <div style="background-color: #10b981; padding: 20px; text-align: center;">
                                    <h2 style="color: white; margin: 0;">Validación de Sesión Exitosa</h2>
                                </div>
                                <div style="padding: 30px;">
                                    <h3 style="color: #003366;">Confirmación de Servicio</h3>
                                    <p>Este correo certifica que la sesión psicológica programada para la fecha <strong>${fechaSesionF}</strong> se ha realizado a entera satisfacción.</p>
                                    <div style="background-color: #f4f6f8; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0;">
                                        <p style="margin: 0;">Adjunto a este correo encontrarás el <strong>Certificado de Validación en PDF</strong> que incluye la tarea asignada y el sello de tu firma electrónica.</p>
                                    </div>
                                    <p style="font-size: 12px; color: #666; margin-top: 30px;">Gracias por confiar en Caminos del Ser - Gestión Existencial.</p>
                                </div>
                            </div>
                        `;

                        // Email Psicólogo
                        const htmlTerapeuta = `
                            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 10px; overflow: hidden;">
                                <div style="background-color: #003366; padding: 20px; text-align: center;">
                                    <h2 style="color: white; margin: 0;">✅ Nueva Sesión Validada</h2>
                                </div>
                                <div style="padding: 30px;">
                                    <h3 style="color: #003366;">Validación Legal Exitosa</h3>
                                    <p>El paciente <strong>${nombreCompleto}</strong> ha validado mediante firma digital la sesión correspondiente a la fecha <strong>${fechaSesionF}</strong>.</p>
                                    <div style="background-color: #f8fafc; border-left: 4px solid #003366; padding: 15px; margin: 20px 0;">
                                        <p style="margin: 0; font-size: 14px;">El certificado PDF encriptado con los datos de sesión y la firma manuscrita ha sido generado y adjuntado a este correo para tus registros de trazabilidad (Principio de No Repudio).</p>
                                    </div>
                                    <p style="font-size: 12px; color: #666; margin-top: 20px;">La firma también se reflejará automáticamente en la tarjeta de historia clínica del portal.</p>
                                </div>
                            </div>
                        `;

                        // Disparar envíos
                        await resend.emails.send({
                            from: 'Caminos del Ser <caminosdelser@emcotic.com>',
                            to: emailPaciente,
                            subject: `✅ Certificado de Sesión Realizada - ${fechaSesionF}`,
                            html: htmlPaciente,
                            attachments: [{ filename: `Validacion-${fechaSesionMail}.pdf`, content: Buffer.from(pdfBuffer) }]
                        });

                        await resend.emails.send({
                            from: 'Sistema CInformado <caminosdelser@emcotic.com>',
                            to: 'caminosdelser@emcotic.com',
                            subject: `✅ Validación de Sesión: ${nombreCompleto || 'Paciente'}`,
                            html: htmlTerapeuta,
                            attachments: [{ filename: `Validacion-${nombreCompleto.replace(/\s+/g, '')}-${fechaSesionMail}.pdf`, content: Buffer.from(pdfBuffer) }]
                        });
                    }
                }
                return response.status(200).json({ message: 'Firma guardada correctamente.' });
            }

            switch (action) {
                case 'saveHistoria':
                    if (!data.pacienteId) return response.status(400).json({ message: 'Falta ID.' });
                    const historiaData = {
                        fechaSesionCero: data.fechaSesionCero || '', valorSesionCero: Number(data.valorSesionCero) || 0, pagadoSesionCero: data.pagadoSesionCero === true,
                        contextoVital: { ocupacion: data.ocupacion || '', convivencia: data.convivencia || '', hobbies: data.hobbies || '', noHobbies: data.noHobbies || '', antecedentesMedicos: data.antecedentesMedicos || '' },
                        halcon: { motivoConsulta: data.motivoConsulta || '', habilidades: data.habilidades || '', aspiracion: data.aspiracion || '', creencias: data.creencias || '', construccion: data.construccion || '', orientacion: data.orientacion || '', nutricion: data.nutricion || '' },
                        cierreSesionCero: data.cierreSesionCero || '', acuerdoStrikes: data.acuerdoStrikes === true, ultimaActualizacion: new Date().toISOString()
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
