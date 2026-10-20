# DIRECCIONES 2

Gestión de direcciones de envío para estudiantes.

## Uso
Abre https://docentesfundetec-ctrl.github.io/DIRECCIONES-2/ e ingresa con Google.
La cuenta administrativa autorizada es docentesfundetec@gmail.com.
Los estudiantes solicitan acceso con Google y solo consultan su registro después
de que la administración verifica su identidad y autoriza la cuenta.

## Datos y seguridad
- Los registros se guardan en Cloud Firestore, proyecto `direcciones-2-1bbeb`.
- Las reglas de `firestore.rules` deben estar publicadas en Firebase.
- La configuración web de Firebase es pública; no otorga acceso a los datos.
- No subir copias JSON, Excel, contraseñas o datos personales a este repositorio.
- Las importaciones agregan o actualizan por documento; conservan los otros registros.
- Las eliminaciones afectan a la base de datos compartida y requieren confirmación.
- Las escrituras requieren conexión; los formularios verifican versiones para evitar
  sobrescribir ediciones simultáneas.
- La sesión de Google se conserva durante la sesión del navegador.

## Publicación
GitHub Pages desde la rama `main`, carpeta raíz. No requiere compilación.
Firebase Authentication usa Google y autoriza `docentesfundetec-ctrl.github.io`.
El proyecto usa el plan Spark. Si se alcanza una cuota, Firebase puede rechazar
operaciones; la página muestra el error y no confirma un guardado fallido.
