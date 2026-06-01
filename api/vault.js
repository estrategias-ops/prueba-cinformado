import { db } from '../lib/firebaseAdmin.js';

export default async function handler(request, response) {
    try {
        // ==========================================
        // MÉTODO GET: GENERAR Y DESCARGAR BACKUP
        // ==========================================
        if (request.method === 'GET') {
            const backupData = {
                fechaBackup: new Date().toISOString(),
                metadata: {
                    totalConsentimientosIndividuales: 0,
                    totalConsentimientosParejas: 0,
                    totalHistoriasClinicas: 0
                },
                colecciones: {
                    consents: {},
                    consents_parejas: {},
                    historias_clinicas: {}
                }
            };

            // Leer todas las colecciones al mismo tiempo
            const [consentsSnap, parejasSnap, historiasSnap] = await Promise.all([
                db.collection('consents').get(),
                db.collection('consents_parejas').get(),
                db.collection('historias_clinicas').get()
            ]);

            consentsSnap.forEach(doc => { backupData.colecciones.consents[doc.id] = doc.data(); backupData.metadata.totalConsentimientosIndividuales++; });
            parejasSnap.forEach(doc => { backupData.colecciones.consents_parejas[doc.id] = doc.data(); backupData.metadata.totalConsentimientosParejas++; });
            historiasSnap.forEach(doc => { backupData.colecciones.historias_clinicas[doc.id] = doc.data(); backupData.metadata.totalHistoriasClinicas++; });

            // Configurar la descarga del archivo en el navegador
            const dateStr = new Date().toISOString().split('T')[0];
            const fileName = `Backup_CaminosDelSer_${dateStr}.json`;

            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

            return response.status(200).send(JSON.stringify(backupData, null, 2));
        }
        
        // ==========================================
        // MÉTODO POST: RESTAURAR BASE DE DATOS
        // ==========================================
        else if (request.method === 'POST') {
            const { backupData, pinSeguridad } = request.body;

            // 🛡️ PROTECCIÓN EXTREMA (A prueba de espacios fantasmas y leyendo Vercel)
            const masterPin = (process.env.MASTER_PIN || 'JAC-RESCATE-2026').trim();
            const inputPin = (pinSeguridad || '').trim();

            if (inputPin !== masterPin) {
                return response.status(401).json({ message: 'Acceso Denegado. PIN de seguridad incorrecto.' });
            }

            if (!backupData || !backupData.colecciones) {
                return response.status(400).json({ message: 'El archivo JSON cargado es inválido o está corrupto.' });
            }

            const colecciones = ['consents', 'consents_parejas', 'historias_clinicas'];
            let docsRestaurados = 0;

            // Bucle de restauración: reescribe la base de datos
            for (const col of colecciones) {
                const registros = backupData.colecciones[col];
                if (registros) {
                    for (const [docId, docData] of Object.entries(registros)) {
                        await db.collection(col).doc(docId).set(docData);
                        docsRestaurados++;
                    }
                }
            }

            return response.status(200).json({ message: 'Base de datos restaurada con éxito.', total: docsRestaurados });
        } 
        
        // Método no soportado
        else {
            return response.status(405).json({ message: 'Método no permitido.' });
        }

    } catch (error) {
        console.error("Error en la Bóveda de Seguridad:", error);
        return response.status(500).json({ message: 'Error interno del servidor.', detail: error.message });
    }
}
