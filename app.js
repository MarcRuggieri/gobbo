/* Gobbo: leggi i testi, correggili e registrati col gobbo che segue la voce.
 *
 * Tutto succede nel browser: i video registrati restano sul computer (IndexedDB) finché non li scarichi.
 * I testi arrivano cifrati (testi/<persona>.enc.json) e si aprono solo con la chiave nel link (#k=...).
 *
 * Il «segue la voce» riprende l'idea e l'algoritmo di voice-activated-teleprompter di Julien Lecomte
 * (https://github.com/jlecomte/voice-activated-teleprompter, licenza MIT, vedi LICENZE.md):
 * confronto con la distanza di Levenshtein fra ciò che il riconoscimento vocale ha sentito e il testo
 * che viene dopo l'ultima parola riconosciuta. Qui è riscritto in JavaScript semplice, per l'italiano
 * (accenti, apostrofi, numeri detti a voce) e con una sola tabella di Levenshtein per ogni frase sentita.
 */
"use strict";

// ---------------------------------------------------------------- piccoli aiuti
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...figli) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else if (["muted", "checked", "selected", "disabled", "autoplay", "controls", "readonly"].includes(k)) { e[k === "readonly" ? "readOnly" : k] = !!v; e.setAttribute(k, ""); }
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const f of figli.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f.nodeType ? f : document.createTextNode(String(f)));
  return e;
};
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const pulito = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const DISPOSITIVO = (() => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const telefono = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 700;
  const safari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  const chrome = /chrome|crios/i.test(ua) && !/edg/i.test(ua);
  return { ios, telefono, safari, chrome, mac: /Macintosh/.test(ua) && !ios };
})();

// ---------------------------------------------------------------- preferenze
const PREF_DEF = { modo: "voce", wpm: 150, font: DISPOSITIVO.telefono ? 26 : 46, inverti: false, larghezza: "medio", specchio: false, mostraMe: true, specchiaMe: true, autoStop: true, cam: "", mic: "", leggiDomanda: true };
const P = Object.assign({}, PREF_DEF, JSON.parse(localStorage.getItem("gobbo.pref") || "{}"));
const salvaPref = () => localStorage.setItem("gobbo.pref", JSON.stringify(P));

// ---------------------------------------------------------------- stato
const S = { persona: "alessio", dati: null, video: null, puntate: [], stream: null, audioCtx: null, analizzatore: null, livello: -100, wakeLock: null, pila: [] };

// ---------------------------------------------------------------- testi (cifrati)
async function caricaTesti() {
  const q = new URLSearchParams(location.search);
  S.persona = (q.get("p") || localStorage.getItem("gobbo.persona") || "alessio").replace(/[^a-z0-9-]/g, "");
  localStorage.setItem("gobbo.persona", S.persona);
  const dalLink = new URLSearchParams(location.hash.slice(1)).get("k");
  const k = dalLink || localStorage.getItem("gobbo.k." + S.persona);
  const miei = JSON.parse(localStorage.getItem("gobbo.miei." + S.persona) || "[]");
  let dati = { persona: "", titolo: "I tuoi testi", video: [] };
  if (k) {
    try {
      const r = await fetch(`testi/${S.persona}.enc.json`, { cache: "no-cache" });
      const { iv, ct } = await r.json();
      const chiave = await crypto.subtle.importKey("raw", b64u(k), "AES-GCM", false, ["decrypt"]);
      const chiaro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u(iv) }, chiave, b64u(ct));
      dati = JSON.parse(new TextDecoder().decode(chiaro));
      if (dalLink) localStorage.setItem("gobbo.k." + S.persona, dalLink);
    } catch (e) {
      console.warn("testi non aperti", e);
      dati.errore = true;
    }
  } else dati.senzaChiave = true;
  dati.video = (dati.video || []).concat(miei);
  S.puntate = podcastInVideo(dati.podcast);
  return dati;
}

const chiaveModifiche = () => "gobbo.modifiche." + S.persona;
const modifiche = () => JSON.parse(localStorage.getItem(chiaveModifiche()) || "{}");
function testoParte(v, i) {
  const m = modifiche()[`${v.id}/${i}`];
  return m !== undefined ? m : v.parti[i].testo;
}
function salvaModifica(v, i, testo) {
  const m = modifiche();
  if (testo === v.parti[i].testo) delete m[`${v.id}/${i}`];
  else m[`${v.id}/${i}`] = testo;
  localStorage.setItem(chiaveModifiche(), JSON.stringify(m));
}
const parteModificata = (v, i) => modifiche()[`${v.id}/${i}`] !== undefined;
const paroleDi = (t) => (t.match(/[\p{L}\p{N}]+/gu) || []).length;
const paroleVideo = (v) => v.parti.reduce((a, _, i) => a + paroleDi(testoParte(v, i)), 0);

// ---------------------------------------------------------------- archivio delle riprese (IndexedDB)
const Archivio = {
  _db: null,
  apri() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((ok, ko) => {
      const r = indexedDB.open("gobbo", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("riprese", { keyPath: "id" });
      r.onsuccess = () => ok((this._db = r.result));
      r.onerror = () => ko(r.error);
    });
  },
  async _tx(modo, fn) {
    const db = await this.apri();
    return new Promise((ok, ko) => {
      const t = db.transaction("riprese", modo);
      const st = t.objectStore("riprese");
      let ris;
      Promise.resolve(fn(st)).then((x) => (ris = x));
      t.oncomplete = () => ok(ris);
      t.onerror = () => ko(t.error);
    });
  },
  metti(r) { return this._tx("readwrite", (st) => st.put(r)); },
  togli(id) { return this._tx("readwrite", (st) => st.delete(id)); },
  async tutte() {
    const db = await this.apri();
    return new Promise((ok, ko) => {
      const q = db.transaction("riprese").objectStore("riprese").getAll();
      q.onsuccess = () => ok(q.result.filter((r) => r.persona === S.persona).sort((a, b) => a.creata - b.creata));
      q.onerror = () => ko(q.error);
    });
  },
};

// ---------------------------------------------------------------- navigazione
function vai(fn, ...args) {
  S.pila.push([fn, args]);
  history.pushState({ n: S.pila.length }, "");
  mostra(fn, args);
}
function mostra(fn, args) {
  esciDalloStudio();
  window.scrollTo(0, 0);
  fn(...args);
}
window.addEventListener("popstate", () => {
  if (S.pila.length > 1) S.pila.pop();
  const [fn, args] = S.pila[S.pila.length - 1] || [home, []];
  mostra(fn, args);
});
const pagina = (...figli) => {
  const app = $("#app");
  app.className = "";
  app.replaceChildren(...figli);
};
const indietro = (testo = "Indietro") => h("button", { class: "link-indietro", onclick: () => history.back() }, "← ", testo);

// ---------------------------------------------------------------- 1. inizio
async function home() {
  fermaCamera();
  const d = S.dati;
  const riprese = await Archivio.tutte().catch(() => []);
  if (S.puntate.length) return homePodcast(riprese);
  if ((d.senzaChiave || d.errore) && !d.video.length) {
    return pagina(h("main", { class: "carta" }, h("h1", {}, "Gobbo"), h("p", { class: "lead" }, d.errore ? "Non sono riuscito ad aprire i testi. Riapri il link di WhatsApp per intero, con tutto quello che c'è dopo il simbolo #." : "Per vedere i tuoi testi apri il link che ti hanno mandato su WhatsApp, con tutto quello che c'è dopo il simbolo #."), h("button", { class: "bottone secondario", onclick: () => vai(nuovoTesto) }, "Oppure incolla un testo tuo")));
  }
  const nome = d.persona ? `Ciao ${d.persona}` : "Ciao";
  pagina(
    h("main", { class: "carta" },
      h("p", { class: "occhiello" }, "Gobbo · testi e registrazione"),
      h("h1", {}, nome),
      h("p", { class: "lead" }, "Qui trovi i testi dei tuoi video. Puoi leggerli con calma, correggerli e registrarti con il gobbo: il testo ti scorre davanti, vicino alla camera, e va avanti mentre parli."),
      d.errore ? h("p", { class: "avviso" }, "Non sono riuscito ad aprire i testi. Riapri il link di WhatsApp per intero; se non va, scrivi a Marc.") : null,
      h("div", { class: "schede" },
        d.video.map((v) => {
          const n = riprese.filter((r) => r.video === v.id).length;
          return h("article", { class: "scheda" },
            h("h2", {}, v.titolo),
            h("p", { class: "meta" }, [v.durata, `${v.parti.length} ${v.parti.length === 1 ? "parte" : "parti"}`, `${paroleVideo(v)} parole`].filter(Boolean).join(" · ")),
            v.scopo ? h("p", { class: "scopo" }, "Cosa deve fare chi guarda: ", v.scopo) : null,
            h("div", { class: "azioni" },
              h("button", { class: "bottone", onclick: () => vai(leggi, v) }, "Leggi il testo"),
              h("button", { class: "bottone oro", onclick: () => vai(prepara, v) }, "Registra col gobbo")),
            n ? h("button", { class: "link", onclick: () => vai(rivedi, v) }, `Le tue riprese di questo video (${n}) →`) : null);
        })),
      h("section", { class: "come" },
        h("h2", {}, "Come si fa, in 4 passi"),
        h("ol", {},
          h("li", {}, h("b", {}, "Leggi il testo "), "una volta ad alta voce. Se una frase non ti torna, correggila: premi «Correggi il testo» e salva."),
          h("li", {}, h("b", {}, "Prepara la stanza: "), "luce davanti a te, camera all'altezza degli occhi, silenzio."),
          h("li", {}, h("b", {}, "Registra una parte alla volta. "), "Il testo ti scorre sotto la camera e segue la tua voce. Se sbagli, rifai solo quella parte."),
          h("li", {}, h("b", {}, "Manda le riprese a Marc "), "dalla pagina «Le tue riprese»: le scarichi e gliele giri su WhatsApp come documento.")),
        h("p", { class: "nota" }, DISPOSITIVO.telefono ? "Funziona anche dal telefono: tienilo in orizzontale, fermo su un appoggio." : "Va meglio con Chrome sul Mac. Funziona anche con Safari e dal telefono (in orizzontale).")),
      h("div", { class: "piede" },
        h("button", { class: "link", onclick: () => vai(nuovoTesto) }, "+ Incolla un testo nuovo"),
        riprese.length ? h("button", { class: "link", onclick: () => vai(rivedi, null) }, `Tutte le riprese (${riprese.length})`) : null)));
}

