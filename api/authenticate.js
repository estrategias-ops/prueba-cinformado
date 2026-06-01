/**
 * Handler para la función serverless de autenticación.
 * Esta función se ejecuta en el servidor, no en el navegador del cliente.
 */
export default async function handler(request, response) {
    // 1. Solo aceptamos peticiones de tipo POST.
    if (request.method !== 'POST') {
        return response.status(405).json({ success: false, message: 'Método no permitido.' });
    }

    try {
        // 2. Leemos la contraseña que el usuario envió en el cuerpo de la petición.
        const { password } = request.body;

        // 3. Obtenemos la contraseña CORRECTA desde las variables de entorno de Vercel.
        // Esta variable 'LOGIN_PASS' NUNCA es visible para el cliente.
        const correctPassword = process.env.LOGIN_PASS;

        if (!correctPassword) {
            // Error de configuración del servidor, la variable no está definida.
            console.error("CRITICAL: La variable de entorno LOGIN_PASS no está configurada en Vercel.");
            return response.status(500).json({ success: false, message: 'Error de configuración del servidor.' });
        }

        // 4. Comparamos la contraseña enviada con la correcta.
        if (password === correctPassword) {
            // Si coinciden, enviamos una respuesta exitosa.
            return response.status(200).json({ success: true });
        } else {
            // Si NO coinciden, enviamos un error de "No autorizado".
            return response.status(401).json({ success: false, message: 'Contraseña incorrecta.' });
        }

    } catch (error) {
        // Manejo de errores inesperados.
        console.error("Error en la función de autenticación:", error);
        return response.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
}
