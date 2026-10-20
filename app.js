import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, getDoc, getDocsFromServer, setDoc,
  runTransaction, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const labels = [
  ["name", "Nombres y apellidos completos"],
  ["documentType", "Tipo de documento"],
  ["documentNumber", "Número de documento de identidad"],
  ["phone", "Número de teléfono"],
  ["department", "Departamento"],
  ["municipality", "Municipio"],
  ["neighborhood", "Barrio de residencia"],
  ["address", "Dirección (nomenclatura)"],
  ["reference", "Referencia"],
  ["shippingMethod", "Desea envío a oficina de Interrapidísimo o envío contraentrega (debe tener en cuenta la guía de envío)"],
  ["program", "Carrera o programa que está cursando actualmente"]
];
const shippingOptions = ["Envío a oficina de Interrapidísimo", "Envío contraentrega"];
const emptyDraft = Object.fromEntries(labels.map(([key]) => [key, ""]));

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const ADMIN_EMAIL = "docentesfundetec@gmail.com";
const studentCollection = collection(db, "students");
let role = null, student = null, user = null;
let students = [], requests = [], accessLinks = [];
let adminLogged = false, adminMenuOpen = false;
let editingId = null, editingVersion = null, editingDraft = null, showEditor = false;
let searchQuery = "", message = "", messageKind = "notice";
let busy = false, loading = true, synced = false, ready = false;
let stopListeners = [], studentState = "loading", ownRequest = null, studentGeneration = 0;