// ---------------------------------------------------------------- 2. leggere e correggere
function leggi(v, modifica = false) {
  fermaCamera();
  const blocchi = v.parti.map((p, i) => {
    const testo = testoParte(v, i);
    const titolo = h("h3", {}, v.parti.length > 1 ? `${i + 1} · ${p.titolo}` : p.titolo, p.nota ? h("span", { class: "nota-parte" }, p.nota) : null, parteModificata(v, i) ? h("span", { class: "nota-parte oro" }, "corretto da te") : null);
    if (!modifica) return h("section", { class: "parte" }, titolo, testo.split("\n").filter(Boolean).map((r) => h("p", {}, r)));
    const ta = h("textarea", { "data-i": i, rows: 3 }, testo);
    const adatta = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 4 + "px"; };
    ta.addEventListener("input", adatta);
    requestAnimationFrame(adatta);
    return h("section", { class: "parte" }, titolo, ta,
      parteModificata(v, i) ? h("button", { class: "link piccolo", onclick: () => { if (confirm("Rimettere il testo originale di questa parte?")) { salvaModifica(v, i, v.parti[i].testo); leggi(v, true); } } }, "Rimetti il testo originale") : null);
  });
  const salva = () => {
    document.querySelectorAll("textarea[data-i]").forEach((ta) => salvaModifica(v, +ta.dataset.i, ta.value.trim()));
    leggi(v, false);
    avviso("Salvato. Il gobbo userà il testo corretto.");
  };
  pagina(
    h("main", { class: "carta lettura" },
      indietro("Tutti i video"),
      h("h1", {}, v.titolo),
      h("p", { class: "meta" }, [v.dove, v.durata, v.scopo ? "obiettivo: " + v.scopo : ""].filter(Boolean).join(" · ")),
      h("div", { class: "barra-azioni" },
        modifica
          ? [h("button", { class: "bottone oro", onclick: salva }, "Salva le correzioni"), h("button", { class: "bottone secondario", onclick: () => leggi(v, false) }, "Annulla")]
          : [h("button", { class: "bottone oro", onclick: () => vai(prepara, v) }, "Registra col gobbo"),
             h("button", { class: "bottone secondario", onclick: () => leggi(v, true) }, "Correggi il testo"),
             h("button", { class: "bottone secondario", onclick: () => copia(v) }, "Copia tutto il testo")]),
      modifica ? h("p", { class: "nota" }, "Scrivi direttamente nei riquadri. Le correzioni restano su questo dispositivo e il gobbo le usa subito. Per farle avere a Marc: «Copia tutto il testo» e incollalo su WhatsApp.") : null,
      blocchi,
      modifica ? h("div", { class: "barra-azioni" }, h("button", { class: "bottone oro", onclick: salva }, "Salva le correzioni")) : null));
}
async function copia(v) {
  const testo = `${v.titolo}\n\n` + v.parti.map((p, i) => (v.parti.length > 1 ? `${i + 1} · ${p.titolo}\n` : "") + testoParte(v, i)).join("\n\n");
  try {
    await navigator.clipboard.writeText(testo);
    avviso("Testo copiato: ora puoi incollarlo dove vuoi.");
  } catch {
    const ta = h("textarea", { class: "copia-a-mano", readonly: true }, testo);
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    avviso("Testo copiato.");
  }
}
function nuovoTesto() {
  const titolo = h("input", { type: "text", placeholder: "Titolo, per esempio «Video 4 · Il corso»" });
  const ta = h("textarea", { rows: 12, placeholder: "Incolla qui il testo.\n\nLascia una riga vuota fra una parte e l'altra: ogni parte si registra da sola." });
  pagina(h("main", { class: "carta lettura" }, indietro(), h("h1", {}, "Un testo nuovo"),
    h("p", { class: "lead" }, "Incolla un testo qualsiasi e registralo col gobbo. Resta solo su questo dispositivo."),
    titolo, ta,
    h("div", { class: "barra-azioni" }, h("button", { class: "bottone oro", onclick: () => {
      const blocchi = ta.value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      if (!blocchi.length) return avviso("Il testo è vuoto.");
      const v = { id: "m" + Date.now(), titolo: titolo.value.trim() || "Testo nuovo", durata: "", scopo: "", mio: true, parti: blocchi.map((t, i) => ({ titolo: `Parte ${i + 1}`, testo: t })) };
      const miei = JSON.parse(localStorage.getItem("gobbo.miei." + S.persona) || "[]");
      miei.push(v);
      localStorage.setItem("gobbo.miei." + S.persona, JSON.stringify(miei));
      S.dati.video.push(v);
      history.back();
    } }, "Salva il testo"))));
}

// ---------------------------------------------------------------- 2b. il podcast
// Ogni puntata diventa un «video» con una parte per domanda: preparazione, riprese e archivio sono gli stessi dei testi.
// Di ogni domanda la prima frase (gancio) resta com'è, in rosso; spunti e chiusura sono di chi parla e si correggono.
function podcastInVideo(pod) {
  if (!pod || !Array.isArray(pod.puntate)) return [];
  return pod.puntate.map((p) => ({
    id: p.id, podcast: true, numero: p.numero, titolo: p.etichetta ? `${p.etichetta} · ${p.titolo}` : `Puntata ${p.numero} · ${p.titolo}`, breve: p.titolo,
    sezione: p.sezione || "podcast", parola: p.parola || "Domanda",
    sottotitolo: p.sottotitolo || "", perche: p.perche || "", durata: p.durata || "",
    parti: p.capitoli.map((c) => Object.assign({ spunti: [], chiusura: "" }, c)),
  }));
}
const chiavePod = () => "gobbo.podcast." + S.persona;
const modPod = () => JSON.parse(localStorage.getItem(chiavePod()) || "{}");
function capitolo(v, i) {
  const c = v.parti[i];
  const m = modPod()[`${v.id}/${c.id}`];
  return m ? Object.assign({}, c, { spunti: m.spunti, chiusura: m.chiusura, corretto: true }) : c;
}
function salvaCapitolo(v, i, spunti, chiusura) {
  const c = v.parti[i];
  const m = modPod();
  if (JSON.stringify(spunti) === JSON.stringify(c.spunti) && chiusura === (c.chiusura || "")) delete m[`${v.id}/${c.id}`];
  else m[`${v.id}/${c.id}`] = { spunti, chiusura };
  localStorage.setItem(chiavePod(), JSON.stringify(m));
}
const ctaDi = (id) => (S.dati.podcast?.cta || []).find((c) => c.id === id);
const etichettaCap = (v, i) => (v.parti[i].tipo === "apertura" ? "Apertura" : `${v.parola || "Domanda"} ${v.parti.slice(0, i + 1).filter((c) => c.tipo !== "apertura").length}`);
const quanteDomande = (v) => v.parti.filter((c) => c.tipo !== "apertura").length;
const contaParti = (v) => { const n = quanteDomande(v); return v.sezione === "podcast" ? `${n} domande` : v.parola === "Video" ? `${n} video` : `${n} ${n === 1 ? "parte" : "parti"}`; };
const SEZIONI = [["podcast", "Il podcast", ""], ["riformula", "Da dire con parole tue", "I video della community e i video brevi dei corsi, nella versione da riformulare: prima frase in rosso, il resto spunti."]];
const perSezione = (fn) => SEZIONI.map(([k, t, n]) => { const l = S.puntate.filter((v) => v.sezione === k); return l.length ? [h("h2", { class: "sezione" }, t), n ? h("p", { class: "nota" }, n) : null, h("div", { class: "schede" }, l.map(fn))] : null; });

function homePodcast(riprese) {
  const d = S.dati, pod = d.podcast;
  pagina(h("main", { class: "carta" },
    h("p", { class: "occhiello" }, pod.occhiello || "Podcast · testi e registrazione"),
    h("h1", {}, d.persona ? `Ciao ${d.persona}` : "Ciao"),
    h("p", { class: "lead" }, pod.benvenuto || ""),
    h("div", { class: "due-strade" },
      h("button", { class: "strada", onclick: () => vai(leggiTutto) },
        h("span", { class: "icona", "aria-hidden": "true" }, "📖"), h("b", {}, "Leggi e prepara"),
        h("span", {}, "Le domande del podcast, la prima frase in rosso e i tuoi spunti. Puoi correggere tutto e scaricarlo in Word.")),
      h("button", { class: "strada scura", onclick: () => vai(registraMenu) },
        h("span", { class: "icona", "aria-hidden": "true" }, "🎙"), h("b", {}, "Registra da remoto"),
        h("span", {}, "Se un giorno non puoi essere a Roma: la domanda compare sullo schermo, rispondi guardando in camera e la ripresa resta sul tuo computer."))),
    h("div", { class: "barra-azioni" }, h("button", { class: "bottone secondario", onclick: () => vai(strategia) }, "La strategia in 2 minuti →")),
    riprese.length ? h("div", { class: "piede" }, h("button", { class: "link", onclick: () => vai(rivedi, null) }, `Le tue riprese (${riprese.length})`)) : null));
}

function strategia() {
  const st = S.dati.podcast.strategia || { titolo: "La strategia", sezioni: [] };
  const tabella = (t) => h("div", { class: "tabella-scorri" }, h("table", { class: "tabella" },
    h("thead", {}, h("tr", {}, t.colonne.map((c) => h("th", {}, c)))),
    h("tbody", {}, t.righe.map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))));
  pagina(h("main", { class: "carta lettura" }, indietro("Inizio"),
    h("p", { class: "occhiello" }, "La strategia"),
    h("h1", {}, st.titolo),
    st.sezioni.map((s) => h("section", { class: "parte" },
      h("h2", {}, s.titolo),
      s.testo ? s.testo.split("\n").filter(Boolean).map((r) => h("p", {}, r)) : null,
      s.punti ? h("ul", { class: "punti" }, s.punti.map((p) => h("li", {}, p))) : null,
      s.tabella ? tabella(s.tabella) : null)),
    h("div", { class: "barra-azioni" }, h("button", { class: "bottone oro", onclick: () => vai(leggiTutto) }, "Vai alle domande →"))));
}

const legenda = () => h("p", { class: "legenda" },
  h("span", { class: "segno rosso" }, "Rosso"), " resta così: è quello che serve all'algoritmo. ",
  h("span", { class: "segno nero" }, "Nero"), " sono spunti: li dici con parole tue e puoi cambiarli.");

function leggiTutto() {
  fermaCamera();
  const pod = S.dati.podcast;
  pagina(h("main", { class: "carta" }, indietro("Inizio"),
    h("p", { class: "occhiello" }, "Leggi e prepara"),
    h("h1", {}, pod.titolo),
    pod.sottotitolo ? h("p", { class: "lead" }, pod.sottotitolo) : null,
    legenda(),
    perSezione((v) => h("article", { class: "scheda" },
      h("h2", {}, v.titolo),
      h("p", { class: "meta" }, [v.sottotitolo, contaParti(v), v.durata].filter(Boolean).join(" · ")),
      v.perche ? h("p", { class: "scopo" }, v.perche) : null,
      h("div", { class: "azioni" },
        h("button", { class: "bottone", onclick: () => vai(leggiPuntata, v) }, v.sezione === "podcast" ? "Leggi le domande" : "Leggi gli spunti"),
        h("button", { class: "bottone secondario", onclick: () => scaricaWord([v]) }, "Scarica in Word")))),
    h("div", { class: "barra-azioni" }, h("button", { class: "bottone oro", onclick: () => scaricaWord(S.puntate, true) }, "Scarica tutto in Word")),
    S.dati.video.length ? h("section", { class: "come" },
      h("h2", {}, "Le versioni integrali"),
      h("p", { class: "nota" }, "I testi completi, come sono stati scritti o registrati. Si dicono così, col gobbo che scorre e segue la voce."),
      h("div", { class: "schede" }, S.dati.video.map((v) => h("article", { class: "scheda" },
        h("h2", {}, v.titolo),
        h("p", { class: "meta" }, [v.durata, v.scopo ? "obiettivo: " + v.scopo : ""].filter(Boolean).join(" · ")),
        h("div", { class: "azioni" }, h("button", { class: "bottone", onclick: () => vai(leggi, v) }, "Leggi il testo")))))) : null));
}

