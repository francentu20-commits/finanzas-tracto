// ============================================================
// Finanzas Tracto (móvil) · Sincronización con Supabase
// ------------------------------------------------------------
// Usa la MISMA base de datos y las MISMAS claves que la app de
// escritorio (FinanceDesk), para que las tareas ("órdenes") que
// se crean en la PC lleguen al celular, y lo que se hace desde
// el celular (depósitos, cheques escaneados) vuelva a la PC.
//
// Mapeo de claves (celular -> tabla compartida fd_store):
//   tareas      -> "fd-tar"
//   ops         -> "fd-ops"
//   agenda      -> "fd-agenda"
//   descuentos  -> "fd-desc"  (cheques a descontar escaneados desde el celular;
//                              la PC debe leer esta clave para acumularlos y
//                              exportarlos a Excel del lado de escritorio)
//   depositos   -> "fd-depo"  (cheques de depósito escaneados desde el celular;
//                              misma idea que fd-desc, para el lado Depósito
//                              del lote de la PC)
//   notasJ      -> "fd-notas" (notas del día — compartidas con la PC)
// ============================================================

(function () {
  const SUPABASE_URL = "https://vlcootmevguzdoooshan.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZsY29vdG1ldmd1emRvb29zaGFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3ODkwNDIsImV4cCI6MjA5OTM2NTA0Mn0.8UfYG9NGi7MLyqm44NeZMAry5gY4SGjxrGyuD88llic";

  if (typeof window.supabase === "undefined") {
    console.error(
      "[FinTracto] No se encontró la librería supabase-js. Revisá que el <script> del CDN esté antes de supabase-sync.js"
    );
    return;
  }

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  let dataChannel = null;
  let onRemoteChangeCb = null;

  // Último valor visto/enviado por clave (evita reenvíos innecesarios y
  // corta el eco de Realtime de nuestros propios cambios, para no entrar
  // en un loop infinito de escritura -> notificación -> re-render -> escritura).
  const lastSeen = {};

  // ---------- Protección contra el borrado al instalar en un equipo nuevo ----------
  // Mientras no se haya LEÍDO con éxito lo que hay en la nube, esta app no
  // escribe absolutamente nada. En una instalación nueva el almacenamiento
  // local arranca vacío, y si ese estado vacío llegaba a subirse antes de que
  // volviera la primera lectura, pisaba con listas vacías todo lo que había en
  // la nube — y de ahí el borrado se replicaba a los demás dispositivos.
  // Ojo: esto NO impide borrar datos a propósito (cerrar el día, eliminar una
  // tarea). Solo bloquea las escrituras de un equipo que todavía no sabe qué
  // hay guardado.
  let cargaInicialOk = false;
  function estaListoParaEscribir() {
    return cargaInicialOk;
  }

  // Cuántas filas trajo la última lectura. Sirve para separar dos situaciones
  // que antes se confundían: "la nube está realmente vacía (primer uso del
  // sistema)" y "la lectura no trajo lo que esperábamos" (un corte momentáneo,
  // una respuesta vacía sin error). Desde acá son indistinguibles, así que este
  // celular ya no siembra nada solo: los datos buenos los pone la PC.
  let filasEnLaNube = 0;
  function hayFilasEnLaNube() {
    return filasEnLaNube > 0;
  }

  // Cuántos elementos tiene hoy cada clave en la nube. Con esto se detecta el
  // patrón del borrado masivo: un celular recién instalado arranca con todo
  // vacío y, si llega a escribir antes de tener los datos buenos, deja las
  // listas en cero y eso se replica a todos los dispositivos.
  const conteoNube = {};
  function contar(v) {
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === "object") return Object.keys(v).length;
    if (typeof v === "string") return v.length;
    return v == null ? 0 : 1;
  }

  // Listas que este celular NUNCA vacía por su cuenta: las tareas se borran de
  // a una (mobDelT) y las operaciones y la agenda solo se leen. Cualquier envío
  // que las deje en cero es un error, no una acción del usuario.
  // "fd-desc" y "fd-depo" quedan afuera a propósito: la PC las vacía cuando
  // importa los cheques escaneados, y ese vaciado sí tiene que poder subir.
  const CLAVES_QUE_NO_SE_VACIAN = ["fd-tar", "fd-ops", "fd-agenda"];

  // El usuario pidió borrar algo a propósito (mobDelT sobre la última tarea que
  // quedaba). Se levanta justo antes de guardar y vale para un solo envío, así
  // los frenos de más abajo no se interponen en un borrado que sí es
  // intencional.
  let borradoDeliberado = false;
  function marcarBorradoDeliberado() {
    borradoDeliberado = true;
  }

  // Aviso a la interfaz cuando se frena un envío que habría vaciado datos.
  let onBorradoBloqueadoCb = null;
  function onBorradoBloqueado(cb) {
    onBorradoBloqueadoCb = cb;
  }

  // Aviso a la interfaz cuando una escritura SÍ llegó a la nube. Se usa para
  // saber qué tareas ya quedaron guardadas allá: una tarea que nunca se subió
  // no puede haber sido "borrada por otro dispositivo", simplemente el otro
  // todavía no la conocía.
  let onEscrituraOkCb = null;
  function onEscrituraOk(cb) {
    onEscrituraOkCb = cb;
  }

  async function loadAll() {
    const { data, error } = await client
      .from("fd_store")
      .select("key,value")
      .in("key", ["fd-tar", "fd-ops", "fd-agenda", "fd-desc", "fd-depo", "fd-notas", "fd-oficina", "fd-cierre"]);
    if (error) {
      console.error("[FinTracto] Error cargando datos de Supabase:", error.message);
      return null;
    }
    const map = {};
    (data || []).forEach((row) => {
      map[row.key] = row.value;
      lastSeen[row.key] = JSON.stringify(row.value);
      conteoNube[row.key] = contar(row.value);
    });
    filasEnLaNube = (data || []).length;
    // Se pudo leer (aunque no haya filas todavía): recién ahora es seguro
    // escribir, porque ya sabemos qué hay guardado.
    cargaInicialOk = true;
    return map;
  }

  async function saveKey(key, value) {
    if (!cargaInicialOk) {
      console.warn("[FinTracto] No se escribe '" + key + "': todavía no se pudo leer lo que hay en la nube.");
      return;
    }
    // ── REGLA DE ORO ──
    // Nunca se vacía una clave que este celular NO llegó a leer de la nube.
    // Si no sabemos qué había guardado, borrarlo es indefendible.
    //
    // Caso A: la lectura no trajo NI UNA fila. Puede ser que la nube esté vacía
    // de verdad o que la consulta no haya devuelto nada; desde acá son
    // indistinguibles. Sin saber qué hay, este celular no escribe nada: ni
    // vacíos (borraría) ni valores viejos que arrastre de localStorage
    // (pisaría con datos atrasados). Si de verdad es el primer uso del sistema,
    // los datos los siembra la PC desde «Mi equipo».
    if (filasEnLaNube === 0) {
      console.error(
        "[FinTracto] No se escribe '" + key + "': la lectura de la nube no trajo ninguna fila."
      );
      if (onBorradoBloqueadoCb) onBorradoBloqueadoCb([key]);
      return;
    }
    // Caso B: la lectura funcionó, pero esta clave no vino entre las filas.
    // Se la puede crear con contenido, nunca vaciar.
    if (contar(value) === 0 && conteoNube[key] === undefined) {
      console.error(
        "[FinTracto] No se escribe '" + key + "' vacío: este celular nunca leyó esa clave de la nube."
      );
      if (onBorradoBloqueadoCb) onBorradoBloqueadoCb([key]);
      return;
    }
    // Caso C: la clave es una de las que este celular no vacía nunca, y en la
    // nube hoy tiene datos. Es el borrado que hay que frenar.
    if (
      CLAVES_QUE_NO_SE_VACIAN.indexOf(key) !== -1 &&
      contar(value) === 0 &&
      (conteoNube[key] || 0) > 0 &&
      !borradoDeliberado
    ) {
      console.error(
        "[FinTracto] No se escribe '" + key + "' vacío: en la nube tiene " + conteoNube[key] + " elementos."
      );
      if (onBorradoBloqueadoCb) onBorradoBloqueadoCb([key]);
      return;
    }
    const str = JSON.stringify(value);
    if (lastSeen[key] === str) return;
    const anterior = lastSeen[key];
    lastSeen[key] = str;
    const { error } = await client
      .from("fd_store")
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) {
      // La escritura no llegó a destino: hay que dejar lastSeen como estaba
      // para que el próximo sv() la vuelva a intentar. Antes quedaba marcada
      // como "ya enviada" y ese cambio no subía nunca más — seguía viéndose
      // bien en el celular, pero no existía en la nube.
      lastSeen[key] = anterior;
      console.error("[FinTracto] Error guardando '" + key + "' en Supabase:", error.message);
      return;
    }
    conteoNube[key] = contar(value);
    if (onEscrituraOkCb) onEscrituraOkCb(key, value);
  }

  let pendingState = null;
  let pushTimer = null;
  function pushAll(state) {
    if (!cargaInicialOk) return; // ver "Protección contra el borrado" más arriba
    pendingState = state;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const s = pendingState;
      pendingState = null;
      const pares = { "fd-tar": s.tareas, "fd-ops": s.ops, "fd-agenda": s.agenda };
      // Freno al borrado masivo. Si este envío dejaría en cero alguna de las
      // listas que el celular nunca vacía y que en la nube tienen datos, no es
      // una acción del usuario: es un celular que todavía no tiene el estado
      // bueno cargado (lo típico de una instalación nueva o de una
      // resincronización a medias). Se descarta el envío ENTERO en vez de
      // replicar el vaciado al resto de los dispositivos.
      const vaciadas = Object.keys(pares).filter(
        (k) => contar(pares[k]) === 0 && (conteoNube[k] || 0) > 0
      );
      if (vaciadas.length && !borradoDeliberado) {
        console.error(
          "[FinTracto] Envío descartado: habría dejado vacías las claves " +
            vaciadas.join(", ") +
            " que en la nube tienen datos."
        );
        if (onBorradoBloqueadoCb) onBorradoBloqueadoCb(vaciadas);
        return;
      }
      saveKey("fd-tar", s.tareas);
      saveKey("fd-ops", s.ops);
      saveKey("fd-agenda", s.agenda);
      if (s.descuentos !== undefined) saveKey("fd-desc", s.descuentos);
      if (s.depositos !== undefined) saveKey("fd-depo", s.depositos);
      if (s.notasJ !== undefined) saveKey("fd-notas", s.notasJ);
      // "De vuelta a la oficina": lo maneja el celular y la PC solo lo mira.
      if (s.oficina !== undefined) saveKey("fd-oficina", s.oficina);
      // El flag se limpia DESPUES de lanzar las escrituras: saveKey lo consulta
      // al principio (antes de cualquier await), asi que tiene que seguir en pie
      // mientras se recorren las claves.
      borradoDeliberado = false;
    }, 400);
  }

  function subscribeDataChanges(cb) {
    onRemoteChangeCb = cb;
    if (dataChannel) return;
    dataChannel = client
      .channel("fd_store_changes_mobile")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fd_store" },
        (payload) => {
          const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
          if (!row) return;
          if (!["fd-tar", "fd-ops", "fd-agenda", "fd-desc", "fd-depo", "fd-notas", "fd-oficina", "fd-cierre"].includes(row.key)) return;
          const str = JSON.stringify(row.value);
          if (lastSeen[row.key] === str) return; // eco de un cambio propio, se ignora
          lastSeen[row.key] = str;
          if (onRemoteChangeCb) onRemoteChangeCb(row.key, row.value);
        }
      )
      .subscribe();
  }

  // ---------- Web Push: notificaciones REALES del sistema operativo ----------
  // A diferencia de un aviso dentro de la app, esto lo entrega el navegador/OS
  // aunque la app esté cerrada (siempre que el celular tenga internet).
  const VAPID_PUBLIC_KEY =
    "BPxmgIsGk77Li4nnIeJwT-QhVyISDQbCbAKO0wDDdi4HDNY9ihU9DWisN5mzfO7v2aYuO5nyfnYd9wGt80KDiRM";

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function subscribePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("[FinTracto] Este navegador no soporta notificaciones push.");
      return false;
    }
    try {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission !== "granted") {
        console.warn("[FinTracto] Permiso de notificaciones no concedido.");
        return false;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // Si ya había una suscripción pero con una clave VAPID distinta a la
      // actual (por ejemplo, si se rotaron las claves), se descarta y se
      // vuelve a crear para que quede al día automáticamente.
      if (sub) {
        const currentKey = sub.options && sub.options.applicationServerKey
          ? new Uint8Array(sub.options.applicationServerKey)
          : null;
        const expectedKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        const distinta = !currentKey || currentKey.length !== expectedKey.length ||
          currentKey.some((b, i) => b !== expectedKey[i]);
        if (distinta) {
          await sub.unsubscribe().catch(() => {});
          sub = null;
        }
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      const json = sub.toJSON();
      const { error } = await client
        .from("push_subscriptions")
        .upsert(
          { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
          { onConflict: "endpoint" }
        );
      if (error) {
        console.error("[FinTracto] No se pudo guardar la suscripción push en Supabase:", error.message);
        return false;
      }
      return true;
    } catch (e) {
      console.error("[FinTracto] No se pudo suscribir a push:", e);
      return false;
    }
  }

  // Dispara una notificación real a TODOS los dispositivos suscriptos
  // (se llama, por ejemplo, apenas se crea una tarea nueva).
  async function sendPushTrigger(title, body) {
    try {
      await fetch(SUPABASE_URL + "/functions/v1/send-push", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + SUPABASE_ANON_KEY },
        body: JSON.stringify({ title, body }),
      });
    } catch (e) {
      console.error("[FinTracto] No se pudo disparar la notificación push:", e);
    }
  }

  // ---------- Acuses (comprobantes/fotos) ----------
  // La imagen NO va en la tabla — antes viajaba como base64 metida en la
  // columna "imagen" (filas gigantes, lento de traer). Ahora se sube al
  // bucket de Storage "acusar" (público) y en la tabla "acuses" solo se
  // guarda la URL pública de esa imagen — mucho más liviano.
  const ACUSES_BUCKET = "acuses";
  function base64ToUint8Array(base64) {
    // Acepta tanto un base64 "pelado" como un data URI completo
    // ("data:image/jpeg;base64,...") — si viene con el prefijo, se saca
    // antes de decodificar (atob revienta con esos caracteres, ";", ":" y
    // "/" no son base64 válido, y esa excepción no se atrapaba en ningún
    // lado: el acuse fallaba en silencio, sin ningún error visible).
    const clean = base64.indexOf(",") !== -1 ? base64.split(",")[1] : base64;
    const raw = atob(clean);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  async function saveAcuse(banco, txt, monto, mon, fecha, imagenBase64) {
    const fileName = fecha + "_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".jpg";
    const { error: upError } = await client.storage
      .from(ACUSES_BUCKET)
      .upload(fileName, base64ToUint8Array(imagenBase64), { contentType: "image/jpeg" });
    if (upError) {
      console.error("[FinTracto] Error subiendo la imagen del acuse a Storage:", upError.message);
      return { ok: false, error: upError.message };
    }
    const { data: pub } = client.storage.from(ACUSES_BUCKET).getPublicUrl(fileName);
    const { error } = await client
      .from("acuses")
      .insert({ banco, txt, monto: monto || null, mon: mon || null, fecha, imagen: pub.publicUrl });
    if (error) {
      console.error("[FinTracto] Error guardando el acuse:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  async function loadAcuses() {
    const { data, error } = await client
      .from("acuses")
      .select("id,banco,txt,monto,mon,fecha,imagen")
      .order("fecha", { ascending: false });
    if (error) {
      console.error("[FinTracto] Error cargando acuses:", error.message);
      return [];
    }
    return data || [];
  }

  // ---------- Broadcast: avisa a la PC en vivo de cada cambio de fase ----------
  // (iniciar / llegué al banco / terminar), en el mismo canal que ya escucha
  // la app de escritorio (fd-events), para que le dispare su notificación.
  let eventsChannelReady = null;
  function ensureEventsChannel() {
    if (!eventsChannelReady) {
      eventsChannelReady = new Promise((resolve) => {
        const ch = client.channel("fd-events", { config: { broadcast: { self: false } } });
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve(ch);
        });
      });
    }
    return eventsChannelReady;
  }
  function broadcastEvent(obj) {
    ensureEventsChannel().then((ch) => ch.send({ type: "broadcast", event: "fd", payload: obj }));
  }

  // Hay un cambio local (sv() -> pushAll) que todavía no se terminó de
  // mandar a Supabase (sigue esperando el debounce de 400ms). Se usa para
  // que la app no aplique un cambio remoto que llegue justo en ese ratito
  // -que podría ser más viejo que lo que se acaba de hacer acá- y termine
  // pisando esa edición local antes de que llegue a guardarse.
  function hasPendingPush() {
    return pushTimer !== null;
  }

  window.FDSupabase = {
    client,
    loadAll,
    saveKey,
    pushAll,
    hasPendingPush,
    estaListoParaEscribir,
    hayFilasEnLaNube,
    marcarBorradoDeliberado,
    onBorradoBloqueado,
    onEscrituraOk,
    subscribeDataChanges,
    subscribePush,
    sendPushTrigger,
    saveAcuse,
    loadAcuses,
    broadcastEvent,
  };
})();