function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, match => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[match]));
}
function newId() { return crypto.randomUUID(); }
function setMessage(text, kind = "notice") { message = text; messageKind = kind; }
function resetMessage() { message = ""; messageKind = "notice"; }
function renderMessage() {
  return message ? '<p class="notice ' + escapeHtml(messageKind) + '" role="status">' + escapeHtml(message) + '</p>' : "";
}
function dataFields(record) {
  return Object.fromEntries(labels.map(([key]) => [key, String(record[key] ?? "").trim()]));
}
function errorMessage(error) {
  const code = error.code || "";
  if (code.includes("popup-closed") || code.includes("cancelled-popup")) return "Se canceló el inicio de sesión.";
  if (code.includes("popup-blocked")) return "Permite la ventana de Google en tu navegador y vuelve a intentarlo.";
  if (code.includes("unauthorized-domain")) return "Este dominio aún no está autorizado para iniciar sesión.";
  if (code.includes("permission-denied")) return "Tu cuenta no tiene permiso para esta operación.";
  if (code.includes("unavailable") || code.includes("network")) return "No se pudo conectar con Firebase. Revisa tu conexión e inténtalo nuevamente.";
  return error.message || "No fue posible completar la operación.";
}
async function perform(action, success) {
  if (busy) return;
  if (!navigator.onLine) { alert("Conéctate a Internet para guardar los cambios."); return; }
  busy = true;
  updateBusy();
  try {
    await action();
    if (success) setMessage(typeof success === "function" ? success() : success, "ok");
  } catch (error) {
    setMessage(errorMessage(error));
    // Preserve unsaved fields when a write fails.
    if (showEditor) {
      const form = document.getElementById("student-editor");
      if (form) editingDraft = dataFields(Object.fromEntries(new FormData(form)));
    }
  } finally { busy = false; render(); }
}
function updateBusy() {
  document.querySelectorAll("button, input, select, textarea").forEach(element => { element.disabled = busy; });
}
async function login(nextRole) {
  role = nextRole;
  resetMessage();
  await perform(async () => {
    await setPersistence(auth, browserSessionPersistence);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  });
}
async function logout() {
  await perform(async () => { await signOut(auth); role = null; resetMessage(); });
}
function setRole(nextRole) {
  role = nextRole;
  closeEditor(false);
  resetMessage();
  render();
}
function closeEditor(redraw = true) {
  showEditor = false; editingId = null; editingVersion = null; editingDraft = null;
  if (redraw) render();
}
function startSession(nextUser) {
  studentGeneration++;
  stopListeners.forEach(stop => stop());
  stopListeners = [];
  user = nextUser;
  adminLogged = !!user && user.emailVerified && user.email?.toLowerCase() === ADMIN_EMAIL;
  students = []; requests = []; accessLinks = []; student = null; ownRequest = null;
  loading = !!user; synced = false; ready = !user; studentState = "loading";
  closeEditor(false);
  if (!user) { render(); return; }
  if (adminLogged) {
    role = "admin";
    stopListeners.push(onSnapshot(studentCollection, { includeMetadataChanges: true }, snapshot => {
      // Do not display optimistic writes as already saved.
      if (snapshot.metadata.hasPendingWrites) return;
      students = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => a.name.localeCompare(b.name, "es"));
      synced = !snapshot.metadata.fromCache;
      if (synced) { ready = true; loading = false; }
      if (!showEditor && !busy) render();
      else if (document.querySelector(".roster")) renderRoster();
    }, error => { loading = false; ready = false; setMessage(errorMessage(error)); render(); }));
    stopListeners.push(onSnapshot(collection(db, "accessRequests"), snapshot => {
      requests = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
      if (!showEditor && !busy) render();
    }, error => { setMessage(errorMessage(error)); render(); }));
    stopListeners.push(onSnapshot(collection(db, "studentAccess"), snapshot => {
      accessLinks = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
      if (!showEditor && !busy) render();
    }));
  } else {
    role = "student";
    stopListeners.push(onSnapshot(doc(db, "studentAccess", user.uid), async link => {
      const generation = ++studentGeneration;
      student = null; studentState = "loading"; render();
      if (link.exists()) {
        try {
          const result = await getDoc(doc(db, "students", link.data().studentId));
          if (generation !== studentGeneration) return;
          student = result.exists() ? { id: result.id, ...result.data() } : null;
          studentState = student ? "linked" : "missing";
        } catch (error) { if (generation !== studentGeneration) return; studentState = "missing"; setMessage(errorMessage(error)); }
      } else studentState = "unlinked";
      loading = false; render();
    }, error => { loading = false; setMessage(errorMessage(error)); render(); }));
    stopListeners.push(onSnapshot(doc(db, "accessRequests", user.uid), result => {
      ownRequest = result.exists() ? result.data() : null;
      render();
    }));
  }
  render();
}
function render() {
  const root = document.getElementById("app");
  if (!role) {
    root.innerHTML = '<main class="welcome"><section class="hero"><span class="eyebrow">ENVÍOS · FUNDACIÓN</span><h1>Tu envío empieza con tus datos.</h1><p>Direcciones organizadas y disponibles desde cualquier computador. Ingresa con tu cuenta de Google.</p><div class="role-grid"><button data-role="student"><strong>Estudiante</strong><span>Consulta tu información autorizada</span></button><button data-role="admin"><strong>Administrativo</strong><span>Gestiona registros y direcciones</span></button></div>' + renderMessage() + '</section></main>';
    root.querySelectorAll("[data-role]").forEach(button => button.onclick = () => setRole(button.dataset.role));
  } else if (!user) {
    root.innerHTML = '<main class="portal"><button class="back" id="back">← Cambiar rol</button><section class="access-card"><span class="eyebrow">' + (role === "admin" ? "ACCESO ADMINISTRATIVO" : "ACCESO DE ESTUDIANTE") + '</span><h1>' + (role === "admin" ? "Gestión de envíos" : "Consulta tus datos") + '</h1><p>' + (role === "admin" ? "Ingresa con la cuenta de Google autorizada de la fundación." : "Ingresa con Google. La administración verificará tu identidad antes de habilitar la consulta.") + '</p><button id="google-login">Continuar con Google</button>' + renderMessage() + '</section></main>';
    document.getElementById("back").onclick = () => setRole(null);
    document.getElementById("google-login").onclick = () => login(role);
  } else if (adminLogged) renderAdmin(root);
  else renderStudentAccess(root);
  updateBusy();
  if (!busy && adminLogged) {
    for (const id of ["add", "delete-all", "import-file", "restore-file", "export-excel", "export-pdf", "export-json"]) {
      const element = document.getElementById(id);
      if (element) element.disabled = !ready || (!students.length && ["delete-all", "export-pdf"].includes(id));
    }
  }
}
function renderAdmin(root) {
  const incomplete = students.filter(item => labels.some(([key]) => !item[key])).length;
  root.innerHTML = '<main class="admin"><header><div><span class="eyebrow">PANEL ADMINISTRATIVO · FUNDACIÓN</span><h1>Direcciones de envío</h1><p id="record-count">' + students.length + ' registros · ' + (loading ? "Conectando…" : synced ? "Sincronizado con Firebase" : "Reconectando…") + '</p></div><div class="admin-actions"><button class="secondary" id="logout">Cerrar sesión</button><button class="secondary menu-toggle" id="menu-toggle" aria-label="Abrir menú administrativo" aria-expanded="' + adminMenuOpen + '"><span></span></button></div></header><section class="toolbar ' + (adminMenuOpen ? "open" : "") + '"><input id="admin-search" aria-label="Buscar estudiante" value="' + escapeHtml(searchQuery) + '" placeholder="Buscar nombre, documento o municipio"><button id="add">+ Añadir estudiante</button><label class="file-button">Importar Excel<input id="import-file" type="file" accept=".xlsx,.xls"></label><button class="secondary" id="export-excel">Exportar Excel</button><button class="secondary" id="export-pdf">Exportar PDF</button><button class="danger" id="delete-all">Borrar todos los datos</button><button class="secondary mobile-logout" id="mobile-logout">Cerrar sesión</button></section><p class="muted storage-note">Sesión: ' + escapeHtml(user.email) + '. Los registros se guardan en Firebase y se sincronizan entre computadores.</p>' + (incomplete ? '<p class="notice">' + incomplete + ' registros tienen campos pendientes. Revisa municipio y departamento en los datos anteriores y completa la información de envío.</p>' : "") + renderMessage() + (showEditor ? editorHtml() : "") + '<section class="roster" aria-label="Estudiantes"></section><details class="cloud-tools"><summary>Copias de seguridad y acceso de estudiantes</summary><p>Guarda una copia privada de los registros. No la subas al repositorio público.</p><div class="row-actions"><button class="secondary" id="export-json">Descargar copia JSON</button><label class="file-button">Importar copia JSON<input id="restore-file" type="file" accept=".json"></label></div>' + accessHtml() + '</details></main>';
  renderRoster();
  wireAdmin();
}
function renderRoster() {
  const query = normalize(searchQuery);
  const filtered = students.filter(item => normalize(labels.map(([key]) => item[key]).join(" ")).includes(query));
  const roster = document.querySelector(".roster");
  if (!roster) return;
  roster.innerHTML = loading ? '<p class="empty-state">Cargando registros desde Firebase…</p>' : filtered.length ? filtered.map(rosterItem).join("") : '<p class="empty-state">' + (students.length ? "No se encontraron coincidencias." : "No hay registros. Añade un estudiante o importa un archivo.") + '</p>';
}
function wireAdmin() {
  document.getElementById("logout").onclick = logout;
  document.getElementById("mobile-logout").onclick = logout;
  document.getElementById("menu-toggle").onclick = () => {
    adminMenuOpen = !adminMenuOpen;
    document.querySelector(".toolbar").classList.toggle("open", adminMenuOpen);
    document.getElementById("menu-toggle").setAttribute("aria-expanded", String(adminMenuOpen));
  };
  document.getElementById("admin-search").oninput = event => { searchQuery = event.target.value; renderRoster(); };
  document.getElementById("add").onclick = () => { closeEditor(false); showEditor = true; resetMessage(); render(); document.querySelector('[name="name"]').focus(); };
  document.getElementById("import-file").onchange = importExcel;
  document.getElementById("restore-file").onchange = importJson;
  document.getElementById("export-json").onclick = exportJson;
  document.getElementById("export-excel").onclick = exportExcel;
  document.getElementById("export-pdf").onclick = exportPdf;
  document.getElementById("delete-all").onclick = deleteAllStudents;
  document.querySelector(".roster").onclick = event => {
    if (busy || !ready) return;
    const editButton = event.target.closest("[data-edit]");
    const deleteButton = event.target.closest("[data-delete]");
    if (editButton) {
      editingId = editButton.dataset.edit;
      const record = students.find(item => item.id === editingId);
      if (!record) return;
      editingVersion = record.version; editingDraft = dataFields(record); showEditor = true;
      resetMessage(); render(); document.querySelector(".editor").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (deleteButton) deleteStudent(deleteButton.dataset.delete);
  };
  document.getElementById("close-editor")?.addEventListener("click", () => closeEditor());
  document.getElementById("cancel-editor")?.addEventListener("click", () => closeEditor());
  document.getElementById("student-editor")?.addEventListener("submit", saveStudent);
  document.querySelectorAll("[data-approve]").forEach(button => button.onclick = () => approveAccess(button.dataset.approve));
  document.querySelectorAll("[data-revoke]").forEach(button => button.onclick = () => revokeAccess(button.dataset.revoke));
}
async function saveRecord(draft, id = null, expectedVersion = null) {
  const recordRef = doc(studentCollection, id || newId());
  const key = normalize(draft.documentNumber);
  const indexRef = doc(db, "documentIndex", key);
  await runTransaction(db, async transaction => {
    const existing = await transaction.get(recordRef);
    const index = await transaction.get(indexRef);
    if (id && (!existing.exists() || existing.data().version !== expectedVersion)) {
      throw new Error("El registro cambió o fue eliminado desde otro computador. Cierra el formulario y vuelve a abrirlo antes de editar.");
    }
    if (index.exists() && index.data().studentId !== recordRef.id) throw new Error("Ya existe un estudiante con ese documento.");
    if (existing.exists()) {
      const oldKey = normalize(existing.data().documentNumber);
      if (oldKey !== key) transaction.delete(doc(db, "documentIndex", oldKey));
    }
    transaction.set(indexRef, { studentId: recordRef.id });
    transaction.set(recordRef, { ...draft, version: (existing.data()?.version || 0) + 1, updatedAt: serverTimestamp() });
  });
}
async function saveStudent(event) {
  event.preventDefault();
  const draft = dataFields(Object.fromEntries(new FormData(event.target)));
  if (labels.some(([key]) => !draft[key]) || !normalize(draft.documentNumber) || !shippingOptions.includes(draft.shippingMethod)) {
    alert("Completa los 11 campos y selecciona una modalidad de envío válida."); return;
  }
  editingDraft = draft;
  await perform(async () => { await saveRecord(draft, editingId, editingVersion); closeEditor(false); }, "Información guardada en Firebase.");
}
async function deleteStudent(id) {
  const item = students.find(record => record.id === id);
  if (!item || !confirm("¿Eliminar permanentemente a " + item.name + " (documento " + item.documentNumber + ")?\n\nSe borrará de Firebase y dejará de aparecer en todos los computadores. Los demás registros se conservarán.")) return;
  await perform(async () => {
    await runTransaction(db, async transaction => {
      const ref = doc(studentCollection, id);
      const current = await transaction.get(ref);
      if (!current.exists()) throw new Error("El registro ya fue eliminado.");
      if (current.data().version !== item.version) throw new Error("Este registro cambió. Revisa la información y repite la eliminación.");
      transaction.delete(doc(db, "documentIndex", normalize(current.data().documentNumber)));
      transaction.delete(ref);
    });
    if (editingId === id) closeEditor(false);
  }, "Registro eliminado permanentemente de Firebase. Los demás registros se conservaron.");
}
async function deleteAllStudents() {
  if (!ready || !students.length) return;
  if (!confirm("¿Borrar permanentemente TODOS los registros de Firebase?\n\nIncluye los registros ocultos por la búsqueda y afecta a todos los computadores. No se puede deshacer. Puedes cancelar y descargar una copia antes.")) return;
  await perform(async () => {
    const snapshot = await getDocsFromServer(studentCollection);
    let deleted = 0;
    try {
      for (let offset = 0; offset < snapshot.docs.length; offset += 200) {
        const group = snapshot.docs.slice(offset, offset + 200);
        await runTransaction(db, async transaction => {
          const current = await Promise.all(group.map(item => transaction.get(item.ref)));
          current.forEach(item => {
            if (!item.exists()) return;
            transaction.delete(doc(db, "documentIndex", normalize(item.data().documentNumber)));
            transaction.delete(item.ref);
          });
        });
        deleted += group.length;
      }
    } catch (error) { throw new Error("Se eliminaron " + deleted + " registros antes del error. Revisa la lista y repite la operación. " + errorMessage(error)); }
    const remaining = await getDocsFromServer(studentCollection);
    closeEditor(false); searchQuery = "";
    if (!remaining.empty) throw new Error("Se borraron los registros seleccionados, pero otro administrador agregó datos durante el proceso. Revisa la lista actualizada.");
  }, "Todos los registros se eliminaron permanentemente de Firebase.");
}
async function mergeRecords(imported) {
  if (imported.length > 2000) throw new Error("Importa como máximo 2.000 registros por archivo.");
  if (!confirm("¿Importar " + imported.length + " registros a Firebase?\n\nSe agregarán los documentos nuevos y se actualizarán los existentes. Los demás registros se conservarán.")) return;
  let completed = 0;
  await perform(async () => {
    for (const record of imported) {
      const draft = dataFields(record);
      const index = await getDoc(doc(db, "documentIndex", normalize(draft.documentNumber)));
      let id = null, version = null;
      if (index.exists()) {
        id = index.data().studentId;
        const current = await getDoc(doc(studentCollection, id));
        if (!current.exists()) throw new Error("Índice inconsistente. No se completó la importación.");
        version = current.data().version;
      }
      try { await saveRecord(draft, id, version); completed++; }
      catch (error) { throw new Error("Se guardaron " + completed + " de " + imported.length + " registros. " + errorMessage(error)); }
    }
    closeEditor(false); searchQuery = "";
  }, () => completed + " registros guardados en Firebase.");
}
async function importExcel(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (!window.XLSX) throw new Error("La herramienta de Excel no está disponible. Revisa tu conexión.");
    const book = XLSX.read(await file.arrayBuffer());
    await mergeRecords(parseImportRows(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: "", raw: false })));
  } catch (error) { setMessage(errorMessage(error)); render(); }
  finally { event.target.value = ""; }
}
async function importJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const source = Array.isArray(parsed) ? parsed : parsed.students;
    if (!Array.isArray(source)) throw new Error("La copia no contiene una lista de estudiantes.");
    const rows = [labels.map(([, label]) => label), ...source.map(record => labels.map(([key]) => record[key] ?? (key === "municipality" ? record.city || "" : "")))];
    await mergeRecords(parseImportRows(rows));
  } catch (error) { setMessage(errorMessage(error)); render(); }
  finally { event.target.value = ""; }
}
function exportJson() {
  const blob = new Blob([JSON.stringify({ schema: 2, exportedAt: new Date().toISOString(), students: students.map(dataFields) }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = "copia-privada-direcciones.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderStudentAccess(root) {
  const content = studentState === "loading" ? '<p>Comprobando tu acceso…</p>' : student ? studentCard(student) : ownRequest ? '<p class="notice">Tu solicitud está pendiente de verificación. La administración debe confirmar tu identidad para habilitar el acceso.</p>' : '<p>Solicita acceso a tu registro. La administración verificará tu identidad antes de autorizar la consulta.</p><form id="request-form"><label>Nombres y apellidos<input name="name" required maxlength="200"></label><label>Número de documento<input name="documentNumber" required maxlength="80"></label><button>Solicitar acceso</button></form>';
  root.innerHTML = '<main class="portal"><button class="back" id="logout">Cerrar sesión</button><section class="access-card"><span class="eyebrow">CONSULTA DE ESTUDIANTE</span><h1>Tu información de envío</h1><p>' + escapeHtml(user.email) + '</p>' + renderMessage() + (student ? "" : content) + '</section>' + (student ? content : "") + '</main>';
  document.getElementById("logout").onclick = logout;
  document.getElementById("request-form")?.addEventListener("submit", event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const name = String(form.get("name") || "").trim();
    const documentNumber = String(form.get("documentNumber") || "").trim();
    if (!name || !normalize(documentNumber)) return;
    perform(() => setDoc(doc(db, "accessRequests", user.uid), { name, documentNumber, email: user.email, createdAt: serverTimestamp() }), "Solicitud enviada a la administración.");
  });
}
function accessHtml() {
  const pending = requests.map(request => {
    const record = students.find(item => normalize(item.documentNumber) === normalize(request.documentNumber));
    return '<article class="access-row"><p><strong>' + escapeHtml(request.name) + '</strong><br>' + escapeHtml(request.email) + '<br>Documento: ' + escapeHtml(request.documentNumber) + '</p><p>' + (record ? "Registro: " + escapeHtml(record.name) : "No existe un registro con este documento.") + '</p>' + (record ? '<button class="secondary" data-approve="' + escapeHtml(request.uid) + '">Autorizar tras verificar identidad</button>' : "") + '</article>';
  }).join("");
  const linked = accessLinks.map(link => '<article class="access-row"><p>' + escapeHtml(link.email || link.uid) + ' · ' + escapeHtml(students.find(item => item.id === link.studentId)?.name || "Registro eliminado") + '</p><button class="danger" data-revoke="' + escapeHtml(link.uid) + '">Revocar consulta</button></article>').join("");
  return '<h2>Solicitudes de estudiantes</h2><p>Verifica la identidad por un canal conocido antes de autorizar. Cada cuenta podrá consultar únicamente su registro.</p>' + (pending || '<p class="muted">No hay solicitudes pendientes.</p>') + '<h2>Consultas autorizadas</h2>' + (linked || '<p class="muted">No hay cuentas de estudiantes vinculadas.</p>');
}
function approveAccess(uid) {
  const request = requests.find(item => item.uid === uid);
  const record = students.find(item => normalize(item.documentNumber) === normalize(request?.documentNumber));
  if (!request || !record || !confirm("¿Confirmas que verificaste la identidad de " + request.name + " y que " + request.email + " pertenece a " + record.name + "?\n\nEsta cuenta podrá consultar únicamente ese registro.")) return;
  perform(async () => {
    const batch = writeBatch(db);
    batch.set(doc(db, "studentAccess", uid), { studentId: record.id, email: request.email });
    batch.delete(doc(db, "accessRequests", uid));
    await batch.commit();
  }, "Consulta autorizada para este estudiante.");
}
function revokeAccess(uid) {
  if (!confirm("¿Revocar la consulta de esta cuenta? El registro del estudiante se conservará.")) return;
  perform(async () => { const batch = writeBatch(db); batch.delete(doc(db, "studentAccess", uid)); await batch.commit(); }, "Acceso de consulta revocado.");
}
window.addEventListener("offline", () => { synced = false; setMessage("Sin conexión. Conéctate a Internet para guardar cambios."); if (!showEditor) render(); });
window.addEventListener("online", () => { resetMessage(); if (!showEditor) render(); });

function studentCard(item) {
  const rows = labels.map(([key, label]) => '<div><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(item[key] || "Pendiente de completar") + '</dd></div>').join("");
  return '<section class="student-result"><div class="result-head"><span class="eyebrow">DATOS PARA EL ENVÍO</span><h2>' + escapeHtml(item.name) + '</h2><p>Verifica la dirección y ten en cuenta la guía de envío.</p></div><dl>' + rows + '</dl><aside><strong>¿Hay información incorrecta?</strong><p>Comunícate con el coordinador académico por WhatsApp al <a href="https://wa.me/573052434285" target="_blank" rel="noreferrer">305 243 4285</a> para actualizarla.</p></aside></section>';
}

function rosterItem(item) {
  return '<article><div><span class="avatar">' + escapeHtml((item.name || "?").slice(0, 1)) + '</span><div><h2>' + escapeHtml(item.name) + '</h2><p>' + escapeHtml(item.documentType) + ' · ' + escapeHtml(item.documentNumber) + '</p><p class="muted">' + escapeHtml(item.program || "Programa pendiente") + '</p><p class="muted">' + escapeHtml([item.municipality, item.department].filter(Boolean).join(" · ") || "Ubicación pendiente") + '</p></div></div><div class="row-actions"><button class="secondary" type="button" data-edit="' + escapeHtml(item.id) + '">Editar</button><button class="danger" type="button" data-delete="' + escapeHtml(item.id) + '">Eliminar</button></div></article>';
}

function editorHtml() {
  const draft = editingDraft || emptyDraft;
  const fields = labels.map(([key, label]) => {
    const value = escapeHtml(draft[key]);
    if (key === "shippingMethod") {
      return '<label class="wide">' + escapeHtml(label) + '<select name="' + key + '" required><option value="">Selecciona una modalidad</option>' + shippingOptions.map(option => '<option' + (draft[key] === option ? " selected" : "") + '>' + escapeHtml(option) + '</option>').join("") + '</select><small>Debes tener en cuenta la guía de envío.</small></label>';
    }
    if (key === "address" || key === "reference") {
      const example = key === "address" ? "Ejemplo: cra52-lote-x-mz 12" : "Ejemplo: casa con rejas blancas cerca del centro comercial X.";
      return '<label>' + escapeHtml(label) + '<textarea name="' + key + '" placeholder="' + example + '" required>' + value + '</textarea></label>';
    }
    return '<label>' + escapeHtml(label) + '<input name="' + key + '" value="' + value + '"' + (key === "phone" ? ' type="tel"' : "") + (key === "documentType" ? ' list="document-types" placeholder="Selecciona o escribe el tipo"' : "") + ' required></label>';
  }).join("");
  return '<section class="editor"><div class="editor-title"><h2>' + (editingId !== null ? "Editar estudiante" : "Nuevo estudiante") + '</h2><button class="icon-button" type="button" id="close-editor" aria-label="Cerrar formulario">×</button></div><p class="muted form-note">Completa los 11 campos para registrar la información del envío.</p><form class="edit-form" id="student-editor">' + fields + '<datalist id="document-types"><option value="Cédula de ciudadanía"><option value="Tarjeta de identidad"><option value="Cédula de extranjería"><option value="Pasaporte"><option value="Permiso por Protección Temporal"></datalist><div class="editor-actions"><button class="secondary" type="button" id="cancel-editor">Cancelar</button><button>Guardar</button></div></form></section>';
}

function exportExcel() {
  if (!window.XLSX) { setMessage("No se cargó la herramienta de Excel. Revisa tu conexión y vuelve a abrir la página."); render(); return; }
  const rows = [labels.map(([, label]) => label), ...students.map(item => labels.map(([key]) => item[key] || ""))];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = labels.map(([key, label]) => ({ wch: Math.min(55, Math.max(18, label.length, ...students.map(item => String(item[key] || "").length)) + 2) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, worksheet, "Direcciones de envío");
  XLSX.writeFile(book, "direcciones-estudiantes.xlsx");
}

function exportPdf() {
  if (!window.jspdf) { setMessage("No se cargó la herramienta de PDF. Revisa tu conexión y vuelve a abrir la página."); render(); return; }
  if (!students.length) { setMessage("No hay registros para exportar a PDF."); render(); return; }
  const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
  let y = 0;
  function heading(item, continued = false) {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(14);
    pdf.setTextColor(16, 33, 61);
    pdf.text("DATOS DEL DESTINATARIO" + (continued ? " · Continuación" : ""), 15, 18);
    pdf.setFontSize(10);
    const nameLines = pdf.splitTextToSize(item.name, 180);
    pdf.text(nameLines, 15, 26);
    y = 31 + nameLines.length * 4.5;
  }
  students.forEach((item, index) => {
    if (index) pdf.addPage();
    heading(item);
    for (const [key, label] of labels) {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      const titleLines = pdf.splitTextToSize(label + ":", 180);
      if (y + titleLines.length * 4.5 + 10 > 277) { pdf.addPage(); heading(item, true); }
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.text(titleLines, 15, y);
      y += titleLines.length * 4.5;
      pdf.setFont("helvetica", "normal");
      const valueLines = pdf.splitTextToSize(item[key] || "Pendiente de completar", 180);
      for (const line of valueLines) {
        if (y > 277) { pdf.addPage(); heading(item, true); }
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.text(line, 15, y);
        y += 4.5;
      }
      y += 5;
    }
  });
  pdf.save("fichas-envio-estudiantes.pdf");
}

const importAliases = {
  name: ["Nombre completo"],
  documentNumber: ["Número de identificación"],
  phone: ["Celular", "Número de teléfono-celular"],
  address: ["Dirección", "Dirección (nomenclatura) ejemplo: cra52-lote-x-mz 12"],
  reference: ["Referencia ejemplo: casa con rejas blancas cerca de centro comercial x."],
  shippingMethod: ["Modalidad de envío", "Tipo de envío", "Desea envío a oficina de Interrapidicimo o envío contraentrega (debe tener en cuenta la guía de envío)"],
  program: ["Programa / carrera"]
};
function matchHeader(header, key, label) {
  const normalized = normalize(header);
  const candidates = [key, label, ...(importAliases[key] || [])];
  return candidates.some(candidate => normalize(candidate) === normalized) ||
    (key === "address" && normalized.startsWith("direccionnomenclatura")) ||
    (key === "reference" && normalized.startsWith("referenciaejemplo")) ||
    (key === "shippingMethod" && normalized.startsWith("deseaenvioaoficinadeinterrapidi"));
}
function parseImportRows(rows) {
  if (rows.length < 2) throw new Error("El archivo no contiene registros.");
  const headers = rows[0];
  const columns = labels.map(([key, label]) => {
    const matches = headers.map((header, index) => matchHeader(header, key, label) ? index : -1).filter(index => index !== -1);
    if (matches.length !== 1) throw new Error("Falta una columna o está duplicada: " + label + ". Usa el Excel exportado como plantilla.");
    return matches[0];
  });
  const seenDocuments = new Set();
  const imported = [];
  rows.slice(1).forEach((row, index) => {
    if (row.every(value => !String(value ?? "").trim())) return;
    const record = { id: newId(), ...Object.fromEntries(labels.map(([key], position) => [key, String(row[columns[position]] ?? "").trim()])) };
    if (!record.name || !normalize(record.documentNumber)) throw new Error("Fila " + (index + 2) + ": faltan el nombre o el documento.");
    const doc = normalize(record.documentNumber);
    if (seenDocuments.has(doc)) throw new Error("Fila " + (index + 2) + ": documento duplicado. Revisa el archivo antes de importar.");
    seenDocuments.add(doc);
    if (record.shippingMethod) {
      const method = normalize(record.shippingMethod);
      if (method.includes("oficina") && !method.includes("contraentrega")) record.shippingMethod = shippingOptions[0];
      else if (method.includes("contraentrega") && !method.includes("oficina")) record.shippingMethod = shippingOptions[1];
      else throw new Error("Fila " + (index + 2) + ": selecciona oficina de Interrapidísimo o contraentrega en la modalidad de envío.");
    }
    imported.push(record);
  });
  if (!imported.length) throw new Error("El archivo no contiene registros.");
  return imported;
}

render();
onAuthStateChanged(auth, startSession);