function leggiPuntata(v, modifica = false) {
  fermaCamera();
  const blocchi = v.parti.map((_, i) => {
    const c = capitolo(v, i);
    const cta = ctaDi(c.cta);
    const apertura = c.tipo === "apertura";
    const testa = h("h3", {}, h("span", { class: "num" }, etichettaCap(v, i)), " ", c.titolo, c.corretto ? h("span", { class: "nota-parte oro" }, "corretto da te") : null);
    const domanda = c.domanda ? h("p", { class: "domanda" }, h("span", { class: "chi" }, apertura ? "Marc" : v.sezione === "podcast" ? "Marc ti chiede" : "Di cosa parli qui"), c.domanda) : null;
    const rosso = h("div", { class: "pezzo rosso" }, h("span", { class: "chi" }, "🔒 ", apertura ? "Inizi così, resta così" : "La tua prima frase, resta così"), h("p", {}, c.gancio));
    let corpo;
    if (!modifica) {
      corpo = [
        c.spunti.length ? h("div", { class: "pezzo nero" }, h("span", { class: "chi" }, "Poi racconti, con parole tue"), h("ul", {}, c.spunti.map((s) => h("li", {}, s)))) : null,
        c.chiusura ? h("div", { class: "pezzo nero" }, h("span", { class: "chi" }, "Per chiudere, se ti viene"), h("p", {}, c.chiusura)) : null,
      ];
    } else {
      const adatta = (ta) => { const f = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 4 + "px"; }; ta.addEventListener("input", f); requestAnimationFrame(f); return ta; };
      corpo = [
        h("label", { class: "chi" }, "Spunti, uno per riga"),
        adatta(h("textarea", { "data-i": i, "data-campo": "spunti", rows: 4 }, c.spunti.join("\n"))),
        h("label", { class: "chi" }, "Chiusura"),
        adatta(h("textarea", { "data-i": i, "data-campo": "chiusura", rows: 2 }, c.chiusura || "")),
        c.corretto ? h("button", { class: "link piccolo", onclick: () => { if (confirm("Rimettere gli spunti originali di questa domanda?")) { const o = v.parti[i]; salvaCapitolo(v, i, o.spunti, o.chiusura || ""); leggiPuntata(v, true); } } }, "Rimetti gli spunti originali") : null,
      ];
    }
    return h("section", { class: "capitolo" + (apertura ? " apertura" : "") }, testa, domanda, rosso, corpo,
      c.attenzione ? h("p", { class: "attenzione" }, h("b", {}, "Per i social: "), c.attenzione) : null,
      cta ? h("p", { class: "cta-tag" }, "Nel video finisce con la frase finale ", h("b", {}, cta.nome), ": «", cta.testo, "»") : null,
      c.fonte ? h("p", { class: "fonte" }, "Dal tuo libro: ", c.fonte) : null);
  });
  const salva = () => {
    const per = {};
    document.querySelectorAll("textarea[data-i]").forEach((ta) => { (per[ta.dataset.i] ||= {})[ta.dataset.campo] = ta.value.trim(); });
    for (const [i, x] of Object.entries(per)) salvaCapitolo(v, +i, (x.spunti || "").split("\n").map((s) => s.trim()).filter(Boolean), x.chiusura || "");
    leggiPuntata(v, false);
    avviso("Salvato. Lo vedi anche quando registri.");
  };
  pagina(h("main", { class: "carta lettura" },
    indietro("Tutti i testi"),
    h("p", { class: "occhiello" }, v.sezione === "podcast" ? "Podcast" : "Da dire con parole tue"),
    h("h1", {}, v.titolo),
    h("p", { class: "meta" }, [v.sottotitolo, contaParti(v), v.durata].filter(Boolean).join(" · ")),
    v.perche ? h("p", { class: "lead" }, v.perche) : null,
    legenda(),
    h("div", { class: "barra-azioni" },
      modifica
        ? [h("button", { class: "bottone oro", onclick: salva }, "Salva le correzioni"), h("button", { class: "bottone secondario", onclick: () => leggiPuntata(v, false) }, "Annulla")]
        : [h("button", { class: "bottone oro", onclick: () => vai(prepara, v) }, "Registra da remoto"),
           h("button", { class: "bottone secondario", onclick: () => leggiPuntata(v, true) }, "Correggi gli spunti"),
           h("button", { class: "bottone secondario", onclick: () => copiaPuntata(v) }, "Copia tutto"),
           h("button", { class: "bottone secondario", onclick: () => scaricaWord([v]) }, "Scarica in Word")]),
    modifica ? h("p", { class: "nota" }, "Scrivi nei riquadri: le parti in rosso non si cambiano qui. Le correzioni restano su questo dispositivo. Per farle avere a Marc: «Copia tutto» e incollalo su WhatsApp, oppure «Scarica in Word» e mandagli il file.") : null,
    blocchi,
    modifica ? h("div", { class: "barra-azioni" }, h("button", { class: "bottone oro", onclick: salva }, "Salva le correzioni")) : null));
}

function testoPuntata(v) {
  return `${v.titolo}\n\n` + v.parti.map((_, i) => {
    const c = capitolo(v, i);
    const cta = ctaDi(c.cta);
    return [`${etichettaCap(v, i)} · ${c.titolo}`, c.domanda ? `Marc: ${c.domanda}` : "", `PRIMA FRASE (resta così): ${c.gancio}`,
      ...c.spunti.map((s) => `- ${s}`), c.chiusura ? `Chiusura: ${c.chiusura}` : "", cta ? `Frase finale ${cta.nome}` : ""].filter(Boolean).join("\n");
  }).join("\n\n");
}
async function copiaPuntata(v) {
  const testo = testoPuntata(v);
  try { await navigator.clipboard.writeText(testo); }
  catch { const ta = h("textarea", { class: "copia-a-mano", readonly: true }, testo); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  avviso("Copiato: ora puoi incollarlo su WhatsApp.");
}

// Word apre i file .doc scritti in HTML: rosso per le parti fisse, nero per gli spunti.
function scaricaWord(lista, tutto = false) {
  const pod = S.dati.podcast;
  const e = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let x = `<html><head><meta charset="utf-8"><title>${e(pod.titolo)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt;line-height:1.4}h1{font-size:20pt}h2{font-size:16pt;margin-top:22pt;border-bottom:1px solid #ccc}h3{font-size:13pt;margin:16pt 0 4pt}.r{color:#C00000;font-weight:bold}.d{font-style:italic;color:#333}.g{color:#777;font-size:10pt}</style></head><body>`;
  x += `<h1>${e(pod.titolo)}</h1><p>In <span class="r">rosso</span> le frasi che restano così: servono all'algoritmo. In nero gli spunti: li dici con parole tue e qui puoi correggerli liberamente.</p>`;
  for (const v of lista) {
    x += `<h2>${e(v.titolo)}</h2>` + (v.perche ? `<p class="d">${e(v.perche)}</p>` : "");
    v.parti.forEach((_, i) => {
      const c = capitolo(v, i);
      const cta = ctaDi(c.cta);
      x += `<h3>${e(etichettaCap(v, i))} · ${e(c.titolo)}</h3>`;
      if (c.domanda) x += `<p class="d">Marc: ${e(c.domanda)}</p>`;
      x += `<p class="r">${e(c.gancio)}</p>`;
      if (c.spunti.length) x += "<ul>" + c.spunti.map((s) => `<li>${e(s)}</li>`).join("") + "</ul>";
      if (c.chiusura) x += `<p>Per chiudere: ${e(c.chiusura)}</p>`;
      if (c.attenzione) x += `<p class="g">Per i social: ${e(c.attenzione)}</p>`;
      if (cta) x += `<p class="r">Frase finale ${e(cta.nome)}: ${e(cta.testo)}</p>`;
      if (c.fonte) x += `<p class="g">Dal tuo libro: ${e(c.fonte)}</p>`;
    });
  }
  if (tutto && pod.cta?.length) {
    x += "<h2>Le frasi finali (si registrano una volta sola, alla fine)</h2>";
    for (const c of pod.cta) x += `<p class="r">${e(c.nome)}. ${e(c.testo)}</p><p class="g">${e(c.quando)}</p>`;
  }
  x += "</body></html>";
  const nome = pulito(tutto ? `${S.dati.persona || ""} Podcast tutte le puntate` : `${S.dati.persona || ""} Podcast ${lista[0].titolo.split("·")[0]}`) + ".doc";
  const a = h("a", { href: URL.createObjectURL(new Blob(["﻿", x], { type: "application/msword" })), download: nome });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  avviso("Scaricato: lo trovi nella cartella Download e si apre con Word.");
}

async function registraMenu() {
  fermaCamera();
  const riprese = await Archivio.tutte().catch(() => []);
  const conta = (v) => riprese.filter((r) => r.video === v.id).length;
  const scheda = (v, bottone, meta) => h("article", { class: "scheda" },
    h("h2", {}, v.titolo),
    h("p", { class: "meta" }, meta),
    h("div", { class: "azioni" }, h("button", { class: "bottone oro", onclick: () => vai(prepara, v) }, bottone)),
    conta(v) ? h("button", { class: "link", onclick: () => vai(rivedi, v) }, `Le tue riprese (${conta(v)}) →`) : null);
  pagina(h("main", { class: "carta" }, indietro("Inizio"),
    h("p", { class: "occhiello" }, "Registra da remoto"),
    h("h1", {}, "Registra da dove sei"),
    h("p", { class: "lead" }, "A Roma le domande te le faccio io. Se un giorno devi registrare da solo, funziona così:"),
    h("ol", { class: "passi-rec" },
      h("li", {}, h("b", {}, "Prepari la stanza e provi camera e microfono. "), "Ci vogliono due minuti, ti guido passo passo."),
      h("li", {}, h("b", {}, "Compare la domanda, "), "e se vuoi te la legge una voce, come se te la facessi io."),
      h("li", {}, h("b", {}, "Dici la prima frase in rosso, "), "poi racconti con parole tue seguendo gli spunti. Una barra ti dice quando ti avvicini al minuto."),
      h("li", {}, h("b", {}, "Riguardi la risposta, "), "la tieni o la rifai, e passi alla domanda dopo. Alla fine scarichi le riprese con la ★ e me le mandi.")),
    perSezione((v) => scheda(v, v.sezione === "podcast" ? "Registra le risposte" : "Registra con gli spunti", `${contaParti(v)} · una alla volta, o tutto di fila`)),
    S.dati.video.length ? [h("h2", { class: "sezione" }, "Le versioni integrali, col gobbo"),
      h("div", { class: "schede" }, S.dati.video.map((v) => scheda(v, "Registra col gobbo", [v.durata, `${v.parti.length} ${v.parti.length === 1 ? "parte" : "parti"}`].filter(Boolean).join(" · "))))] : null,
    h("p", { class: "nota" }, DISPOSITIVO.telefono ? "Funziona anche dal telefono: tienilo in orizzontale, fermo su un appoggio." : "Va meglio con Chrome sul Mac. Funziona anche con Safari e dal telefono, in orizzontale.")));
}

// ---------------------------------------------------------------- 3. preparazione passo passo
function prepara(v, passo = 1) {
  S.video = v;
  const passi = ["La stanza", "Camera e microfono", "Prova di 5 secondi"];
  const testa = h("div", { class: "passi" }, passi.map((t, i) => h("span", { class: i + 1 === passo ? "attivo" : i + 1 < passo ? "fatto" : "" }, `${i + 1}. ${t}`)));
  if (passo === 1) {
    return pagina(h("main", { class: "carta" }, indietro(), h("p", { class: "occhiello" }, v.titolo), testa,
      h("h1", {}, "Prepara la stanza"),
      h("ul", { class: "lista-pronti" },
        h("li", {}, h("b", {}, "Luce davanti a te. "), "Una finestra o una lampada di fronte, mai alle spalle."),
        h("li", {}, h("b", {}, "Camera all'altezza degli occhi. "), DISPOSITIVO.telefono ? "Telefono in orizzontale, fermo su un appoggio, non in mano." : "Alza il Mac su qualche libro, così non riprende dal basso."),
        h("li", {}, h("b", {}, "A un braccio di distanza. "), "Si devono vedere la testa e le spalle, con un po' di spazio sopra."),
        h("li", {}, h("b", {}, "Silenzio. "), "Telefono in silenzioso, finestre chiuse, niente televisione."),
        v.podcast
          ? h("li", {}, h("b", {}, "Niente da leggere. "), "Sotto la camera compaiono la domanda, la prima frase e tre spunti: guarda in camera e rispondi come al Symposium.")
          : h("li", {}, h("b", {}, "Il testo sarà sotto la camera. "), "Leggi la riga gialla: così sembra che guardi chi ti ascolta.")),
      h("div", { class: "barra-azioni" }, h("button", { class: "bottone oro grande", onclick: () => prepara(v, 2) }, "Fatto, avanti"))));
  }
  if (passo === 2) {
    const anteprima = h("video", { class: "anteprima-piccola" + (P.specchiaMe ? " specchio" : ""), muted: true, playsinline: true, autoplay: true });
    const barra = h("div", { class: "livello" }, h("i"));
    const info = h("p", { class: "nota" });
    const scelte = h("div", { class: "scelte-dispositivi" });
    const avanti = h("button", { class: "bottone oro grande", disabled: true, onclick: () => prepara(v, 3) }, "Mi vedo e mi sento, avanti");
    const accendi = h("button", { class: "bottone oro grande", onclick: async () => {
      accendi.disabled = true;
      accendi.textContent = "Aspetto il permesso…";
      try {
        await accendiCamera();
        accendi.remove();
        anteprima.srcObject = S.stream;
        anteprima.play().catch(() => {});
        avanti.disabled = false;
        info.textContent = descriviCamera();
        await riempiScelte(scelte, anteprima, info);
        misuraLivello((db) => { barra.firstChild.style.width = Math.max(0, Math.min(100, (db + 60) * 1.8)) + "%"; barra.classList.toggle("ok", db > -40); });
      } catch (e) {
        accendi.disabled = false;
        accendi.textContent = "Riprova";
        info.replaceChildren(spiegaErroreCamera(e));
      }
    } }, "Accendi camera e microfono");
    pagina(h("main", { class: "carta" }, indietro(), h("p", { class: "occhiello" }, v.titolo), testa,
      h("h1", {}, "Camera e microfono"),
      h("p", { class: "lead" }, "Premi il bottone e, quando il browser lo chiede, rispondi «Consenti». Poi parla: la barra deve diventare verde."),
      h("div", { class: "prova-camera" }, anteprima, barra), accendi, info, scelte,
      h("div", { class: "barra-azioni" }, avanti)));
    if (S.stream) accendi.click();
    return;
  }
  // passo 3: prova di 5 secondi
  provaBreve(v, testa);
}

async function accendiCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("NO_API");
  if (S.stream && S.stream.getTracks().every((t) => t.readyState === "live")) return S.stream;
  fermaCamera();
  const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  if (P.cam) video.deviceId = { exact: P.cam };
  else video.facingMode = "user";
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (P.mic) audio.deviceId = { exact: P.mic };
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (e) {
    if (e.name === "OverconstrainedError" || e.name === "NotFoundError") {
      P.cam = P.mic = "";
      salvaPref();
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
    } else throw e;
  }
  return S.stream;
}
function fermaCamera() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
}
function descriviCamera() {
  const s = S.stream?.getVideoTracks()[0]?.getSettings() || {};
  if (!s.width) return "";
  const q = Math.max(s.width, s.height) >= 1920 ? "qualità piena (Full HD)" : Math.max(s.width, s.height) >= 1280 ? "qualità buona (HD)" : "qualità bassa: se puoi usa un'altra camera";
  return `Camera: ${s.width}×${s.height}, ${q}.`;
}
async function riempiScelte(box, anteprima, info) {
  const dev = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const cams = dev.filter((d) => d.kind === "videoinput");
  const mics = dev.filter((d) => d.kind === "audioinput");
  const attCam = S.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  const attMic = S.stream?.getAudioTracks()[0]?.getSettings().deviceId;
  const sel = (lista, attuale, chiave, etichetta) => {
    if (lista.length < 2) return null;
    const s = h("select", { onchange: async () => {
      P[chiave] = s.value;
      salvaPref();
      fermaCamera();
      await accendiCamera();
      anteprima.srcObject = S.stream;
      anteprima.play().catch(() => {});
      info.textContent = descriviCamera();
      misuraLivello(S.suLivello);
    } }, lista.map((d, i) => h("option", { value: d.deviceId, selected: d.deviceId === attuale }, d.label || `${etichetta} ${i + 1}`)));
    return h("label", {}, etichetta, s);
  };
  box.replaceChildren(...[sel(cams, attCam, "cam", "Camera"), sel(mics, attMic, "mic", "Microfono")].filter(Boolean));
}
function spiegaErroreCamera(e) {
  const n = e?.name || e?.message;
  let t;
  if (n === "NotAllowedError" || n === "SecurityError")
    t = DISPOSITIVO.safari
      ? "Il permesso è stato negato. In alto: Safari → Impostazioni per questo sito → Fotocamera e Microfono su «Consenti», poi ricarica la pagina."
      : "Il permesso è stato negato. Clicca il lucchetto a sinistra dell'indirizzo, metti Fotocamera e Microfono su «Consenti», poi ricarica la pagina. Sul Mac controlla anche Impostazioni di Sistema → Privacy e sicurezza → Fotocamera.";
  else if (n === "NotReadableError") t = "La camera è usata da un'altra app (Zoom, FaceTime, Photo Booth…). Chiudila e riprova.";
  else if (n === "NotFoundError") t = "Non trovo nessuna camera o microfono collegati.";
  else if (n === "NO_API") t = "Questo browser non può usare la camera. Apri il link con Chrome o Safari.";
  else t = "La camera non si è accesa (" + n + "). Ricarica la pagina e riprova.";
  return h("span", { class: "avviso" }, t);
}
function misuraLivello(cb) {
  S.suLivello = cb;
  try {
    if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.audioCtx.resume();
    if (S.sorgente) S.sorgente.disconnect();
    S.sorgente = S.audioCtx.createMediaStreamSource(S.stream);
    S.analizzatore = S.audioCtx.createAnalyser();
    S.analizzatore.fftSize = 2048;
    S.sorgente.connect(S.analizzatore);
  } catch (e) {
    console.warn("niente misura del livello", e);
    return;
  }
  const buf = new Float32Array(S.analizzatore.fftSize);
  const giro = () => {
    if (!S.analizzatore) return;
    S.analizzatore.getFloatTimeDomainData(buf);
    let q = 0;
    for (const x of buf) q += x * x;
    S.livello = 10 * Math.log10(q / buf.length + 1e-12);
    if (S.suLivello) S.suLivello(S.livello);
    S.rafLivello = requestAnimationFrame(giro);
  };
  cancelAnimationFrame(S.rafLivello);
  giro();
}

// La prova: 5 secondi con il gobbo che segue la voce; controlla che il file abbia l'audio e che il gobbo segua.
function provaBreve(v, testa) {
  const frase = "Sto facendo una prova del gobbo. Mi vedo bene, mi sento bene, e il testo va avanti mentre parlo.";
  const box = h("div", { class: "prova-gobbo" });
  const esito = h("div", { class: "esito" });
  const entra = () => { S.pila[S.pila.length - 1] = [studio, [v, 0]]; mostra(studio, [v, 0]); };
  const vai3 = h("button", { class: "bottone oro grande", onclick: entra }, "Avanti, si registra");
  const via = h("button", { class: "bottone grande", onclick: async () => {
    via.disabled = true;
    esito.replaceChildren(h("p", { class: "nota" }, "Leggi la frase ad alta voce, con calma…"));
    const g = new Gobbo(box, [{ testo: frase }], { modo: P.modo, prova: true });
    try { await accendiCamera(); } catch (e) { via.disabled = false; esito.replaceChildren(spiegaErroreCamera(e)); return; }
    const rec = new Registratore(S.stream);
    let massimo = -100;
    misuraLivello((db) => { massimo = Math.max(massimo, db); });
    await contoAllaRovescia(box, 3);
    rec.avvia();
    g.avvia();
    await pausa(7000);
    g.ferma();
    const r = await rec.ferma();
    const avanti = g.indice;
    const voceOk = g.voceAttiva && avanti >= 4;
    const audioOk = massimo > -50 && (await audioNelFile(r.blob)) !== false;
    const righe = [];
    righe.push(audioOk ? h("p", { class: "ok" }, "✓ La voce si sente.") : h("p", { class: "ko" }, "✗ Nel video la voce non si sente. Controlla il microfono qui sopra (passo 2) e rifai la prova."));
    if (P.modo === "voce") {
      if (voceOk && audioOk) righe.push(h("p", { class: "ok" }, "✓ Il gobbo segue la tua voce."));
      else if (!g.voceSupportata) { P.modo = "velocita"; righe.push(h("p", { class: "nota" }, "Questo browser non sa seguire la voce: il gobbo andrà a velocità fissa (la regoli con + e −). Con Chrome sul Mac segue la voce.")); }
      else if (!audioOk) { P.modo = "velocita"; righe.push(h("p", { class: "nota" }, "Con «segue la voce» il microfono non registrava: l'ho spento. Il gobbo andrà a velocità fissa. Rifai la prova per controllare la voce.")); }
      else { righe.push(h("p", { class: "nota" }, "Il gobbo non ha seguito la voce" + (g.erroreVoce ? ` (${g.erroreVoce})` : "") + ". Puoi rifare la prova o usare la velocità fissa.")); }
      salvaPref();
    }
    const player = h("video", { class: "anteprima-piccola", controls: true, playsinline: true, src: URL.createObjectURL(r.blob) });
    esito.replaceChildren(...righe, player);
    via.disabled = false;
    via.textContent = "Rifai la prova";
  } }, "Fai la prova");
  pagina(h("main", { class: "carta" }, indietro(), h("p", { class: "occhiello" }, v.titolo), testa,
    h("h1", {}, "Prova di 5 secondi"),
    h("p", { class: "lead" }, "Premi «Fai la prova» e leggi la frase che compare. Controllo che la voce si senta e che il testo ti segua."),
    h("div", { class: "box-scuro" }, box), via, esito,
    h("div", { class: "barra-azioni" }, vai3, h("button", { class: "link", onclick: entra }, "Salta la prova"))));
  new Gobbo(box, [{ testo: frase }], { modo: P.modo, prova: true });
}
async function audioNelFile(blob) {
  try {
    const ctx = S.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const d = buf.getChannelData(0);
    let m = 0;
    for (let i = 0; i < d.length; i += 64) m = Math.max(m, Math.abs(d[i]));
    return m > 0.01;
  } catch {
    return null; // non decodificabile qui: non lo so
  }
}
async function contoAllaRovescia(dove, n) {
  const c = h("div", { class: "conto" });
  dove.append(c);
  for (let i = n; i > 0; i--) {
    c.textContent = i;
    c.classList.remove("pulsa");
    void c.offsetWidth;
    c.classList.add("pulsa");
    await pausa(1000);
  }
  c.remove();
}

// ---------------------------------------------------------------- il gobbo
// Il testo diviso in parole (ognuna uno <span>), una riga di lettura fissa, lo scorrimento morbido.
// modo "voce": va avanti con le parole riconosciute; modo "velocita": va avanti da solo, P.wpm parole al minuto.
class Gobbo {
  constructor(box, parti, opz = {}) {
    this.box = box;
    this.opz = opz;
    this.modo = opz.modo || "voce";
    this.indice = 0; // prossima parola da leggere
    this.base = 0; // inizio della frase che il riconoscimento sta ascoltando
    this.attivo = false;
    this.pausa = false;
    this.parole = [];
    this.norm = [];
    box.replaceChildren();
    box.classList.add("gobbo");
    const scorri = h("div", { class: "gobbo-scorri" });
    const testo = h("div", { class: "gobbo-testo" });
    for (const p of parti) {
      if (p.titolo) testo.append(h("div", { class: "gobbo-titolo" }, p.titolo));
      for (const riga of p.testo.split("\n").filter((r) => r.trim())) {
        const par = h("p", {});
        for (const pezzo of riga.split(/([\p{L}\p{N}]+)/u)) {
          if (!pezzo) continue;
          if (/^[\p{L}\p{N}]+$/u.test(pezzo)) {
            const i = this.parole.length;
            const s = h("span", { class: "w", "data-i": i }, pezzo);
            this.parole.push(s);
            this.norm.push(normalizza(pezzo));
            par.append(s);
          } else if (par.lastChild?.classList?.contains("w")) par.lastChild.append(pezzo);
          else par.append(pezzo);
        }
        testo.append(par);
      }
    }
    testo.append(h("div", { class: "gobbo-fine" }, opz.prova ? "" : "FINE"));
    scorri.append(testo);
    box.append(scorri, h("div", { class: "linea-lettura" }));
    this.scorri = scorri;
    this.testo = testo;
    this.y = 0;
    testo.addEventListener("click", (e) => {
      const i = e.target.dataset?.i;
      if (i !== undefined) { this.vaiA(+i, true); this.daQui = !this.attivo; }
    });
    this.rigaLettura = opz.prova ? 0.3 : 0.26;
    box.style.setProperty("--riga", this.rigaLettura * 100 + "%");
    this.applicaStile();
    this.segna(0);
    requestAnimationFrame(() => this.scorriA(true));
    this.voceSupportata = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
  applicaStile() {
    this.box.style.setProperty("--font", (this.opz.prova ? Math.min(P.font, 34) : P.font) + "px");
    this.box.classList.toggle("specchio-testo", !!P.specchio && !this.opz.prova);
  }
  get fine() { return this.indice >= this.parole.length; }
  segna(nuovo) {
    nuovo = Math.max(0, Math.min(this.parole.length, nuovo));
    const da = Math.min(nuovo, this.segnato ?? 0), a = Math.max(nuovo, this.segnato ?? 0);
    for (let i = da; i <= a && i < this.parole.length; i++) this.parole[i].classList.toggle("letto", i < nuovo);
    if (this.parolaOra) this.parolaOra.classList.remove("ora");
    this.parolaOra = this.parole[nuovo] || null;
    if (this.parolaOra) this.parolaOra.classList.add("ora");
    this.segnato = nuovo;
  }
  vaiA(i, aMano = false) {
    this.indice = Math.max(0, Math.min(this.parole.length, i));
    this.ultimoMovimento = performance.now();
    if (aMano) { this.base = this.indice; this.virgola = this.indice; }
    this.segna(Math.floor(this.indice));
    if (this.suFine && this.fine) this.suFine();
  }
  scorriA(subito = false) {
    const w = this.parole[Math.min(Math.floor(this.indice), this.parole.length - 1)];
    if (!w) return;
    const riga = this.box.clientHeight * this.rigaLettura;
    const meta = w.offsetTop - riga + w.offsetHeight / 2;
    this.y = subito ? meta : this.y + (meta - this.y) * 0.12;
    this.testo.style.transform = `translateY(${-this.y}px)`;
  }
  avvia() {
    this.attivo = true;
    this.pausa = false;
    this.virgola = this.indice;
    let prima = performance.now();
    const giro = (ora) => {
      if (!this.attivo) return;
      const dt = Math.min(0.1, (ora - prima) / 1000);
      prima = ora;
      if (this.modo === "velocita" && !this.pausa && !this.fine) {
        this.virgola += (P.wpm / 60) * dt;
        if (Math.floor(this.virgola) !== Math.floor(this.indice)) this.vaiA(Math.floor(this.virgola));
        else this.indice = this.virgola;
      }
      this.scorriA();
      this.raf = requestAnimationFrame(giro);
    };
    this.raf = requestAnimationFrame(giro);
    if (this.modo === "voce") this.ascolta();
  }
  ferma() {
    this.attivo = false;
    cancelAnimationFrame(this.raf);
    this.smettiDiAscoltare();
  }
  cambiaModo(m) {
    this.modo = m;
    if (!this.attivo) return;
    this.virgola = this.indice;
    if (m === "voce") this.ascolta();
    else this.smettiDiAscoltare();
  }
  ascolta() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.erroreVoce = "non supportato"; this.suErroreVoce?.("non supportato"); return; }
    if (this.rec) return;
    const rec = new SR();
    this.rec = rec;
    rec.lang = "it-IT";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.base = Math.floor(this.indice);
    rec.onresult = (e) => {
      let finale = "", provvisorio = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finale += " " + r[0].transcript;
        else provvisorio += " " + r[0].transcript;
      }
      this.voceAttiva = true;
      if (finale.trim()) {
        const i = trovaPosizione(finale, this.norm, this.base, Math.floor(this.indice));
        this.base = Math.max(this.base, i);
        if (i > this.indice) this.vaiA(i);
      }
      if (provvisorio.trim()) {
        const i = trovaPosizione(provvisorio, this.norm, this.base, Math.floor(this.indice));
        if (i > this.indice) this.vaiA(i);
      }
    };
    rec.onerror = (e) => {
      this.erroreVoce = e.error;
      if (e.error !== "no-speech" && e.error !== "aborted") {
        const ora = performance.now();
        this.errori = (this.errori || []).filter((t) => ora - t < 15000).concat(ora);
      }
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "language-not-supported" || this.errori?.length >= 4) {
        this.voceRotta = true;
        this.suErroreVoce?.(e.error);
      }
    };
    rec.onend = () => {
      // il riconoscimento si ferma da solo dopo un po' di silenzio: se il gobbo è acceso lo riaccendo
      if (this.attivo && this.modo === "voce" && this.rec === rec && !this.voceRotta) {
        this.base = Math.floor(this.indice);
        try { rec.start(); } catch { setTimeout(() => { try { rec.start(); } catch {} }, 250); }
      }
    };
    try { rec.start(); } catch (e) { this.erroreVoce = e.message; }
  }
  smettiDiAscoltare() {
    const rec = this.rec;
    this.rec = null;
    if (rec) { rec.onend = null; try { rec.abort(); } catch {} }
  }
}

// normalizza una parola per il confronto: minuscole, senza accenti
function normalizza(w) {
  return w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
// i numeri detti a voce arrivano spesso in cifre («90», «30.000»): li riporto a parole come nel testo
const UNITA = ["zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"];
const DECINE = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];
function numeroInParole(n) {
  if (n < 20) return UNITA[n];
  if (n < 100) {
    const d = DECINE[Math.floor(n / 10)], u = n % 10;
    if (!u) return d;
    return (u === 1 || u === 8 ? d.slice(0, -1) : d) + (u === 3 ? "tre" : UNITA[u]);
  }
  if (n < 1000) {
    const c = Math.floor(n / 100), r = n % 100;
    const cc = (c === 1 ? "" : UNITA[c]) + "cento";
    return r ? (Math.floor(r / 10) === 8 ? cc.slice(0, -1) : cc) + numeroInParole(r) : cc;
  }
  if (n < 1000000) {
    const m = Math.floor(n / 1000), r = n % 1000;
    return (m === 1 ? "mille" : numeroInParole(m) + "mila") + (r ? numeroInParole(r) : "");
  }
  return String(n);
}
function paroleSentite(testo) {
  const t = testo.replace(/(\d)[.,'’ ](?=\d{3}\b)/g, "$1");
  return (t.match(/[\p{L}\p{N}]+/gu) || []).map((w) => (/^\d+$/.test(w) ? numeroInParole(+w) : normalizza(w)));
}
// Dove è arrivato chi legge: confronto (Levenshtein) fra la frase sentita e i pezzi di testo che partono da `base`.
// Una sola tabella: l'ultima riga dà la distanza fra la frase sentita e ogni inizio del testo.
function trovaPosizione(sentito, norm, base, attuale) {
  let parole = paroleSentite(sentito);
  if (!parole.length) return attuale;
  let da = base;
  if (parole.length > 14) { // frase lunga (Safari la allunga sempre): bastano le ultime parole, intorno al punto attuale
    parole = parole.slice(-10);
    da = Math.max(base, attuale - 12);
  }
  const fino = Math.min(norm.length, da + parole.length * 2 + 12);
  if (da >= fino) return attuale;
  const a = parole.join(" ");
  let b = "";
  const fineParola = []; // posizione nel testo b dove finisce la parola k
  for (let k = da; k < fino; k++) {
    b += (b ? " " : "") + norm[k];
    fineParola.push(b.length);
  }
  const n = a.length, m = b.length;
  let prec = new Array(m + 1), riga = new Array(m + 1);
  for (let j = 0; j <= m; j++) prec[j] = j * 0.25;
  for (let i = 1; i <= n; i++) {
    riga[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const costo = ca === b.charCodeAt(j - 1) ? 0 : 1;
      riga[j] = Math.min(prec[j] + 1, riga[j - 1] + 1, prec[j - 1] + costo);
    }
    [prec, riga] = [riga, prec];
  }
  let migliore = -1, dist = Infinity;
  fineParola.forEach((pos, k) => {
    if (prec[pos] < dist) { dist = prec[pos]; migliore = k; } // a parità vince la più vicina
  });
  if (migliore < 0 || dist > Math.max(3, n * 0.45)) return attuale; // non somiglia al testo: sta improvvisando
  return da + migliore + 1;
}

// ---------------------------------------------------------------- registrazione
class Registratore {
  constructor(stream) {
    this.stream = stream;
    const candidati = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    this.mime = (window.MediaRecorder && candidati.find((c) => MediaRecorder.isTypeSupported?.(c))) || "";
  }
  avvia() {
    this.pezzi = [];
    const s = this.stream.getVideoTracks()[0]?.getSettings() || {};
    const alta = Math.max(s.width || 0, s.height || 0) >= 1920;
    const opz = { videoBitsPerSecond: alta ? 8_000_000 : 5_000_000, audioBitsPerSecond: 192_000 };
    if (this.mime) opz.mimeType = this.mime;
    this.mr = new MediaRecorder(this.stream, opz);
    this.mr.ondataavailable = (e) => e.data?.size && this.pezzi.push(e.data);
    this.inizio = performance.now();
    this.mr.start(1000);
    this.w = s.width; this.h = s.height;
  }
  ferma() {
    return new Promise((ok) => {
      if (!this.mr || this.mr.state === "inactive") return ok(null);
      this.mr.onstop = () => {
        const tipo = this.mr.mimeType || this.mime || "video/webm";
        ok({ blob: new Blob(this.pezzi, { type: tipo.split(";")[0] }), mime: tipo, durata: (performance.now() - this.inizio) / 1000, w: this.w, h: this.h });
      };
      this.mr.stop();
    });
  }
}
const estensione = (mime) => (/mp4/.test(mime) ? "mp4" : "webm");

// ---------------------------------------------------------------- 4. lo studio di registrazione
function studio(v, parte = 0) {
  if (v.podcast) return studioPodcast(v, parte);
  S.video = v;
  const tutto = parte === -1;
  const parti = tutto ? v.parti.map((p, i) => ({ titolo: `${i + 1} · ${p.titolo}`, testo: testoParte(v, i) })) : [{ testo: testoParte(v, parte) }];
  const nomeParte = tutto ? "Tutto il video di fila" : v.parti.length > 1 ? `Parte ${parte + 1} di ${v.parti.length} · ${v.parti[parte].titolo}` : v.parti[parte].titolo;

  const anteprima = h("video", { class: "anteprima" + (P.specchiaMe ? " specchio" : "") + (P.mostraMe ? "" : " nascosta"), muted: true, playsinline: true, autoplay: true });
  const box = h("div", { class: `gobbo-box largo-${P.larghezza}` });
  const stato = h("div", { class: "stato" });
  const titolo = h("div", { class: "titolo-parte" }, h("span", { class: "nome-video" }, v.titolo), h("b", {}, nomeParte), v.parti[parte]?.nota ? h("em", {}, " · " + v.parti[parte].nota) : null);
  const suggerimento = h("div", { class: "suggerimento" });
  const comandi = h("div", { class: "comandi" });
  const vista = h("div", { class: "studio" }, anteprima, box, h("div", { class: "barra-alta" }, titolo, stato), h("div", { class: "barra-bassa" }, suggerimento, comandi));
  const app = $("#app");
  app.className = "pieno";
  app.replaceChildren(vista);
  posizionaGobbo(box);

  const g = new Gobbo(box, parti, { modo: P.modo });
  S.gobbo = g;
  let rec = null, registrando = false, soloProva = false, t0 = 0, timer = 0, silenzioDa = 0, fineTimer = 0;

  const dici = (t) => { suggerimento.textContent = t; };
  const bottone = (testo, cls, fn, titoloTasto) => h("button", { class: "tasto " + (cls || ""), onclick: fn, title: titoloTasto || "" }, testo);
  const disegnaComandi = () => {
    const modo = h("div", { class: "interruttore" },
      bottone("Segue la voce", P.modo === "voce" ? "acceso" : "", () => cambiaModo("voce")),
      bottone("Velocità fissa", P.modo === "velocita" ? "acceso" : "", () => cambiaModo("velocita")));
    const vel = P.modo === "velocita" ? h("div", { class: "gruppo" }, bottone("−", "tondo", () => velocita(-10), "più lento (freccia giù)"), h("span", { class: "valore" }, `${P.wpm} parole/min`), bottone("+", "tondo", () => velocita(10), "più veloce (freccia su)")) : null;
    if (registrando || soloProva) {
      comandi.replaceChildren(
        bottone(g.pausa ? "▶ Riprendi" : "❚❚ Pausa", "", () => pausaGobbo(), "barra spaziatrice"),
        h("button", { class: "tasto-rec stop", onclick: () => stop(), title: "Invio" }, h("i"), registrando ? "Stop" : "Fine prova"),
        vel || modo);
      return;
    }
    const nav = v.parti.length > 1 ? h("div", { class: "gruppo" },
      bottone("◀", "tondo", () => parte > 0 && cambiaParte(parte - 1), "parte prima"),
      h("select", { class: "scegli-parte", onchange: (e) => cambiaParte(+e.target.value) },
        v.parti.map((p, i) => h("option", { value: i, selected: i === parte }, `${i + 1}. ${p.titolo}`)),
        h("option", { value: -1, selected: tutto }, "Tutto di fila")),
      bottone("▶", "tondo", () => parte < v.parti.length - 1 && cambiaParte(parte + 1), "parte dopo")) : null;
    comandi.replaceChildren(
      nav || h("span"),
      h("div", { class: "gruppo centro" },
        h("button", { class: "tasto-rec", onclick: () => via(false), title: "Invio" }, h("i"), "Registra"),
        bottone("Prova senza registrare", "", () => via(true))),
      h("div", { class: "gruppo" }, modo, vel, bottone("⚙", "tondo", () => impostazioni(), "impostazioni"), bottone("✕", "tondo", () => history.back(), "esci")));
  };
  const cambiaParte = (p) => {
    if (p >= v.parti.length || p < -1) return;
    history.replaceState({ n: S.pila.length }, "");
    S.pila[S.pila.length - 1] = [studio, [v, p]];
    mostra(studio, [v, p]);
  };
  const cambiaModo = (m) => { P.modo = m; salvaPref(); g.cambiaModo(m); disegnaComandi(); dici(consiglio()); };
  const velocita = (d) => { P.wpm = Math.max(60, Math.min(260, P.wpm + d)); salvaPref(); disegnaComandi(); };
  const pausaGobbo = () => { g.pausa = !g.pausa; if (P.modo === "voce") g.pausa ? g.smettiDiAscoltare() : g.ascolta(); disegnaComandi(); };
  const consiglio = () => P.modo === "voce"
    ? "Il testo va avanti quando parli. Leggi la riga gialla, vicino alla camera. Se sbagli una frase, ripetila e continua."
    : "Il testo va avanti da solo. Se va troppo veloce premi −, se è lento premi +. La barra spaziatrice lo ferma.";
  g.suErroreVoce = (err) => {
    if (P.modo !== "voce") return;
    P.modo = "velocita"; salvaPref(); g.cambiaModo("velocita"); disegnaComandi();
    dici(err === "non supportato" ? "Questo browser non sa seguire la voce: il testo va a velocità fissa. Con Chrome segue la voce." : "Il riconoscimento della voce non funziona qui: il testo va a velocità fissa (+ e − per regolarla).");
  };

  const via = async (prova) => {
    if (registrando || soloProva) return;
    try { await accendiCamera(); } catch (e) { dici(""); suggerimento.replaceChildren(spiegaErroreCamera(e)); return; }
    anteprima.srcObject = S.stream;
    if (!prova && !window.MediaRecorder) { dici("Questo browser non può registrare. Usa Chrome o Safari aggiornati."); return; }
    soloProva = prova;
    comandi.replaceChildren();
    dici(prova ? "Prova: niente viene registrato." : "Si parte fra 3 secondi. Guarda in camera.");
    if (!g.daQui || g.fine) g.vaiA(0, true);
    g.daQui = false;
    g.scorriA(true);
    S.audioCtx?.resume?.();
    await contoAllaRovescia(vista, 3);
    if (!prova) {
      rec = new Registratore(S.stream);
      rec.avvia();
      registrando = true;
      t0 = performance.now();
      silenzioDa = 0;
      timer = setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        stato.replaceChildren(h("span", { class: "rec" }, h("i"), "REC " + mmss(s)));
        if (S.audioCtx?.state === "running" && S.livello < -55) {
          silenzioDa = silenzioDa || performance.now();
          if (performance.now() - silenzioDa > 7000) dici("Non sento la tua voce: controlla il microfono. Se è tutto a posto, ignora questo messaggio.");
        } else silenzioDa = 0;
        if (P.modo === "voce" && !g.pausa && !g.fine && S.livello > -42 && performance.now() - (g.ultimoMovimento || t0) > 9000)
          dici("Il testo non ti segue? Premi «Velocità fissa»: andrà avanti da solo.");
      }, 250);
    } else stato.replaceChildren(h("span", { class: "prova" }, "PROVA"));
    g.ultimoMovimento = performance.now();
    g.avvia();
    disegnaComandi();
    dici(consiglio());
  };
  g.suFine = () => {
    if (!(registrando || soloProva) || fineTimer) return;
    if (P.modo === "voce" && P.autoStop) {
      dici("Fine. Resta un attimo a guardare in camera…");
      fineTimer = setTimeout(() => stop(), 2500);
    } else dici("Fine del testo. Quando hai finito di parlare premi Stop (o Invio).");
  };
  const stop = async () => {
    clearTimeout(fineTimer); fineTimer = 0;
    clearInterval(timer);
    g.ferma();
    stato.replaceChildren();
    if (soloProva) { soloProva = false; disegnaComandi(); dici("Prova finita. Quando sei pronto premi Registra."); return; }
    if (!registrando) return;
    registrando = false;
    dici("Salvo la ripresa…");
    const r = await rec.ferma();
    if (!r || !r.blob.size) { dici("La ripresa è vuota: riprova."); disegnaComandi(); return; }
    const tutte = await Archivio.tutte();
    const n = tutte.filter((x) => x.video === v.id && x.parte === parte).length + 1;
    const ripresa = { id: "r" + Date.now(), persona: S.persona, video: v.id, parte, n, blob: r.blob, mime: r.mime, durata: r.durata, w: r.w, h: r.h, creata: Date.now(), scelta: false, letta: g.fine };
    try { await Archivio.metti(ripresa); }
    catch (e) { dici("Non riesco a salvare la ripresa (spazio pieno?). La scarico subito."); scarica(ripresa, v); }
    mostra(dopoRipresa, [v, ripresa]);
    S.pila[S.pila.length - 1] = [studio, [v, parte]];
  };

  // tastiera: Invio registra/ferma, spazio pausa, frecce velocità e righe
  S.tasti = (e) => {
    if (e.target.closest?.("select,input,textarea")) return;
    if (e.key === "Enter") { e.preventDefault(); registrando || soloProva ? stop() : via(false); }
    else if (e.key === " ") { e.preventDefault(); if (registrando || soloProva) pausaGobbo(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); velocita(10); }
    else if (e.key === "ArrowDown") { e.preventDefault(); velocita(-10); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); g.vaiA(Math.floor(g.indice) - 8, true); }
    else if (e.key === "ArrowRight") { e.preventDefault(); g.vaiA(Math.floor(g.indice) + 8, true); }
    else if (e.key === "Escape" && !(registrando || soloProva)) history.back();
  };
  document.addEventListener("keydown", S.tasti);
  S.riposiziona = () => posizionaGobbo(box);
  window.addEventListener("resize", S.riposiziona);
  screen.orientation?.addEventListener?.("change", S.riposiziona);
  S.esciStudio = async () => { if (registrando) { registrando = false; await rec.ferma(); } g.ferma(); clearInterval(timer); };

  disegnaComandi();
  dici(DISPOSITIVO.telefono ? "Tocca Registra quando sei pronto. Tocca una parola per far ripartire il testo da lì." : "Premi Registra (o Invio) quando sei pronto. Clicca una parola per far ripartire il testo da lì.");
  accendiCamera().then(() => {
    anteprima.srcObject = S.stream;
    anteprima.play().catch(() => {});
    misuraLivello(null);
  }).catch((e) => suggerimento.replaceChildren(spiegaErroreCamera(e)));
  tieniAcceso();

  function impostazioni() {
    const riga = (etichetta, ctrl) => h("label", { class: "riga-imp" }, h("span", {}, etichetta), ctrl);
    const spunta = (k, poi) => h("input", { type: "checkbox", checked: !!P[k], onchange: (e) => { P[k] = e.target.checked; salvaPref(); poi?.(); } });
    const font = h("input", { type: "range", min: 22, max: 80, step: 2, value: P.font, oninput: (e) => { P.font = +e.target.value; salvaPref(); g.applicaStile(); } });
    const larg = h("select", { onchange: (e) => { P.larghezza = e.target.value; salvaPref(); box.className = box.className.replace(/largo-\S+/, "largo-" + P.larghezza); posizionaGobbo(box); } },
      [["stretto", "Stretto (occhi più fermi)"], ["medio", "Medio"], ["largo", "Largo"]].map(([k, t]) => h("option", { value: k, selected: P.larghezza === k }, t)));
    const pannello = h("div", { class: "pannello" },
      h("h3", {}, "Impostazioni"),
      riga("Grandezza del testo", font),
      riga("Larghezza del gobbo", larg),
      riga("Vedi la tua immagine", spunta("mostraMe", () => anteprima.classList.toggle("nascosta", !P.mostraMe))),
      riga("Immagine a specchio", spunta("specchiaMe", () => anteprima.classList.toggle("specchio", P.specchiaMe))),
      riga("Testo rovesciato (per il vetro del gobbo)", spunta("specchio", () => g.applicaStile())),
      riga("Fermati da solo a fine testo", spunta("autoStop")),
      DISPOSITIVO.telefono ? riga("Gobbo dall'altro lato (se la camera è dall'altra parte)", spunta("inverti", () => posizionaGobbo(box))) : null,
      h("p", { class: "nota" }, "Tasti: Invio registra e ferma · spazio mette in pausa il testo · frecce su e giù cambiano la velocità · frecce destra e sinistra spostano il testo."),
      h("div", { class: "barra-azioni" },
        document.fullscreenEnabled ? h("button", { class: "bottone secondario", onclick: () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); } }, "Schermo intero") : null,
        h("button", { class: "bottone oro", onclick: () => { pannello.remove(); posizionaGobbo(box); } }, "Chiudi")));
    vista.append(pannello);
  }
}

// ---------------------------------------------------------------- 4b. lo studio del podcast
// Al posto del testo che scorre: la domanda, la prima frase in rosso, gli spunti e una barra del tempo (60 s).
class Scaletta {
  constructor(box, v, parte) {
    this.box = box;
    this.v = v;
    this.lista = parte === -1 ? v.parti.map((_, i) => i) : [parte];
    this.k = 0;
    this.t0 = 0;
    this.pausa = false;
    box.classList.add("scaletta-box");
    this.disegna();
  }
  get i() { return this.lista[this.k]; }
  get indice() { return this.k; }
  get ultima() { return this.k >= this.lista.length - 1; }
  disegna() {
    const c = capitolo(this.v, this.i);
    const tot = this.lista.length;
    this.barra = h("div", { class: "tempo" }, h("i"));
    this.orologio = h("span", { class: "tempo-num" });
    this.box.replaceChildren(h("div", { class: "scaletta", style: `--font:${P.font}px` },
      h("div", { class: "sc-testa" }, h("span", {}, etichettaCap(this.v, this.i) + (tot > 1 ? ` · ${this.k + 1} di ${tot}` : "")), this.orologio),
      c.domanda ? h("p", { class: "sc-domanda" }, c.domanda) : null,
      h("p", { class: "sc-gancio" }, c.gancio),
      c.spunti.length ? h("ul", { class: "sc-spunti" }, c.spunti.map((s) => h("li", {}, s))) : null,
      c.chiusura ? h("p", { class: "sc-chiusura" }, "Chiudi: ", c.chiusura) : null,
      this.barra));
  }
  avvia() {
    this.t0 = performance.now();
    cancelAnimationFrame(this.raf);
    const giro = () => {
      const s = this.secondi();
      this.barra.firstChild.style.width = Math.min(100, (s / 60) * 100) + "%";
      this.barra.classList.toggle("quasi", s >= 45 && s < 60);
      this.barra.classList.toggle("oltre", s >= 60);
      this.orologio.textContent = mmss(s);
      this.raf = requestAnimationFrame(giro);
    };
    giro();
  }
  secondi() { return this.t0 ? (performance.now() - this.t0) / 1000 : 0; }
  ferma() { cancelAnimationFrame(this.raf); }
  vai(d) {
    const k = Math.max(0, Math.min(this.lista.length - 1, this.k + d));
    if (k === this.k) return false;
    this.k = k;
    const correva = !!this.t0;
    this.ferma();
    this.disegna();
    if (correva) this.avvia();
    return true;
  }
  // stessi nomi del Gobbo, così posizionaGobbo ed esciDalloStudio funzionano uguale
  scorriA() {}
  applicaStile() { this.disegna(); }
}

function leggiAVoce(testo) {
  return new Promise((ok) => {
    if (!P.leggiDomanda || !testo || !window.speechSynthesis) return ok();
    const u = new SpeechSynthesisUtterance(testo.replace(/[«»"]/g, ""));
    u.lang = "it-IT";
    const voce = speechSynthesis.getVoices().find((x) => /^it/i.test(x.lang));
    if (voce) u.voice = voce;
    u.rate = 0.95;
    const fine = setTimeout(ok, 20000);
    u.onend = u.onerror = () => { clearTimeout(fine); ok(); };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

function studioPodcast(v, parte = 0) {
  S.video = v;
  const tutto = parte === -1;
  const nomeParte = tutto ? (v.sezione === "podcast" ? "Tutta la puntata di fila" : "Tutto di fila") : `${etichettaCap(v, parte)} · ${v.parti[parte].titolo}`;
  const anteprima = h("video", { class: "anteprima" + (P.specchiaMe ? " specchio" : "") + (P.mostraMe ? "" : " nascosta"), muted: true, playsinline: true, autoplay: true });
  const box = h("div", { class: `gobbo-box largo-${P.larghezza}` });
  const stato = h("div", { class: "stato" });
  const titolo = h("div", { class: "titolo-parte" }, h("span", { class: "nome-video" }, v.titolo), h("b", {}, nomeParte));
  const suggerimento = h("div", { class: "suggerimento" });
  const comandi = h("div", { class: "comandi" });
  const vista = h("div", { class: "studio" }, anteprima, box, h("div", { class: "barra-alta" }, titolo, stato), h("div", { class: "barra-bassa" }, suggerimento, comandi));
  const app = $("#app");
  app.className = "pieno";
  app.replaceChildren(vista);
  posizionaGobbo(box);
  const sc = new Scaletta(box, v, parte);
  S.gobbo = sc;
  let rec = null, registrando = false, soloProva = false, t0 = 0, timer = 0, silenzioDa = 0, occupato = false;

  const dici = (t) => { suggerimento.textContent = t; };
  const bottone = (testo, cls, fn, titoloTasto) => h("button", { class: "tasto " + (cls || ""), onclick: fn, title: titoloTasto || "" }, testo);
  const dopo = async (d) => {
    if (occupato || !sc.vai(d)) return;
    if (registrando || soloProva) {
      occupato = true;
      sc.ferma();
      await leggiAVoce(capitolo(v, sc.i).domanda);
      occupato = false;
      if (!(registrando || soloProva)) return; // ha premuto Stop mentre la voce leggeva
      sc.avvia();
      disegnaComandi();
    }
  };
  const disegnaComandi = () => {
    if (registrando || soloProva) {
      comandi.replaceChildren(
        tutto ? h("div", { class: "gruppo" }, bottone("◀", "tondo", () => dopo(-1), "domanda prima"), bottone(sc.ultima ? "Ultima domanda" : "Domanda dopo →", "", () => dopo(1), "freccia destra")) : h("span"),
        h("button", { class: "tasto-rec stop", onclick: () => stop(), title: "Invio" }, h("i"), registrando ? "Stop" : "Fine prova"),
        h("span"));
      return;
    }
    const nav = v.parti.length > 1 ? h("div", { class: "gruppo" },
      bottone("◀", "tondo", () => parte > 0 && cambiaParte(parte - 1), "domanda prima"),
      h("select", { class: "scegli-parte", onchange: (e) => cambiaParte(+e.target.value) },
        v.parti.map((p, i) => h("option", { value: i, selected: i === parte }, `${etichettaCap(v, i)} · ${p.titolo}`)),
        h("option", { value: -1, selected: tutto }, v.sezione === "podcast" ? "Tutta la puntata di fila" : "Tutto di fila")),
      bottone("▶", "tondo", () => parte >= 0 && parte < v.parti.length - 1 && cambiaParte(parte + 1), "domanda dopo")) : h("span");
    comandi.replaceChildren(nav,
      h("div", { class: "gruppo centro" },
        h("button", { class: "tasto-rec", onclick: () => via(false), title: "Invio" }, h("i"), "Registra"),
        bottone("Prova senza registrare", "", () => via(true))),
      h("div", { class: "gruppo" },
        bottone(P.leggiDomanda ? "🔊 Domanda a voce" : "🔈 Domanda muta", P.leggiDomanda ? "acceso-chiaro" : "", () => { P.leggiDomanda = !P.leggiDomanda; salvaPref(); disegnaComandi(); }, "una voce ti legge la domanda prima di partire"),
        bottone("⚙", "tondo", () => impostazioni(), "impostazioni"),
        bottone("✕", "tondo", () => history.back(), "esci")));
  };
  const cambiaParte = (p) => {
    if (p >= v.parti.length || p < -1) return;
    history.replaceState({ n: S.pila.length }, "");
    S.pila[S.pila.length - 1] = [studio, [v, p]];
    mostra(studio, [v, p]);
  };

  const via = async (prova) => {
    if (registrando || soloProva || occupato) return;
    try { await accendiCamera(); } catch (e) { dici(""); suggerimento.replaceChildren(spiegaErroreCamera(e)); return; }
    anteprima.srcObject = S.stream;
    if (!prova && !window.MediaRecorder) { dici("Questo browser non può registrare. Usa Chrome o Safari aggiornati."); return; }
    occupato = true;
    comandi.replaceChildren();
    if (P.leggiDomanda) { dici("Ascolta la domanda…"); await leggiAVoce(capitolo(v, sc.i).domanda); }
    dici(prova ? "Prova: niente viene registrato." : "Si parte fra 3 secondi. Guarda in camera.");
    S.audioCtx?.resume?.();
    await contoAllaRovescia(vista, 3);
    occupato = false;
    soloProva = prova;
    if (!prova) {
      rec = new Registratore(S.stream);
      rec.avvia();
      registrando = true;
      t0 = performance.now();
      silenzioDa = 0;
      timer = setInterval(() => {
        stato.replaceChildren(h("span", { class: "rec" }, h("i"), "REC " + mmss((performance.now() - t0) / 1000)));
        if (S.audioCtx?.state === "running" && S.livello < -55) {
          silenzioDa = silenzioDa || performance.now();
          if (performance.now() - silenzioDa > 9000) dici("Non sento la tua voce: controlla il microfono. Se è tutto a posto, ignora questo messaggio.");
        } else silenzioDa = 0;
        if (sc.secondi() > 60) dici(tutto ? "Hai passato il minuto: chiudi con la tua frase, poi «Domanda dopo»." : "Hai passato il minuto: chiudi con la tua frase, poi Stop.");
      }, 250);
    } else stato.replaceChildren(h("span", { class: "prova" }, "PROVA"));
    sc.avvia();
    disegnaComandi();
    dici(tutto
      ? "Prima la frase in rosso, poi racconta. Finita una risposta, premi «Domanda dopo» (o la freccia destra)."
      : "Prima la frase in rosso, poi racconta con parole tue. Sotto il minuto è perfetto. Finito, premi Stop (o Invio).");
  };
  const stop = async () => {
    if (!(registrando || soloProva)) return;
    clearInterval(timer);
    sc.ferma();
    window.speechSynthesis?.cancel();
    stato.replaceChildren();
    if (soloProva) { soloProva = false; sc.t0 = 0; disegnaComandi(); dici("Prova finita. Quando sei pronto premi Registra."); return; }
    if (!registrando) return;
    registrando = false;
    dici("Salvo la ripresa…");
    const r = await rec.ferma();
    if (!r || !r.blob.size) { dici("La ripresa è vuota: riprova."); disegnaComandi(); return; }
    const tutte = await Archivio.tutte();
    const n = tutte.filter((x) => x.video === v.id && x.parte === parte).length + 1;
    const ripresa = { id: "r" + Date.now(), persona: S.persona, video: v.id, parte, n, blob: r.blob, mime: r.mime, durata: r.durata, w: r.w, h: r.h, creata: Date.now(), scelta: false, letta: true };
    try { await Archivio.metti(ripresa); }
    catch (e) { dici("Non riesco a salvare la ripresa (spazio pieno?). La scarico subito."); scarica(ripresa, v); }
    mostra(dopoRipresa, [v, ripresa]);
    S.pila[S.pila.length - 1] = [studio, [v, parte]];
  };

  S.tasti = (e) => {
    if (e.target.closest?.("select,input,textarea")) return;
    if (e.key === "Enter") { e.preventDefault(); registrando || soloProva ? stop() : via(false); }
    else if (e.key === "ArrowRight") { e.preventDefault(); registrando || soloProva ? (tutto && dopo(1)) : parte >= 0 && cambiaParte(parte + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); registrando || soloProva ? (tutto && dopo(-1)) : parte > 0 && cambiaParte(parte - 1); }
    else if (e.key === "Escape" && !(registrando || soloProva)) history.back();
  };
  document.addEventListener("keydown", S.tasti);
  S.riposiziona = () => posizionaGobbo(box);
  window.addEventListener("resize", S.riposiziona);
  screen.orientation?.addEventListener?.("change", S.riposiziona);
  S.esciStudio = async () => { window.speechSynthesis?.cancel(); if (registrando) { registrando = false; await rec.ferma(); } sc.ferma(); clearInterval(timer); };

  disegnaComandi();
  dici(tutto
    ? "Registri la puntata intera in una ripresa sola: le domande arrivano una dopo l'altra. Premi Registra (o Invio) quando sei pronto."
    : "Leggi la domanda e i tre spunti. Quando sei pronto premi Registra (o Invio): non c'è niente da leggere, guarda in camera.");
  window.speechSynthesis?.getVoices();
  accendiCamera().then(() => {
    anteprima.srcObject = S.stream;
    anteprima.play().catch(() => {});
    misuraLivello(null);
  }).catch((e) => suggerimento.replaceChildren(spiegaErroreCamera(e)));
  tieniAcceso();

  function impostazioni() {
    const riga = (etichetta, ctrl) => h("label", { class: "riga-imp" }, h("span", {}, etichetta), ctrl);
    const spunta = (k, poi) => h("input", { type: "checkbox", checked: !!P[k], onchange: (e) => { P[k] = e.target.checked; salvaPref(); poi?.(); } });
    const font = h("input", { type: "range", min: 22, max: 80, step: 2, value: P.font, oninput: (e) => { P.font = +e.target.value; salvaPref(); sc.applicaStile(); } });
    const larg = h("select", { onchange: (e) => { P.larghezza = e.target.value; salvaPref(); box.className = box.className.replace(/largo-\S+/, "largo-" + P.larghezza); posizionaGobbo(box); } },
      [["stretto", "Stretto (occhi più fermi)"], ["medio", "Medio"], ["largo", "Largo"]].map(([k, t]) => h("option", { value: k, selected: P.larghezza === k }, t)));
    const pannello = h("div", { class: "pannello" },
      h("h3", {}, "Impostazioni"),
      riga("Grandezza del testo", font),
      riga("Larghezza del riquadro", larg),
      riga("La domanda letta da una voce", spunta("leggiDomanda", disegnaComandi)),
      riga("Vedi la tua immagine", spunta("mostraMe", () => anteprima.classList.toggle("nascosta", !P.mostraMe))),
      riga("Immagine a specchio", spunta("specchiaMe", () => anteprima.classList.toggle("specchio", P.specchiaMe))),
      DISPOSITIVO.telefono ? riga("Riquadro dall'altro lato (se la camera è dall'altra parte)", spunta("inverti", () => posizionaGobbo(box))) : null,
      h("p", { class: "nota" }, "Tasti: Invio registra e ferma · freccia destra e sinistra cambiano domanda."),
      h("div", { class: "barra-azioni" },
        document.fullscreenEnabled ? h("button", { class: "bottone secondario", onclick: () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); } }, "Schermo intero") : null,
        h("button", { class: "bottone oro", onclick: () => { pannello.remove(); posizionaGobbo(box); } }, "Chiudi")));
    vista.append(pannello);
  }
}

// Il gobbo va vicino alla camera: in alto al centro sul Mac e col telefono in verticale,
// sul lato della camera col telefono in orizzontale.
function posizionaGobbo(box) {
  box.classList.remove("pos-alto", "pos-sinistra", "pos-destra");
  const orizzontale = innerWidth > innerHeight;
  if (DISPOSITIVO.telefono && orizzontale) {
    // iPhone: window.orientation 90 = ruotato verso sinistra, camera a sinistra; -90 = camera a destra
    const ang = typeof window.orientation === "number" ? window.orientation : (screen.orientation?.angle === 270 ? -90 : 90);
    let sinistra = ang === 90;
    if (P.inverti) sinistra = !sinistra;
    box.classList.add(sinistra ? "pos-sinistra" : "pos-destra");
  } else box.classList.add("pos-alto");
  if (S.gobbo) S.gobbo.scorriA(true);
}
async function tieniAcceso() {
  try { S.wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function esciDalloStudio() {
  if (S.esciStudio) { S.esciStudio(); S.esciStudio = null; }
  if (S.tasti) { document.removeEventListener("keydown", S.tasti); S.tasti = null; }
  if (S.riposiziona) { window.removeEventListener("resize", S.riposiziona); screen.orientation?.removeEventListener?.("change", S.riposiziona); S.riposiziona = null; }
  if (S.gobbo) { S.gobbo.ferma(); S.gobbo = null; }
  S.wakeLock?.release?.().catch(() => {});
  S.wakeLock = null;
}

// ---------------------------------------------------------------- 5. dopo ogni ripresa
function dopoRipresa(v, r) {
  const url = URL.createObjectURL(r.blob);
  const ultima = r.parte === -1 || r.parte >= v.parti.length - 1;
  const nome = r.parte === -1 ? (v.podcast ? "Tutta la puntata" : "Tutto il video") : v.podcast ? `${etichettaCap(v, r.parte)} · ${v.parti[r.parte].titolo}` : v.parti.length > 1 ? `Parte ${r.parte + 1} · ${v.parti[r.parte].titolo}` : v.parti[r.parte].titolo;
  const esito = h("p", { class: "nota" }, "Controllo l'audio…");
  pagina(h("main", { class: "carta" },
    h("p", { class: "occhiello" }, v.titolo),
    h("h1", {}, `${nome}: ripresa ${r.n}`),
    h("video", { class: "riguarda", controls: true, playsinline: true, src: url }),
    h("p", { class: "meta" }, `${mmss(r.durata)} · ${r.w && r.h ? r.w + "×" + r.h : ""} · ${r.blob.size < 1e6 ? "meno di 1 MB" : (r.blob.size / 1e6).toFixed(0) + " MB"}`),
    esito,
    h("p", { class: "lead" }, "Riguardala: se ti piace vai avanti, se no rifalla. Le riprese restano tutte salvate qui."),
    h("div", { class: "barra-azioni" },
      h("button", { class: "bottone oro grande", onclick: async () => {
        await segnaScelta(r);
        if (ultima) return vai(rivedi, v);
        S.pila[S.pila.length - 1] = [studio, [v, r.parte + 1]];
        history.replaceState({ n: S.pila.length }, "");
        mostra(studio, [v, r.parte + 1]);
      } }, ultima ? "Va bene, ho finito" : v.podcast && v.sezione === "podcast" ? "Va bene, domanda dopo →" : "Va bene, prossima parte →"),
      h("button", { class: "bottone grande", onclick: () => { S.pila[S.pila.length - 1] = [studio, [v, r.parte]]; mostra(studio, [v, r.parte]); } }, v.podcast ? "Rifai questa risposta" : "Rifai questa parte"),
      h("button", { class: "bottone secondario", onclick: () => scarica(r, v) }, "Scarica"))));
  if (r.durata < 120) audioNelFile(r.blob).then((ok) => {
    esito.className = ok === false ? "ko" : "ok";
    esito.textContent = ok === false ? "✗ In questa ripresa la voce non si sente: controlla il microfono e rifalla." : ok ? "✓ La voce si sente." : "";
  });
  else esito.textContent = "";
}
async function segnaScelta(r) {
  const tutte = await Archivio.tutte();
  for (const x of tutte) if (x.video === r.video && x.parte === r.parte && x.scelta && x.id !== r.id) { x.scelta = false; await Archivio.metti(x); }
  r.scelta = true;
  await Archivio.metti(r);
}
const nomeFile = (r, v) => {
  const parte = r.parte === -1 ? "tutto" : String(r.parte + 1).padStart(2, "0") + " " + (v?.parti[r.parte]?.titolo || "");
  return pulito(`${S.dati.persona || "Video"} - ${v ? v.titolo.split("·")[0] : r.video} - ${parte} - ripresa ${r.n}`) + "." + estensione(r.mime);
};
function scarica(r, v) {
  const a = h("a", { href: URL.createObjectURL(r.blob), download: nomeFile(r, v) });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}

// ---------------------------------------------------------------- 6. tutte le riprese, e mandarle a Marc
async function rivedi(soloVideo) {
  const tutte = await Archivio.tutte();
  const video = S.puntate.concat(S.dati.video).filter((v) => !soloVideo || v.id === soloVideo.id);
  const sezioni = [];
  for (const v of video) {
    const sue = tutte.filter((r) => r.video === v.id);
    if (!sue.length && !soloVideo) continue;
    const scelte = [];
    const righe = [-1, ...v.parti.keys()].map((p) => {
      const qui = sue.filter((r) => r.parte === p);
      if (!qui.length) return p === -1 ? null : h("li", { class: "manca" }, h("span", {}, `${p + 1}. ${v.parti[p].titolo}`), h("button", { class: "link", onclick: () => vai(studio, v, p) }, "registra"));
      const sc = qui.find((r) => r.scelta) || qui[qui.length - 1];
      scelte.push(sc);
      return h("li", {}, h("span", {}, p === -1 ? "Tutto di fila" : `${p + 1}. ${v.parti[p].titolo}`),
        h("span", { class: "riprese" }, qui.map((r) => h("button", { class: "chip" + (r === sc ? " scelta" : ""), title: "guarda", onclick: () => guarda(r, v, () => rivedi(soloVideo)) }, `${r === sc ? "★ " : ""}ripresa ${r.n} · ${mmss(r.durata)}`))),
        h("button", { class: "link", onclick: () => vai(studio, v, p) }, "rifai"));
    }).filter(Boolean);
    const mb = scelte.reduce((a, r) => a + r.blob.size, 0) / 1e6;
    sezioni.push(h("section", { class: "parte" },
      h("h2", {}, v.titolo),
      h("ul", { class: "elenco-riprese" }, righe),
      scelte.length ? h("div", { class: "barra-azioni" },
        h("button", { class: "bottone oro", onclick: () => scelte.forEach((r, i) => setTimeout(() => scarica(r, v), i * 700)) }, `Scarica le riprese con la ★ (${scelte.length}, ${mb.toFixed(0)} MB)`),
        navigator.canShare ? h("button", { class: "bottone secondario", onclick: () => condividi(scelte, v) }, "Condividi…") : null) : null));
  }
  const stima = await navigator.storage?.estimate?.().catch(() => null);
  pagina(h("main", { class: "carta" }, indietro(),
    h("h1", {}, "Le tue riprese"),
    h("p", { class: "lead" }, "La ★ è la ripresa scelta per ogni parte: tocca un'altra ripresa per guardarla e sceglierla. Poi scarica le riprese con la ★ e mandale a Marc su WhatsApp: allegato → Documento, così non perdono qualità."),
    sezioni.length ? sezioni : h("p", {}, "Non ci sono ancora riprese."),
    stima?.usage ? h("p", { class: "nota" }, `Spazio usato dalle riprese su questo dispositivo: ${(stima.usage / 1e9).toFixed(1)} GB.`) : null,
    tutte.length ? h("button", { class: "link pericolo", onclick: async () => { if (confirm("Cancello tutte le riprese da questo dispositivo? Fallo solo dopo averle mandate a Marc.")) { for (const r of tutte) await Archivio.togli(r.id); rivedi(soloVideo); } } }, "Cancella tutte le riprese da questo dispositivo") : null));
}
function guarda(r, v, ricarica) {
  const url = URL.createObjectURL(r.blob);
  const nome = r.parte === -1 ? "Tutto di fila" : `${r.parte + 1}. ${v.parti[r.parte].titolo}`;
  const fondo = h("div", { class: "velo", onclick: (e) => { if (e.target === fondo) chiudi(); } });
  const chiudi = () => { URL.revokeObjectURL(url); fondo.remove(); };
  fondo.append(h("div", { class: "pannello" },
    h("h3", {}, `${nome} · ripresa ${r.n}`),
    h("video", { class: "riguarda", controls: true, autoplay: true, playsinline: true, src: url }),
    h("div", { class: "barra-azioni" },
      h("button", { class: "bottone oro", onclick: async () => { await segnaScelta(r); chiudi(); ricarica(); } }, "★ Scegli questa"),
      h("button", { class: "bottone secondario", onclick: () => scarica(r, v) }, "Scarica"),
      h("button", { class: "bottone secondario", onclick: async () => { if (confirm("Cancellare questa ripresa?")) { await Archivio.togli(r.id); chiudi(); ricarica(); } } }, "Cancella"),
      h("button", { class: "link", onclick: chiudi }, "Chiudi"))));
  document.body.append(fondo);
}
async function condividi(scelte, v) {
  const files = scelte.map((r) => new File([r.blob], nomeFile(r, v), { type: r.blob.type }));
  try {
    if (navigator.canShare({ files })) await navigator.share({ files, title: v.titolo });
    else avviso("Questo dispositivo non può condividere i file da qui: usa «Scarica».");
  } catch (e) {
    if (e.name !== "AbortError") avviso("Condivisione non riuscita: usa «Scarica».");
  }
}

// ---------------------------------------------------------------- avvisi
function avviso(t) {
  const a = h("div", { class: "toast" }, t);
  document.body.append(a);
  setTimeout(() => a.classList.add("via"), 2600);
  setTimeout(() => a.remove(), 3200);
}

// ---------------------------------------------------------------- partenza
(async () => {
  navigator.storage?.persist?.().catch(() => {});
  S.dati = await caricaTesti();
  S.pila = [[home, []]];
  history.replaceState({ n: 1 }, "");
  home();
})();

// per le prove automatiche (non serve a chi usa la pagina)
window.__gobbo = { trovaPosizione, paroleSentite, numeroInParole, normalizza, S };
