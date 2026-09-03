//! Die lokale Modell-API — ein Router vor dem, was ohnehin schon laeuft.
//!
//! ── WARUM DAS EIN ROUTER IST UND KEIN SERVER ───────────────────────────────
//!
//! Auftrag am 02.09.2026: "eine API nicht nur fuer die Cloud-Modelle, sondern
//! fuer ALLE lokalen" — Ollama, LM Studio, LU Engine. Der erste Reflex waere,
//! eine Inferenz-Schicht zu bauen. Nachgesehen hat sich das erledigt: alle drei
//! sprechen bereits OpenAI.
//!
//!   LU Engine   llama-server auf 127.0.0.1:8127/v1   (engine.rs::DEFAULT_ENGINE_PORT)
//!   Ollama      127.0.0.1:11434/v1
//!   LM Studio   127.0.0.1:1234/v1
//!
//! Was fehlt, ist nicht Inferenz, sondern EINE Adresse davor: ein Verzeichnis
//! ueber alle drei, eine Weiterleitung, ein Token. Genau das steht hier.
//!
//! ── WARUM EIN EIGENER LAUSCHER UND NICHT remote.rs ─────────────────────────
//!
//! remote.rs bindet auf 0.0.0.0:11435 — mit Absicht, denn das Handy soll sich
//! im WLAN verbinden koennen, und davor steht ein Paarungsablauf mit QR-Code
//! und JWT. Haengte man `/v1` dort an, waere die Modell-API vom ersten Tag an
//! im ganzen Netz sichtbar. Davids Entscheidung war das Gegenteil: "Localhost ab
//! Werk, LAN einstellbar". Ein eigener Lauscher haelt beide Sicherheitsmodelle
//! auseinander, statt sie zu vermischen.
//!
//! ── DIE DREI REGELN, DIE NICHT VERHANDELBAR SIND ───────────────────────────
//!
//! 1. **Token immer.** Auch auf 127.0.0.1. Auf einem Mehrbenutzer-Rechner ist
//!    localhost keine Grenze, und jedes Programm des Nutzers — jede Webseite
//!    ueber einen neugierigen fetch — erreicht 127.0.0.1. Ein LEERES Token
//!    darf deshalb niemals passen: sonst hiesse "nicht eingerichtet" in der
//!    Wirkung "offen". `token_matches` gibt bei leerem Erwartungswert `false`.
//! 2. **LAN ist aus, bis jemand sie einschaltet.** `bind_addr(false, _)` ist
//!    127.0.0.1, und der Vorgabewert von `lan` ist `false`.
//! 3. **Das Token des Aufrufers geht nie nach oben weiter.** Wir leiten an
//!    llama-server / Ollama / LM Studio weiter; deren Authorization-Kopfzeile
//!    ist unsere Sache, nicht die des Clients. `forward_headers` streicht sie.
//!
//! ── WAS HIER STEHT UND WAS NICHT ───────────────────────────────────────────
//!
//! Diese Datei traegt zuerst den ENTSCHEIDBAREN Teil: Namensaufloesung,
//! Bindeadresse, Tokenvergleich, Kopfzeilenfilter. Alles reine Funktionen ohne
//! Netz, alle unten geprueft. Der Lauscher und die Tauri-Befehle bauen darauf
//! auf und haben nichts zu entscheiden.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// Der Vorgabeport der lokalen API.
///
/// 8129 und nicht 8127: 8127 ist die LU Engine selbst (engine.rs), 8128 laesst
/// Platz fuer einen zweiten Engine-Prozess (der Embedder laeuft heute schon als
/// eigener `bundled_embed`). Wer beide Zahlen nebeneinander sieht, soll nicht
/// raten muessen, welche welche ist.
pub const DEFAULT_LOCAL_API_PORT: u16 = 8129;

/// Woher ein Modell kommt.
///
/// Die Reihenfolge ist nicht beliebig: sie bestimmt, in welcher Folge
/// `/v1/models` die Lanes auflistet, und damit, was ein Mensch zuerst sieht.
/// Die eigene Engine zuerst, dann die zwei fremden Programme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Lane {
    Engine,
    Ollama,
    LmStudio,
}

impl Lane {
    /// Das Namenspraefix nach aussen. Kurz, weil es der Nutzer tippt.
    pub fn prefix(self) -> &'static str {
        match self {
            Lane::Engine => "lu",
            Lane::Ollama => "ollama",
            Lane::LmStudio => "lmstudio",
        }
    }

    pub fn from_prefix(p: &str) -> Option<Lane> {
        match p {
            "lu" => Some(Lane::Engine),
            "ollama" => Some(Lane::Ollama),
            "lmstudio" => Some(Lane::LmStudio),
            _ => None,
        }
    }

    /// Wie die Lane in einer Fehlermeldung heisst — fuer Menschen, nicht fuer URLs.
    pub fn label(self) -> &'static str {
        match self {
            Lane::Engine => "LU Engine",
            Lane::Ollama => "Ollama",
            Lane::LmStudio => "LM Studio",
        }
    }

    pub const ALL: [Lane; 3] = [Lane::Engine, Lane::Ollama, Lane::LmStudio];
}

/// Der nach aussen sichtbare Name eines Modells: `lane/upstream-id`.
///
/// Immer qualifiziert, auch wenn der blosse Name eindeutig waere. Ein Client,
/// der `lu/qwen3-8b` speichert, bekommt morgen dasselbe Modell — auch wenn
/// jemand inzwischen ein gleichnamiges in Ollama gezogen hat.
pub fn qualified_id(lane: Lane, upstream_id: &str) -> String {
    format!("{}/{}", lane.prefix(), upstream_id)
}

/// Schreibt `model` in einem ANTWORT-Koerper auf die qualifizierte ID zurueck.
///
/// Der Kunden-Testbericht vom 02.09.2026 nennt das seinen haertesten Fund: man
/// schickt `ollama/llama3.2:3b`, zurueck kommt `"model":"llama3.2:3b"` — die ID
/// aus der Antwort steht damit NICHT in `/v1/models`. Wer sie weiterverwendet
/// (Protokoll, Kostenzuordnung, Modellumschalter, Cache-Schluessel), greift ins
/// Leere; und fuehren zwei Lanes ein gleichnamiges Modell, ist hinterher nicht
/// mehr feststellbar, wer geantwortet hat. Hin qualifiziert, zurueck nackt, ist
/// kein Round-Trip.
///
/// Gibt `true` zurueck, wenn wirklich etwas geaendert wurde.
pub fn modell_zurueckschreiben(json: &mut serde_json::Value, qualifiziert: &str) -> bool {
    match json.get_mut("model") {
        Some(m) if m.is_string() => {
            *m = serde_json::Value::String(qualifiziert.to_string());
            true
        }
        _ => false,
    }
}

/// Dasselbe fuer den Streaming-Fall, ohne das Streaming zu zerstoeren.
///
/// Der Antwortkoerper laeuft ungepuffert durch — das ist die Eigenschaft, wegen
/// der jemand `stream: true` schreibt, und sie darf ein Namensfix nicht kosten.
/// Also wird zeilenweise umgeschrieben statt am Stueck: was an ganzen Zeilen da
/// ist, geht sofort weiter; ein angebrochener Rest wartet auf den naechsten
/// Schub. Ein `"model":"…"` DARF ueber eine Chunk-Grenze fallen, und genau
/// daran scheitert jede Fassung, die einfach im Bytestrom sucht.
///
/// Zwei Folgen, die ich nicht verschweige: umgeschriebene Zeilen werden neu
/// serialisiert, deshalb stehen ihre Schluessel danach alphabetisch statt in
/// Upstream-Reihenfolge, und Gleitkommazahlen bekommen ihre kuerzeste Form.
/// Beides ist wertgleich (serde_json serialisiert f64 ueber ryu, also exakt
/// round-trip-fest); die Reihenfolge von JSON-Schluesseln bedeutet nichts.
/// Zeilen ohne `model` und Zeilen, die nicht als JSON lesbar sind, werden
/// unveraendert durchgereicht — wir zerstoeren nie, was wir nicht verstehen.
pub struct SseModellUmschreiber {
    qualifiziert: String,
    rest: Vec<u8>,
}

impl SseModellUmschreiber {
    pub fn neu(qualifiziert: &str) -> Self {
        Self { qualifiziert: qualifiziert.to_string(), rest: Vec::new() }
    }

    /// Ein Schub roher Upstream-Bytes rein, die fertigen Zeilen raus.
    pub fn schub(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.rest.extend_from_slice(chunk);
        let mut aus = Vec::new();
        while let Some(nl) = self.rest.iter().position(|b| *b == b'\n') {
            let zeile: Vec<u8> = self.rest.drain(..=nl).collect();
            aus.extend_from_slice(&self.zeile_umschreiben(&zeile));
        }
        aus
    }

    /// Was am Ende noch im Puffer liegt. Nie verschlucken.
    pub fn schluss(&mut self) -> Vec<u8> {
        if self.rest.is_empty() {
            return Vec::new();
        }
        let zeile: Vec<u8> = self.rest.drain(..).collect();
        self.zeile_umschreiben(&zeile)
    }

    fn zeile_umschreiben(&self, zeile: &[u8]) -> Vec<u8> {
        let Ok(text) = std::str::from_utf8(zeile) else {
            return zeile.to_vec(); // kein UTF-8 — nicht unser Protokoll
        };
        // Zeilenende abtrennen und WOERTLICH aufheben: \n und \r\n sind beide
        // gueltig, und wer hier normalisiert, verschiebt fremde Byteanzahlen.
        let (rumpf, ende) = match text.strip_suffix('\n') {
            Some(r) => match r.strip_suffix('\r') {
                Some(r2) => (r2, "\r\n"),
                None => (r, "\n"),
            },
            None => (text, ""),
        };
        let Some(nutz) = rumpf.strip_prefix("data:") else {
            return zeile.to_vec(); // `:`-Kommentar, `event:`, Leerzeile
        };
        let nutz_trim = nutz.trim_start();
        if nutz_trim == "[DONE]" {
            return zeile.to_vec();
        }
        let Ok(mut json) = serde_json::from_str::<serde_json::Value>(nutz_trim) else {
            return zeile.to_vec(); // nicht lesbar — durchreichen, nicht raten
        };
        if !modell_zurueckschreiben(&mut json, &self.qualifiziert) {
            return zeile.to_vec(); // nichts zu tun, also nichts anfassen
        }
        format!("data: {}{}", json, ende).into_bytes()
    }
}

/// Ein aufgeloestes Modell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRef {
    pub lane: Lane,
    pub upstream_id: String,
}

/// Warum ein Name nicht aufgeloest werden konnte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// Kein Modell dieses Namens, in keiner Lane.
    Unknown(String),
    /// Blosser Name, den mehrere Lanes fuehren. Wir raten NICHT.
    Ambiguous { requested: String, candidates: Vec<String> },
    /// Der Name nennt eine Lane, die es gibt — die aber gerade nichts fuehrt.
    ///
    /// Aus dem Kundenbericht vom 02.09.2026, Fund 1: von drei beworbenen Lanes
    /// lief eine, und wer `lu/…` anfragte, bekam „Unknown model". Das ist
    /// wahr und trotzdem irrefuehrend — das Modell ist nicht unbekannt, die
    /// Lane ist aus. Der Kunde hielt das Drei-Wege-Versprechen deshalb fuer
    /// unbelegt, und er konnte es nicht besser wissen: die Schnittstelle hat
    /// es ihm nicht gesagt.
    LaneLeer { lane: Lane, requested: String },
}

impl ResolveError {
    /// Der Text, der beim Client ankommt. Er nennt immer den Ausweg.
    pub fn message(&self) -> String {
        match self {
            ResolveError::Unknown(id) => format!(
                "Unknown model '{}'. Call GET /v1/models to see what is loaded locally.",
                id
            ),
            ResolveError::Ambiguous { requested, candidates } => format!(
                "Model '{}' exists in more than one local backend ({}). Use the qualified id so the choice is yours, not ours.",
                requested,
                candidates.join(", ")
            ),
            ResolveError::LaneLeer { lane, requested } => format!(
                "Model '{}' asks for the {} lane, but {} currently reports no models — it is most likely not running. Start it, then call GET /v1/models. GET /lu/v1/health shows every lane and what it holds.",
                requested,
                lane.label(),
                lane.label()
            ),
        }
    }

    /// Der `code`-Wert im Fehlerobjekt. Clients pruefen darauf, statt
    /// englische Saetze zu vergleichen.
    pub fn code(&self) -> &'static str {
        match self {
            ResolveError::Unknown(_) => "model_not_found",
            ResolveError::Ambiguous { .. } => "model_ambiguous",
            ResolveError::LaneLeer { .. } => "lane_unavailable",
        }
    }
}

/// Was an einem Anfragekoerper fehlt, bevor er ueberhaupt weitergereicht wird.
///
/// Aus dem Kundenbericht, Fund 4: ohne `messages` kam eine durchgereichte
/// Ollama-Schemameldung („[] is too short - 'messages'") beim Kunden an. Sie
/// ist kryptisch, sie nennt unser Feld nicht, und sie wechselt mit dem
/// Upstream. Eine Pflichtfeldpruefung gehoert vor die Weiterleitung, nicht
/// dahinter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeldFehler {
    pub param: String,
    pub nachricht: String,
}

/// Prueft die Felder, ohne die eine Anfrage keinen Sinn hat.
///
/// `pflichtfeld` ist das, was der jeweilige Endpunkt braucht: `messages` beim
/// Chat, `prompt` bei Completions, `input` bei Embeddings.
pub fn koerper_pruefen(json: &serde_json::Value, pflichtfeld: &str) -> Result<(), FeldFehler> {
    let modell = json.get("model").and_then(|m| m.as_str()).unwrap_or("").trim();
    if modell.is_empty() {
        return Err(FeldFehler {
            param: "model".into(),
            nachricht: "Missing required parameter: 'model'. Call GET /v1/models for the ids this server accepts.".into(),
        });
    }
    match json.get(pflichtfeld) {
        None | Some(serde_json::Value::Null) => Err(FeldFehler {
            param: pflichtfeld.into(),
            nachricht: format!("Missing required parameter: '{}'.", pflichtfeld),
        }),
        Some(serde_json::Value::Array(a)) if a.is_empty() => Err(FeldFehler {
            param: pflichtfeld.into(),
            nachricht: format!("'{}' is empty. Send at least one entry.", pflichtfeld),
        }),
        _ => Ok(()),
    }
}

/// Loest den `model`-Wert einer Anfrage auf.
///
/// `katalog` ist, was die Lanes gerade wirklich fuehren — Paare aus Lane und
/// der ID, unter der die Lane das Modell kennt.
///
/// Zwei Wege, und der zweite ist der Grund fuer die Laenge dieser Funktion:
///
/// 1. **Qualifiziert** (`ollama/llama3.2:3b`): Praefix abschneiden, in genau
///    dieser Lane exakt suchen.
/// 2. **Blosser Name** (`llama3.2:3b`): in allen Lanes suchen. Genau einer →
///    gut. Mehrere → Fehler mit beiden Namen, NIE eine stille Wahl. Der Nutzer
///    hat in dem Fall zwei verschiedene Modelle, und welches er meint, weiss
///    er, wir nicht.
///
/// Der Sonderfall, an dem eine naive Fassung scheitert: Ollama-IDs enthalten
/// selbst Schraegstriche (`huihui_ai/qwen3-abliterated:4b`). Faengt so eine ID
/// zufaellig mit `lu/` an, waere sie sonst als LU-Engine-Modell gelesen und
/// nicht gefunden. Deshalb faellt Weg 1 bei Misserfolg auf Weg 2 zurueck,
/// statt sofort aufzugeben.
pub fn resolve_model(requested: &str, katalog: &[(Lane, String)]) -> Result<ModelRef, ResolveError> {
    let req = requested.trim();
    if req.is_empty() {
        return Err(ResolveError::Unknown(String::new()));
    }

    if let Some((pre, rest)) = req.split_once('/') {
        if let Some(lane) = Lane::from_prefix(pre) {
            if let Some((l, id)) = katalog.iter().find(|(l, id)| *l == lane && id == rest) {
                return Ok(ModelRef { lane: *l, upstream_id: id.clone() });
            }
            // Kein Treffer unter dieser Deutung — weiter mit Weg 2, statt hier
            // zu enden. Siehe der `huihui_ai/`-Fall im Kommentar oben.
        }
    }

    let treffer: Vec<&(Lane, String)> = katalog.iter().filter(|(_, id)| id == req).collect();
    match treffer.len() {
        0 => {
            // Bevor „unbekannt" gesagt wird: nannte der Name eine Lane, die
            // gerade ueberhaupt nichts fuehrt? Dann ist nicht das Modell das
            // Problem, sondern dass das Programm dahinter nicht laeuft — und
            // das ist die Auskunft, mit der jemand etwas anfangen kann.
            if let Some((pre, _)) = req.split_once('/') {
                if let Some(lane) = Lane::from_prefix(pre) {
                    if !katalog.iter().any(|(l, _)| *l == lane) {
                        return Err(ResolveError::LaneLeer { lane, requested: req.to_string() });
                    }
                }
            }
            Err(ResolveError::Unknown(req.to_string()))
        }
        1 => Ok(ModelRef { lane: treffer[0].0, upstream_id: treffer[0].1.clone() }),
        _ => Err(ResolveError::Ambiguous {
            requested: req.to_string(),
            candidates: treffer.iter().map(|(l, id)| qualified_id(*l, id)).collect(),
        }),
    }
}

/// Darf diese Herkunft im Browser mitlesen?
///
/// Aus dem Kundenbericht vom 02.09.2026, Fund 3: der Preflight scheiterte an
/// der Auth, es gab keinen einzigen `Access-Control-*`-Kopf, und damit war
/// „jedes Programm, das mit OpenAI spricht" fuer Weboberflaechen schlicht
/// falsch. Das war kein Versehen — Regel 1 im Kopf dieser Datei nennt genau
/// die neugierige Webseite als Grund. Aber „gar nicht" ist die falsche Antwort
/// auf einen echten Bedarf. Die richtige hat dieselbe Form wie der LAN-
/// Schalter: eine Liste, ab Werk LEER, die der Nutzer selbst fuellt.
///
/// **Kein `*`.** Ein Platzhalter macht aus der Liste wieder „jede Webseite",
/// und der ganze Wert dieser Liste ist, dass jemand die Herkunft BENENNT, der
/// er seinen lokalen Modellverkehr zeigen will. Wer `*` eintraegt, bekommt
/// deshalb keine Freigabe, sondern nichts — lieber ein Eintrag, der sichtbar
/// nicht wirkt, als eine Tuer, die man versehentlich ganz aufmacht.
pub fn cors_erlaubt(origin: &str, liste: &[String]) -> bool {
    let o = origin.trim();
    if o.is_empty() || o == "null" || o == "*" {
        return false;
    }
    liste
        .iter()
        .any(|e| !e.trim().is_empty() && e.trim() != "*" && e.trim().eq_ignore_ascii_case(o))
}

/// Auf welcher Adresse gelauscht wird.
///
/// `lan == false` ist die Werkseinstellung und heisst 127.0.0.1 — erreichbar
/// nur von diesem Rechner. `true` heisst 0.0.0.0, also jedes Interface. Es gibt
/// hier absichtlich keinen dritten Fall und keine Hostnamen: eine Adresse, die
/// man falsch lesen kann, ist eine Adresse, die man falsch einstellt.
pub fn bind_addr(lan: bool, port: u16) -> SocketAddr {
    let ip = if lan {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    SocketAddr::new(ip, port)
}

/// Tokenvergleich in konstanter Zeit — und leer passt nie.
///
/// Die zweite Haelfte ist die wichtigere. Ein leeres `expected` entsteht ganz
/// von selbst: Einstellung noch nie geoeffnet, Datei frisch, Feld geleert. Ein
/// gewoehnliches `expected == presented` machte daraus einen Server, den jeder
/// mit leerem Token bedienen kann — der Zustand "noch nicht eingerichtet" waere
/// in der Wirkung "offen fuer alle". Deshalb: leer heisst immer nein.
///
/// Die konstante Zeit ist die kleinere Sorge (ein lokaler Angreifer hat
/// meistens Besseres), kostet aber nichts.
pub fn token_matches(expected: &str, presented: &str) -> bool {
    if expected.is_empty() || presented.is_empty() {
        return false;
    }
    let a = expected.as_bytes();
    let b = presented.as_bytes();
    // Die Laenge ist kein Geheimnis (sie ist von uns erzeugt und immer gleich),
    // der Inhalt schon. Ungleiche Laenge -> nein, aber trotzdem durchlaufen.
    let mut diff: u8 = if a.len() == b.len() { 0 } else { 1 };
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        diff |= x ^ y;
    }
    diff == 0
}

/// Holt das Token aus einer Anfrage: `Authorization: Bearer …` oder `x-api-key`.
///
/// Beide, weil beide in freier Wildbahn vorkommen: OpenAI-Clients schicken
/// Bearer, Anthropic-Clients `x-api-key`, und wer eine App auf diese API
/// umbiegt, tauscht selten mehr als die Basis-URL.
pub fn presented_token(headers: &BTreeMap<String, String>) -> String {
    if let Some(v) = headers.get("authorization") {
        if let Some(b) = v.strip_prefix("Bearer ") {
            return b.trim().to_string();
        }
        if let Some(b) = v.strip_prefix("bearer ") {
            return b.trim().to_string();
        }
    }
    headers.get("x-api-key").map(|v| v.trim().to_string()).unwrap_or_default()
}

/// Kopfzeilen, die NIE nach oben weitergereicht werden.
///
/// `authorization` und `x-api-key` stehen hier aus dem Grund, der oben unter
/// Regel 3 steht: das Token des Aufrufers ist fuer UNS, der Upstream bekommt
/// seins von uns. Der Rest sind Hop-by-Hop-Kopfzeilen (RFC 9110 §7.6.1) plus
/// `host` und `content-length`, die der weiterleitende Client selbst setzt —
/// stehen sie doppelt drin, antwortet der Upstream mit 400.
const NIE_WEITERLEITEN: [&str; 10] = [
    "authorization",
    "x-api-key",
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "transfer-encoding",
];

/// Filtert die Kopfzeilen einer eingehenden Anfrage fuer die Weiterleitung.
pub fn forward_headers(eingehend: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    eingehend
        .iter()
        .filter(|(k, _)| !NIE_WEITERLEITEN.contains(&k.to_ascii_lowercase().as_str()))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
        .collect()
}

/// Ein neues Zufallstoken.
///
/// 32 Bytes aus dem Systemzufall, hex — 256 Bit. Laenger als noetig und kuerzer
/// als unhandlich; es soll in eine Umgebungsvariable passen, die jemand von
/// Hand kopiert.
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{:02x}", x)).collect()
}


// ─────────────────────────────────────────────────────────────────────────────
// Der Lauscher
// ─────────────────────────────────────────────────────────────────────────────

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Wie eine Lane erreicht wird. `base` endet OHNE Schraegstrich und schliesst
/// `/v1` ein, weil genau das die Adresse ist, die alle drei Programme anbieten.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Upstream {
    pub lane_prefix: String,
    pub base: String,
}

impl Upstream {
    pub fn lane(&self) -> Option<Lane> {
        Lane::from_prefix(&self.lane_prefix)
    }
}

/// Die Vorgabe-Upstreams — dieselben Adressen, die die App ohnehin benutzt.
///
/// Sie stehen hier als FALLBACK, nicht als Wahrheit: der Aufrufer aus dem
/// Frontend kennt den echten Ollama-Base (der Nutzer kann ihn umstellen) und
/// den Port, auf dem die Engine gerade wirklich laeuft. Wer nichts uebergibt,
/// bekommt die Werkswerte statt eine leere Liste.
pub fn default_upstreams() -> Vec<Upstream> {
    vec![
        Upstream { lane_prefix: "lu".into(), base: format!("http://127.0.0.1:{}/v1", crate::commands::engine::DEFAULT_ENGINE_PORT) },
        Upstream { lane_prefix: "ollama".into(), base: "http://127.0.0.1:11434/v1".into() },
        Upstream { lane_prefix: "lmstudio".into(), base: "http://127.0.0.1:1234/v1".into() },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalApiConfig {
    pub port: u16,
    /// Werkseinstellung `false`. Siehe Regel 2 im Kopf dieser Datei.
    pub lan: bool,
    pub token: String,
    pub upstreams: Vec<Upstream>,
    /// Herkuenfte, die im Browser mitlesen duerfen. Ab Werk leer — siehe
    /// `cors_erlaubt`.
    #[serde(default)]
    pub cors_origins: Vec<String>,
}

impl Default for LocalApiConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_LOCAL_API_PORT,
            lan: false,
            token: String::new(),
            upstreams: default_upstreams(),
            cors_origins: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct LocalApiState {
    pub cfg: Arc<RwLock<LocalApiConfig>>,
    pub http: reqwest::Client,
}

/// Was `stop` braucht, um wirklich zu stoppen.
pub struct LocalApiServer {
    pub addr: SocketAddr,
    pub shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    pub handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl LocalApiServer {
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}

/// Kopfzeilen einer axum-Anfrage in die Form, die die reinen Funktionen oben
/// lesen. Kleingeschrieben, weil HTTP das ohnehin so meint.
fn header_map_to_btree(h: &HeaderMap) -> BTreeMap<String, String> {
    h.iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.as_str().to_ascii_lowercase(), s.to_string())))
        .collect()
}

fn fehler(code: StatusCode, typ: &str, msg: &str) -> Response {
    fehler_mit(code, typ, msg, None, None)
}

/// Die Fehlerform von OpenAI — vollstaendig, samt `param` und `code`.
///
/// Aus dem Kundenbericht, Fund 4: beide Felder waren ausnahmslos `null`. Ein
/// Client, der auf `error.code == "model_not_found"` verzweigt oder dem Nutzer
/// das falsche Feld markieren will, bekam nichts. `null` ist in OpenAIs Form
/// erlaubt und heisst „trifft hier nicht zu" — wir hatten es als „haben wir
/// nicht ausgefuellt" benutzt, und das ist ein anderer Satz.
fn fehler_mit(code: StatusCode, typ: &str, msg: &str, param: Option<&str>, fehlercode: Option<&str>) -> Response {
    let mut antwort = (code, Json(serde_json::json!({
        "error": {
            "message": msg,
            "type": typ,
            "param": param.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
            "code": fehlercode.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
        }
    }))).into_response();
    if code == StatusCode::UNAUTHORIZED {
        // RFC 9110: eine 401 OHNE WWW-Authenticate ist protokollwidrig. Manche
        // HTTP-Bibliotheken warten darauf, bevor sie ueberhaupt an Zugangsdaten
        // denken.
        antwort.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer realm=\"LU local API\""),
        );
    }
    antwort
}

/// Token-Schranke. Kein Pfad hinter dem Router ist oeffentlich — auch
/// `/v1/models` nicht, denn die Modellliste verraet, was auf diesem Rechner
/// liegt, und das ist bei einer App namens Locally Uncensored eine Auskunft
/// ueber den Nutzer.
async fn auth(
    AxumState(state): AxumState<LocalApiState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let erwartet = state.cfg.read().await.token.clone();
    let gezeigt = presented_token(&header_map_to_btree(req.headers()));
    if !token_matches(&erwartet, &gezeigt) {
        return fehler_mit(
            StatusCode::UNAUTHORIZED,
            "invalid_request_error",
            if erwartet.is_empty() {
                "The local API has no token yet. Open Settings and generate one — until then it answers nobody."
            } else {
                "Missing or wrong API key. Send it as `Authorization: Bearer <token>` or `x-api-key`."
            },
            None,
            Some("invalid_api_key"),
        );
    }
    next.run(req).await
}

#[derive(Serialize)]
struct ModelZeile {
    id: String,
    object: &'static str,
    created: u64,
    owned_by: String,
}

/// Fragt eine Lane nach ihren Modellen. Ein Fehler ist KEIN Abbruch: eine
/// nicht laufende Lane ist der Normalfall (wer nutzt schon alle drei
/// gleichzeitig), und sie darf die Liste der anderen nicht mitnehmen.
async fn lane_modelle(http: &reqwest::Client, up: &Upstream) -> Vec<String> {
    let url = format!("{}/models", up.base.trim_end_matches('/'));
    let r = match http.get(&url).timeout(std::time::Duration::from_secs(4)).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let v: serde_json::Value = match r.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Der aktuelle Katalog ueber alle Lanes, in Lane-Reihenfolge.
async fn katalog(state: &LocalApiState) -> Vec<(Lane, String)> {
    let ups = state.cfg.read().await.upstreams.clone();
    let mut raus: Vec<(Lane, String)> = Vec::new();
    for lane in Lane::ALL {
        for up in ups.iter().filter(|u| u.lane() == Some(lane)) {
            for id in lane_modelle(&state.http, up).await {
                raus.push((lane, id));
            }
        }
    }
    raus
}

async fn handle_models(AxumState(state): AxumState<LocalApiState>) -> Response {
    let k = katalog(&state).await;
    let data: Vec<ModelZeile> = k
        .iter()
        .map(|(l, id)| ModelZeile {
            id: qualified_id(*l, id),
            object: "model",
            created: 0,
            owned_by: l.label().to_string(),
        })
        .collect();
    Json(serde_json::json!({ "object": "list", "data": data })).into_response()
}

/// Die gemeinsame Weiterleitung fuer alles, was ein `model`-Feld traegt.
///
/// Streaming laeuft als Durchreiche: der Koerper der Upstream-Antwort wird
/// ohne Zwischenspeicher weitergegeben. Alles andere waere ein Puffer, der
/// genau die Eigenschaft zerstoert, wegen der jemand `stream: true` schreibt.
async fn weiterleiten(state: LocalApiState, pfad: &str, pflichtfeld: &str, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let mut json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return fehler_mit(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &format!("Body is not JSON: {}", e),
                None,
                Some("invalid_body"),
            )
        }
    };

    // Erst die eigenen Pflichtfelder, dann erst nach oben. Was hier durchfaellt,
    // faellt sonst beim Upstream durch — in dessen Worten, ueber dessen Felder.
    if let Err(f) = koerper_pruefen(&json, pflichtfeld) {
        return fehler_mit(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            &f.nachricht,
            Some(&f.param),
            Some("missing_required_parameter"),
        );
    }

    let gewuenscht = json.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let k = katalog(&state).await;
    let ziel = match resolve_model(&gewuenscht, &k) {
        Ok(m) => m,
        Err(e) => {
            let code = match e {
                ResolveError::Ambiguous { .. } => StatusCode::BAD_REQUEST,
                ResolveError::Unknown(_) | ResolveError::LaneLeer { .. } => StatusCode::NOT_FOUND,
            };
            return fehler_mit(code, "invalid_request_error", &e.message(), Some("model"), Some(e.code()));
        }
    };

    // Nach oben geht die ID, die die Lane kennt — nicht unsere qualifizierte.
    if let Some(m) = json.get_mut("model") {
        *m = serde_json::Value::String(ziel.upstream_id.clone());
    }

    let stream_gewuenscht = json.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

    let base = {
        let cfg = state.cfg.read().await;
        match cfg.upstreams.iter().find(|u| u.lane() == Some(ziel.lane)) {
            Some(u) => u.base.trim_end_matches('/').to_string(),
            None => return fehler(StatusCode::BAD_GATEWAY, "api_error", &format!("{} has no configured address.", ziel.lane.label())),
        }
    };

    let mut req = state.http.post(format!("{}{}", base, pfad));
    for (k, v) in forward_headers(&header_map_to_btree(&headers)) {
        if let (Ok(name), Ok(val)) = (HeaderName::try_from(k.as_str()), HeaderValue::from_str(&v)) {
            req = req.header(name, val);
        }
    }
    let antwort = match req.json(&json).send().await {
        Ok(r) => r,
        Err(e) => {
            return fehler(
                StatusCode::BAD_GATEWAY,
                "api_error",
                &format!("{} did not answer at {}: {}", ziel.lane.label(), base, e),
            )
        }
    };

    let status = antwort.status();
    let ctype = antwort
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    let mut out = Response::builder().status(status);
    if let Ok(v) = HeaderValue::from_str(&ctype) {
        out = out.header(header::CONTENT_TYPE, v);
    }

    // Auf dem Rueckweg traegt `model` wieder die qualifizierte ID. Ohne das
    // steht in der Antwort ein Name, den `/v1/models` nicht kennt.
    let qualifiziert = qualified_id(ziel.lane, &ziel.upstream_id);

    if !stream_gewuenscht {
        // Eine einzelne JSON-Antwort. Sie zu puffern kostet nichts: es gibt
        // hier nichts zu streamen, was ein Client frueher sehen koennte.
        let bytes = match antwort.bytes().await {
            Ok(b) => b,
            Err(e) => {
                return fehler(
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    &format!("{} broke off mid-answer: {}", ziel.lane.label(), e),
                )
            }
        };
        let raus = match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(mut v) => {
                modell_zurueckschreiben(&mut v, &qualifiziert);
                Body::from(v.to_string())
            }
            // Kein JSON (etwa ein HTML-Fehler eines Proxys davor): unveraendert
            // weitergeben. Der Client soll sehen, was wirklich kam.
            Err(_) => Body::from(bytes),
        };
        return out
            .body(raus)
            .unwrap_or_else(|_| fehler(StatusCode::INTERNAL_SERVER_ERROR, "api_error", "Could not build the response."));
    }

    // Streaming: zeilenweise umschreiben, ohne zu puffern. `unfold` traegt den
    // Umschreiber ueber die Chunk-Grenzen und gibt am Schluss noch heraus, was
    // im Rest liegt — ein abgerissener Upstream soll Bytes verlieren duerfen,
    // wir nicht.
    let quelle = antwort.bytes_stream();
    let strom = futures_util::stream::unfold(
        (quelle, SseModellUmschreiber::neu(&qualifiziert), false),
        |(mut quelle, mut um, fertig)| async move {
            use futures_util::StreamExt;
            if fertig {
                return None;
            }
            match quelle.next().await {
                Some(Ok(chunk)) => {
                    let raus = um.schub(&chunk);
                    Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(raus)), (quelle, um, false)))
                }
                Some(Err(e)) => Some((
                    Err(std::io::Error::other(e.to_string())),
                    (quelle, um, true),
                )),
                None => {
                    let rest = um.schluss();
                    Some((Ok(axum::body::Bytes::from(rest)), (quelle, um, true)))
                }
            }
        },
    );

    out.body(Body::from_stream(strom))
        .unwrap_or_else(|_| fehler(StatusCode::INTERNAL_SERVER_ERROR, "api_error", "Could not build the response."))
}

async fn handle_chat(AxumState(state): AxumState<LocalApiState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    weiterleiten(state, "/chat/completions", "messages", headers, body).await
}

async fn handle_completions(AxumState(state): AxumState<LocalApiState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    weiterleiten(state, "/completions", "prompt", headers, body).await
}

async fn handle_embeddings(AxumState(state): AxumState<LocalApiState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    weiterleiten(state, "/embeddings", "input", headers, body).await
}

/// Was gerade laeuft und wohin geleitet wird. Auch das steht hinter dem Token.
async fn handle_health(AxumState(state): AxumState<LocalApiState>) -> Response {
    let cfg = state.cfg.read().await.clone();
    let k = katalog(&state).await;
    let mut je_lane = serde_json::Map::new();
    for lane in Lane::ALL {
        je_lane.insert(
            lane.prefix().to_string(),
            serde_json::json!({
                "label": lane.label(),
                "base": cfg.upstreams.iter().find(|u| u.lane() == Some(lane)).map(|u| u.base.clone()),
                "models": k.iter().filter(|(l, _)| *l == lane).count(),
            }),
        );
    }
    Json(serde_json::json!({
        "ok": true,
        "reach": if cfg.lan { "lan" } else { "localhost" },
        "port": cfg.port,
        "lanes": je_lane,
    }))
    .into_response()
}

/// Die LU-Werkzeuge, die ein Agent auf diesem Rechner hat — mitsamt der Frage,
/// welche Erlaubnis jedes braucht.
///
/// ── WOZU DAS GUT IST ───────────────────────────────────────────────────────
///
/// Ein Programm, das die lokale API benutzt, kann /v1/chat/completions rufen
/// und bekommt ein Modell. Was es NICHT weiss: dass dieser Rechner Dateien
/// lesen, im Netz suchen und Code ausfuehren kann, und was davon der Nutzer
/// freigegeben hat. Diese Liste ist die Antwort darauf, und sie ist ehrlich —
/// die Namen und Erlaubnisstufen sind DIESELBEN, die `gate_for` in remote.rs
/// durchsetzt, nicht eine gepflegte Zweitliste.
///
/// ── WAS HIER (NOCH) NICHT STEHT ────────────────────────────────────────────
///
/// Ein Endpunkt, der einen ganzen Agentenlauf ausfuehrt — Modell rufen,
/// Werkzeugaufrufe lesen, ausfuehren, zurueckgeben, wiederholen. Der Grund ist
/// nicht Zeitmangel allein, sondern wo der Ausfuehrer heute steht: er ist ein
/// rund 400 Zeilen langes `match` INNERHALB von `handle_agent_tool` in
/// remote.rs, verwoben mit `RemoteState`, dem Erlaubnis-Schloss und dem
/// Arbeitsordner-Ueberschreiben je Chat. Ihn herauszuloesen ist ein Eingriff in
/// eine 4.900-Zeilen-Datei, an der gerade parallel gearbeitet wird — und ihn
/// hier ein zweites Mal zu schreiben, waere genau die Zweitliste, vor der der
/// Kommentar bei GATE_KEYWORDS warnt.
///
/// Der Weg dahin ist vorgezeichnet: `gate_for` und der `match`-Block wandern in
/// ein eigenes Modul mit einer Signatur ohne `RemoteState`, dann rufen ihn
/// beide Server. Das ist eine Aufgabe fuer sich, mit eigenen Sperren.
fn lu_werkzeuge() -> serde_json::Value {
    // (Name, Erlaubnis, was es tut) — Erlaubnis `null` heisst: immer offen.
    let liste: [(&str, Option<&str>, &str); 13] = [
        ("file_read",     Some("filesystem"),      "Read a file, windowed by offset/limit."),
        ("file_write",    Some("filesystem"),      "Write a file inside the agent workspace."),
        ("file_list",     Some("filesystem"),      "List a directory."),
        ("file_search",   Some("filesystem"),      "Search file contents."),
        ("screenshot",    Some("filesystem"),      "Capture the screen."),
        ("shell_execute", Some("shell"),           "Run a shell command. RCE-class, off by default."),
        ("code_execute",  Some("shell"),           "Run code. RCE-class, off by default."),
        ("image_generate", Some("process_control"), "Generate an image via the local pipeline."),
        ("web_search",    None,                    "Search the web."),
        ("web_fetch",     None,                    "Read a URL."),
        ("process_list",  Some("process_control"), "List running processes."),
        ("system_info",   None,                    "OS, CPU and memory of this machine."),
        ("get_current_time", None,                 "The clock of this machine."),
    ];
    serde_json::json!({
        "object": "list",
        "data": liste.iter().map(|(name, perm, was)| serde_json::json!({
            "name": name,
            "requires_permission": perm,
            "description": was,
        })).collect::<Vec<_>>(),
        // Ehrlich dazugesagt, statt es den Aufrufer selbst herausfinden zu
        // lassen: diese Liste sagt, was es GIBT, nicht was gerade erlaubt ist.
        // Der Erlaubnisstand haengt am Remote-Panel des Nutzers und wird hier
        // bewusst nicht gespiegelt — eine gespiegelte Erlaubnis, die hinter der
        // echten herhinkt, ist gefaehrlicher als gar keine Angabe.
        "note": "Availability depends on the permissions the user granted in Settings → Remote Access. This list is the catalogue, not the current grant.",
        // Fund 7 des Kundenberichts: 13 Werkzeuge auflisten und keinen Weg
        // anbieten, eines aufzurufen, ist schlechter als sie wegzulassen. Der
        // Katalog bleibt trotzdem — er beantwortet „was kann dieses Geraet",
        // und das ist eine eigene Frage. Er sagt jetzt nur unmissverstaendlich,
        // dass es hier keinen Aufrufweg gibt, und wo einer ist. (Die vorige
        // Fassung verwies auf eine Quelldatei, die kein Kunde hat.)
        "callable_here": false,
        "how_to_call": "This endpoint is a catalogue, not a call surface: there is no POST here. These tools run inside LU itself — from a chat, or over Remote Access after pairing in Settings → Remote Access. An HTTP endpoint for agent runs is planned and not built yet.",
    })
}

async fn handle_tools() -> Response {
    Json(lu_werkzeuge()).into_response()
}

/// Die Selbstauskunft.
///
/// Aus dem Kundenbericht, Fund 5: `/docs` und `/openapi.json` waren beide 404,
/// und dass das Lane-Praefix optional ist, wie die Lanes heissen und welche
/// Parameter durchgereicht werden, hat der Kunde ausschliesslich durch
/// Ausprobieren herausgefunden. Genau das steht jetzt hier — an einer Adresse,
/// die der 404 auch nennt.
fn lu_doku() -> serde_json::Value {
    serde_json::json!({
        "object": "documentation",
        "name": "LU local model API",
        "summary": "One OpenAI-compatible address in front of every model backend on this machine.",
        "auth": {
            "required": "always, also on 127.0.0.1",
            "headers": ["Authorization: Bearer <token>", "x-api-key: <token>"],
            "where_from": "Settings → Local API in the LU app generates it.",
        },
        "model_names": {
            "form": "<lane>/<id as the backend knows it>",
            "lanes": Lane::ALL.iter().map(|l| serde_json::json!({
                "prefix": l.prefix(),
                "name": l.label(),
            })).collect::<Vec<_>>(),
            "prefix_optional": "A bare id works when exactly one lane holds it. When two lanes hold the same name the request is refused rather than guessed — send the qualified id.",
            "round_trip": "Responses echo the qualified id, so what comes back is always findable in GET /v1/models.",
        },
        "routes": [
            { "method": "GET",  "path": "/v1/models",           "note": "Every model across every running lane." },
            { "method": "POST", "path": "/v1/chat/completions",  "note": "Requires `model` and `messages`. `stream: true` streams." },
            { "method": "POST", "path": "/v1/completions",       "note": "Requires `model` and `prompt`." },
            { "method": "POST", "path": "/v1/embeddings",        "note": "Requires `model` and `input`." },
            { "method": "GET",  "path": "/lu/v1/health",         "note": "Per-lane state: address, reachable, model count." },
            { "method": "GET",  "path": "/lu/v1/tools",          "note": "Catalogue of LU agent tools. Not callable over HTTP yet." },
            { "method": "GET",  "path": "/lu/v1/docs",           "note": "This page." },
        ],
        "passthrough": "Everything other than `model` goes to the backend untouched — temperature, tools, response_format, and whatever else that backend supports. What a lane cannot do, this API cannot add.",
        "errors": {
            "shape": "OpenAI's: { error: { message, type, param, code } }",
            "codes": ["invalid_api_key", "invalid_body", "missing_required_parameter", "model_not_found", "model_ambiguous", "lane_unavailable"],
            "lane_unavailable": "The name asked for a real lane that currently holds no models — that backend is most likely not running.",
        },
        "cors": "Off until you list an origin under Settings → Local API. No wildcard: name the origin you want to let read your local model traffic.",
        "request_id": "Every response carries `x-request-id`. Send your own and it is kept, so a report can be correlated.",
    })
}

async fn handle_docs() -> Response {
    Json(lu_doku()).into_response()
}

/// Eine Kennung pro Anfrage, damit ein Fehlerbericht etwas hat, worauf er
/// zeigen kann.
///
/// Aus dem Kundenbericht, Fund 8: die Antworten trugen `content-type`, `date`
/// und `transfer-encoding` — sonst nichts. Wer einen Fehler meldet, kann ihn
/// mit nichts abgleichen. Eine mitgeschickte eigene Kennung wird UEBERNOMMEN
/// statt ueberschrieben; genau das macht Korrelation ueber mehrere Schichten
/// hinweg erst moeglich.
fn naechste_request_id(eigen: Option<&str>) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static ZAEHLER: AtomicU64 = AtomicU64::new(0);
    static START: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(e) = eigen {
        let e = e.trim();
        // Fremde Kennungen begrenzen: sie landen in einem Antwortkopf, und ein
        // Kopf, dessen Laenge der Aufrufer bestimmt, ist ein Hebel.
        if !e.is_empty() && e.len() <= 200 && e.chars().all(|c| c.is_ascii_graphic()) {
            return e.to_string();
        }
    }
    let start = START.get_or_init(|| generate_token()[..8].to_string());
    format!("req_{}_{:x}", start, ZAEHLER.fetch_add(1, Ordering::Relaxed))
}

/// Setzt `x-request-id` auf jede Antwort, auch auf Fehler.
async fn request_id(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let id = naechste_request_id(req.headers().get("x-request-id").and_then(|v| v.to_str().ok()));
    let mut res = next.run(req).await;
    if let Ok(v) = HeaderValue::from_str(&id) {
        res.headers_mut().insert(HeaderName::from_static("x-request-id"), v);
    }
    res
}

/// Die CORS-Schranke. Sitzt VOR der Token-Schranke, weil ein Browser dem
/// Preflight nie Zugangsdaten mitgibt — eine 401 auf OPTIONS ist der Grund,
/// warum beim Kunden jede Weboberflaeche scheiterte.
async fn cors(
    AxumState(state): AxumState<LocalApiState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let herkunft = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let erlaubt = match &herkunft {
        Some(o) => {
            let liste = state.cfg.read().await.cors_origins.clone();
            cors_erlaubt(o, &liste).then(|| o.clone())
        }
        None => None,
    };

    let ist_preflight = req.method() == Method::OPTIONS;
    let mut res = if ist_preflight {
        // Nie an die Token-Schranke weitergeben: der Preflight KANN sie nicht
        // bestehen. Ist die Herkunft nicht freigegeben, kommt eine leere 204
        // ohne CORS-Koepfe zurueck — der Browser blockt dann von selbst, und
        // wir haben nichts verraten.
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };

    if let Some(o) = erlaubt {
        let k = res.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&o) {
            k.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        }
        k.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        k.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("authorization, x-api-key, content-type, x-request-id"),
        );
        k.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("x-request-id"));
        k.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    }
    // Die Antwort haengt von der Herkunft ab — ohne `Vary` liefert jeder Cache
    // davor irgendwann die Freigabe an den Falschen aus.
    res.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
    res
}

pub fn build_local_api_router(state: LocalApiState) -> Router {
    // Die Schichtreihenfolge ist Sicherheit, nicht Geschmack: axum wickelt von
    // unten nach oben, `cors` steht also GANZ AUSSEN und `auth` darunter. Nur
    // so faellt der Preflight nicht in die Token-Schranke. Umgekehrt darf CORS
    // nie eine Anfrage durchlassen, die auth abgelehnt haette — tut es auch
    // nicht: ausser OPTIONS geht alles durch `next`, also durch auth.
    Router::new()
        .route("/v1/models", get(handle_models))
        .route("/v1/chat/completions", post(handle_chat))
        .route("/v1/completions", post(handle_completions))
        .route("/v1/embeddings", post(handle_embeddings))
        .route("/lu/v1/health", get(handle_health))
        .route("/lu/v1/tools", get(handle_tools))
        .route("/lu/v1/docs", get(handle_docs))
        .fallback(|method: Method, uri: axum::http::Uri| async move {
            fehler(
                StatusCode::NOT_FOUND,
                "invalid_request_error",
                &format!("No route {} {}. This server speaks /v1/models, /v1/chat/completions, /v1/completions, /v1/embeddings, /lu/v1/health, /lu/v1/tools and /lu/v1/docs — the last one describes all of them.", method, uri.path()),
            )
        })
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth))
        .layer(axum::middleware::from_fn_with_state(state.clone(), cors))
        .layer(axum::middleware::from_fn(request_id))
        .with_state(state)
}


// ─────────────────────────────────────────────────────────────────────────────
// Start, Stopp, Auskunft — die Tauri-Befehle
// ─────────────────────────────────────────────────────────────────────────────

/// Startet die lokale API. Ein zweiter Aufruf stoppt zuerst den alten Lauscher,
/// damit ein Portwechsel nicht zwei Server hinterlaesst.
///
/// Ohne Token wird NICHT gestartet. Das ist kein Komfortverlust, sondern die
/// einzige Stelle, an der Regel 1 wirklich durchgesetzt werden kann: ein
/// laufender Server ohne Token waere auch mit `token_matches`-Schutz eine
/// offene Tuer, die nur zufaellig zu ist.
#[tauri::command]
pub async fn start_local_api(
    state: tauri::State<'_, crate::state::AppState>,
    port: Option<u16>,
    lan: Option<bool>,
    token: String,
    upstreams: Option<Vec<Upstream>>,
    cors_origins: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    if token.trim().is_empty() {
        return Err("The local API needs a token before it can start. Generate one in Settings.".into());
    }

    stop_local_api_inner(&state);

    let cfg = LocalApiConfig {
        port: port.unwrap_or(DEFAULT_LOCAL_API_PORT),
        lan: lan.unwrap_or(false),
        token: token.trim().to_string(),
        upstreams: upstreams.unwrap_or_else(default_upstreams),
        // Ab Werk leer, und `None` heisst leer — nicht „wie zuletzt". Eine
        // Freigabe, die ein Aufrufer versehentlich weglaesst, soll erloeschen.
        cors_origins: cors_origins
            .unwrap_or_default()
            .into_iter()
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .collect(),
    };
    let addr = bind_addr(cfg.lan, cfg.port);

    let api_state = LocalApiState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        http: reqwest::Client::builder()
            // Kein Gesamt-Timeout: ein langer Stream ist der Normalfall, kein
            // Fehler. Nur das Verbinden bekommt eine Frist, damit ein totes
            // Backend nicht ewig haengt.
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?,
    };

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Could not listen on {}: {}", addr, e))?;
    let echte_addr = listener.local_addr().map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let router = build_local_api_router(api_state);
    let handle = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });

    if let Ok(mut slot) = state.local_api.lock() {
        *slot = Some(LocalApiServer { addr: echte_addr, shutdown: Some(tx), handle: Some(handle) });
    }

    Ok(serde_json::json!({
        "running": true,
        "address": echte_addr.to_string(),
        "reach": if cfg.lan { "lan" } else { "localhost" },
        "baseUrl": format!("http://{}/v1", if cfg.lan { format!("<this-machine>:{}", echte_addr.port()) } else { echte_addr.to_string() }),
    }))
}

fn stop_local_api_inner(state: &crate::state::AppState) {
    if let Ok(mut slot) = state.local_api.lock() {
        if let Some(mut s) = slot.take() {
            s.stop();
        }
    }
}

#[tauri::command]
pub async fn stop_local_api(state: tauri::State<'_, crate::state::AppState>) -> Result<serde_json::Value, String> {
    stop_local_api_inner(&state);
    Ok(serde_json::json!({ "running": false }))
}

#[tauri::command]
pub async fn local_api_status(state: tauri::State<'_, crate::state::AppState>) -> Result<serde_json::Value, String> {
    let laeuft = state
        .local_api
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|x| x.addr))
        .map(|a| serde_json::json!({ "running": true, "address": a.to_string() }))
        .unwrap_or_else(|| serde_json::json!({ "running": false }));
    Ok(laeuft)
}

/// Ein frisches Token. Aufbewahrt wird es vom Frontend (dort liegt der
/// Schluesselbund-Pfad mitsamt Linux-Rueckfall); hier wird es nur erzeugt,
/// damit der Zufall aus dem System kommt und nicht aus `Math.random`.
#[tauri::command]
pub fn local_api_new_token() -> String {
    generate_token()
}


/// Echte Laeufe gegen ein echtes Backend.
///
/// Kein Mock, keine Attrappe: dieser Modul startet den ECHTEN Router auf einem
/// freien Port und schickt echte HTTP-Anfragen hindurch an das Ollama, das auf
/// diesem Rechner laeuft. Was hier gruen ist, ist im Betrieb gruen.
///
/// Netzabhaengig und maschinenabhaengig, deshalb hinter einem Schalter:
///
///   LIVE_LOCAL_API=1 cargo test local_api_echt -- --nocapture --test-threads=1
///
/// Was er NICHT beweist: dass das Token des Aufrufers nicht nach oben geht.
/// Das braeuchte einen mithoerenden Upstream, also eine Attrappe — und die
/// waere hier genau das Falsche. Diese Zusicherung steht als reine Funktion
/// im Modul `tests` oben (`das_token_des_aufrufers_geht_nicht_nach_oben`).
#[cfg(test)]
mod werkzeugliste {
    use super::*;

    /// Die Liste in `lu_werkzeuge` und das Schloss `gate_for` in remote.rs
    /// muessen dasselbe sagen.
    ///
    /// Der Fehler, den das verhindert, ist leise: jemand nimmt ein Werkzeug in
    /// `gate_for` auf oder verschiebt es auf eine strengere Erlaubnis, und die
    /// Liste hier sagt weiter das Alte. Ein Programm, das sie liest, plant dann
    /// mit einem Werkzeug, das es nicht bekommt — oder haelt eines fuer
    /// gesperrt, das offen ist. Beides merkt niemand, weil beide Seiten fuer
    /// sich stimmen.
    ///
    /// Gelesen wird der QUELLTEXT von remote.rs, nicht eine Kopie: eine
    /// gepflegte Zweitliste waere genau das Problem, das hier bewacht wird.
    #[test]
    fn sie_sagt_dasselbe_wie_das_schloss_in_remote_rs() {
        let hier = std::path::Path::new(file!()).parent().unwrap().to_path_buf();
        let remote = std::fs::read_to_string(hier.join("remote.rs"))
            .expect("remote.rs liegt nicht mehr neben local_api.rs");

        let anfang = remote.find("fn gate_for(tool: &str) -> ToolGate {")
            .expect("gate_for heisst nicht mehr so");
        let block = &remote[anfang..anfang + remote[anfang..].find("\n}\n").unwrap()];

        // Zeilenumbrueche raus, bevor gesucht wird: ein Zweig darf ueber
        // mehrere Zeilen gehen, und genau daran ist meine erste Fassung
        // gescheitert — sie las acht von zehn Eintraegen und haette den Rest
        // stillschweigend als "nicht vorhanden" gewertet. Ein Waechter, der
        // die Haelfte uebersieht, ist schlimmer als keiner.
        let flach = block.split_whitespace().collect::<Vec<_>>().join(" ");
        let teile: Vec<&str> = flach.split("=>").collect();

        let mut aus_remote: std::collections::BTreeMap<String, Option<String>> = Default::default();
        for i in 0..teile.len().saturating_sub(1) {
            let links = teile[i];
            let rechts = teile[i + 1];
            let erlaubnis = if rechts.trim_start().starts_with("ToolGate::Open") {
                None
            } else if let Some(j) = rechts.find("Needs(\"") {
                // Nur wenn das Needs VOR dem naechsten Zweig steht.
                if j > 40 { continue }
                let rest = &rechts[j + 7..];
                Some(rest[..rest.find('"').unwrap()].to_string())
            } else {
                continue // der Unknown-Zweig
            };
            // Der linke Teil endet auf den Mustern dieses Zweigs; alles davor
            // gehoert zum vorigen. Vom Ende her lesen.
            for name in links.rsplit('|') {
                let n = name.trim().trim_matches(|c| c == '"' || c == ' ' || c == '}' || c == '{');
                let n = n.rsplit(' ').next().unwrap_or(n).trim_matches('"');
                if n.is_empty() || n == "_" || n.contains('(') { break }
                aus_remote.insert(n.to_string(), erlaubnis.clone());
            }
        }
        assert!(aus_remote.len() >= 10, "gate_for wurde nicht gelesen: {:?}", aus_remote);

        let liste = lu_werkzeuge();
        let mut aus_liste: std::collections::BTreeMap<String, Option<String>> = Default::default();
        for e in liste["data"].as_array().unwrap() {
            aus_liste.insert(
                e["name"].as_str().unwrap().to_string(),
                e["requires_permission"].as_str().map(str::to_string),
            );
        }

        assert_eq!(
            aus_liste, aus_remote,
            "\nlu_werkzeuge() und gate_for() sind auseinandergelaufen.\n\
             links = die Liste, die die lokale API ausgibt\n\
             rechts = das Schloss, das wirklich entscheidet\n"
        );
    }
}

#[cfg(test)]
mod local_api_echt {
    use super::*;
    use std::future::IntoFuture;

    const TOKEN: &str = "pruefzeichen-0123456789abcdef";

    fn an() -> bool {
        std::env::var("LIVE_LOCAL_API").ok().as_deref() == Some("1")
    }

    /// Startet den echten Router auf einem freien Port. Gibt die Basis-URL zurueck.
    async fn starte() -> Option<(String, tokio::task::JoinHandle<()>)> {
        starte_mit(Vec::new()).await
    }

    /// Dasselbe, aber mit einer CORS-Erlaubnisliste.
    async fn starte_mit(cors: Vec<String>) -> Option<(String, tokio::task::JoinHandle<()>)> {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .ok()?;
        // Vorpruefung: laeuft ueberhaupt eine Lane? Ohne das ist der Lauf
        // aussagelos, und ein gruener aussageloser Lauf ist schlimmer als
        // gar keiner.
        let ollama_da = http
            .get("http://127.0.0.1:11434/v1/models")
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if !ollama_da {
            eprintln!("[local_api_echt] Ollama antwortet nicht auf 11434 — uebersprungen");
            return None;
        }

        let cfg = LocalApiConfig {
            port: 0,
            lan: false,
            token: TOKEN.to_string(),
            upstreams: default_upstreams(),
            cors_origins: cors,
        };
        let state = LocalApiState { cfg: Arc::new(RwLock::new(cfg)), http };
        let l = tokio::net::TcpListener::bind(bind_addr(false, 0)).await.ok()?;
        let addr = l.local_addr().ok()?;
        let router = build_local_api_router(state);
        let h = tokio::spawn(async move {
            let _ = axum::serve(l, router).await;
        });
        Some((format!("http://{}", addr), h))
    }

    #[tokio::test]
    async fn ohne_token_antwortet_sie_niemandem() {
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();

        for (was, req) in [
            ("gar kein Token", c.get(format!("{}/v1/models", base))),
            ("falsches Token", c.get(format!("{}/v1/models", base)).bearer_auth("falsch")),
            ("leeres Token", c.get(format!("{}/v1/models", base)).bearer_auth("")),
        ] {
            let r = req.send().await.expect("Anfrage");
            assert_eq!(r.status(), 401, "{} kam durch", was);
        }

        // Und das Gegenstueck: mit dem richtigen Token geht es.
        let r = c.get(format!("{}/v1/models", base)).bearer_auth(TOKEN).send().await.unwrap();
        assert_eq!(r.status(), 200);
        h.abort();
    }

    #[tokio::test]
    async fn die_modellliste_traegt_qualifizierte_namen() {
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let v: serde_json::Value = reqwest::Client::new()
            .get(format!("{}/v1/models", base))
            .bearer_auth(TOKEN)
            .send().await.unwrap().json().await.unwrap();
        let ids: Vec<String> = v["data"].as_array().unwrap().iter()
            .map(|m| m["id"].as_str().unwrap().to_string()).collect();
        eprintln!("[local_api_echt] {} Modelle: {:?}", ids.len(), &ids[..ids.len().min(4)]);
        assert!(!ids.is_empty(), "keine Modelle — laeuft Ollama wirklich?");
        // Jede ID traegt ihre Lane. Ohne das kann ein Client nicht wissen,
        // welches Programm ihm antwortet.
        assert!(ids.iter().all(|i| i.starts_with("lu/") || i.starts_with("ollama/") || i.starts_with("lmstudio/")),
            "unqualifizierte ID dabei: {:?}", ids);
        assert!(ids.iter().any(|i| i.starts_with("ollama/")), "Ollama fehlt in der Liste");
        h.abort();
    }

    #[tokio::test]
    async fn ein_echter_zug_kommt_durch() {
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();
        let Some(modell) = kleinstes_ollama_modell(&c, &base).await else { h.abort(); return };
        eprintln!("[local_api_echt] Zug ueber {}", modell);

        let r = c.post(format!("{}/v1/chat/completions", base))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({
                "model": modell,
                "messages": [{"role": "user", "content": "Answer with the single word: ready"}],
                "max_tokens": 16,
                "temperature": 0,
            }))
            .timeout(std::time::Duration::from_secs(180))
            .send().await.expect("Anfrage");
        assert_eq!(r.status(), 200, "Antwort: {:?}", r.text().await);
        let v: serde_json::Value = r.json().await.unwrap();
        let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
        eprintln!("[local_api_echt] Antwort: {:?}", text);
        assert!(!text.trim().is_empty(), "leere Antwort: {}", v);
        h.abort();
    }

    #[tokio::test]
    async fn ein_strom_kommt_in_stuecken_an_und_nicht_am_stueck() {
        if !an() { return }
        use futures_util::StreamExt;
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();
        let Some(modell) = kleinstes_ollama_modell(&c, &base).await else { h.abort(); return };

        let r = c.post(format!("{}/v1/chat/completions", base))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({
                "model": modell,
                "messages": [{"role": "user", "content": "Count from one to ten in words."}],
                "max_tokens": 64,
                "temperature": 0,
                "stream": true,
            }))
            .timeout(std::time::Duration::from_secs(180))
            .send().await.expect("Anfrage");
        assert_eq!(r.status(), 200);

        let mut stuecke = 0usize;
        let mut bytes = 0usize;
        let mut strom = r.bytes_stream();
        while let Some(Ok(b)) = strom.next().await {
            stuecke += 1;
            bytes += b.len();
        }
        eprintln!("[local_api_echt] Strom: {} Stuecke, {} Bytes", stuecke, bytes);
        assert!(bytes > 0, "nichts angekommen");
        // Der eigentliche Punkt: mehr als EIN Stueck. Wer die Antwort
        // zwischenspeichert und am Ende ausliefert, kommt hier auf 1 — und
        // genau dafuer schreibt niemand `stream: true`.
        assert!(stuecke > 1, "in einem Stueck angekommen — da puffert jemand");
        h.abort();
    }

    #[tokio::test]
    async fn ein_unbekanntes_modell_sagt_wo_man_nachsieht() {
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let r = reqwest::Client::new()
            .post(format!("{}/v1/chat/completions", base))
            .bearer_auth(TOKEN)
            // Die Nutzlast ist ansonsten GUELTIG. Vorher stand hier
            // `"messages": []`, und der 404 kam nur, weil niemand die leere
            // Liste prueste — seit `koerper_pruefen` faengt die sie vorher ab,
            // und der Test haette eine 400 fuer einen Modellbefund gehalten.
            .json(&serde_json::json!({
                "model": "gibtsnicht-42",
                "messages": [{"role": "user", "content": "hi"}],
            }))
            .send().await.unwrap();
        assert_eq!(r.status(), 404);
        let v: serde_json::Value = r.json().await.unwrap();
        let m = v["error"]["message"].as_str().unwrap_or("");
        assert!(m.contains("/v1/models"), "Fehlertext hilft nicht weiter: {}", m);
        assert_eq!(v["error"]["code"], "model_not_found");
        h.abort();
    }

    #[tokio::test]
    async fn die_auskunft_sagt_wie_weit_sie_reicht() {
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let v: serde_json::Value = reqwest::Client::new()
            .get(format!("{}/lu/v1/health", base))
            .bearer_auth(TOKEN)
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(v["reach"], "localhost");
        assert!(v["lanes"]["ollama"]["models"].as_u64().unwrap_or(0) > 0);
        h.abort();
    }

    /// Haelt den ECHTEN Server auf einem festen Port offen, damit ihn jemand
    /// benutzen kann, der nichts von diesem Code weiss.
    ///
    /// Das ist kein Test im ueblichen Sinn — er prueft nichts. Er ist das
    /// Labor fuer den Persona-Durchlauf: derselbe Router, dieselbe
    /// Token-Schranke, dieselbe Weiterleitung wie im Betrieb, nur ohne das
    /// App-Fenster, das die Einstellungen sonst bedient.
    ///
    ///   LIVE_LOCAL_API_HOLD=1 LU_API_PORT=8129 LU_API_TOKEN=... \
    ///     cargo test halte_die_api_offen -- --nocapture --test-threads=1
    #[tokio::test]
    async fn halte_die_api_offen() {
        if std::env::var("LIVE_LOCAL_API_HOLD").ok().as_deref() != Some("1") { return }
        let port: u16 = std::env::var("LU_API_PORT").ok().and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_LOCAL_API_PORT);
        let token = std::env::var("LU_API_TOKEN").unwrap_or_else(|_| generate_token());
        let minuten: u64 = std::env::var("LU_API_MINUTES").ok().and_then(|s| s.parse().ok()).unwrap_or(20);

        let state = LocalApiState {
            cfg: Arc::new(RwLock::new(LocalApiConfig {
                port, lan: false, token: token.clone(), upstreams: default_upstreams(),
                // Damit auch eine Weboberflaeche gegen diesen Halter geprueft
                // werden kann: LU_API_CORS="http://localhost:3000".
                cors_origins: std::env::var("LU_API_CORS")
                    .unwrap_or_default()
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            })),
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5)).build().unwrap(),
        };
        let l = tokio::net::TcpListener::bind(bind_addr(false, port)).await
            .unwrap_or_else(|e| panic!("Port {} nicht frei: {}", port, e));
        eprintln!("[halte_die_api_offen] http://127.0.0.1:{}/v1  ·  Token {}", port, token);
        eprintln!("[halte_die_api_offen] {} Minuten offen", minuten);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(minuten * 60),
            axum::serve(l, build_local_api_router(state)).into_future(),
        ).await;
    }

    #[tokio::test]
    async fn die_werkzeugliste_kommt_durch_und_nur_mit_token() {
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();

        // Auch die Werkzeugliste ist keine oeffentliche Auskunft: sie sagt,
        // was auf DIESEM Rechner moeglich ist.
        assert_eq!(c.get(format!("{}/lu/v1/tools", base)).send().await.unwrap().status(), 401);

        let v: serde_json::Value = c.get(format!("{}/lu/v1/tools", base))
            .bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
        let namen: Vec<&str> = v["data"].as_array().unwrap().iter()
            .map(|e| e["name"].as_str().unwrap()).collect();
        assert!(namen.contains(&"file_read"));
        assert!(namen.contains(&"shell_execute"));
        // Und der ehrliche Zusatz: die Liste ist der Katalog, nicht die
        // aktuelle Freigabe.
        assert!(v["note"].as_str().unwrap().contains("permissions"));
        h.abort();
    }

    /// Sucht das kleinste laufbereite Ollama-Modell. Klein, weil der Test
    /// schnell sein soll — nicht, weil die Groesse etwas beweist.
    async fn kleinstes_ollama_modell(c: &reqwest::Client, base: &str) -> Option<String> {
        let v: serde_json::Value = c.get(format!("{}/v1/models", base))
            .bearer_auth(TOKEN).send().await.ok()?.json().await.ok()?;
        let ids: Vec<String> = v["data"].as_array()?.iter()
            .filter_map(|m| m["id"].as_str())
            .filter(|i| i.starts_with("ollama/"))
            // Embedder koennen nicht chatten.
            .filter(|i| !i.contains("embed"))
            .map(str::to_string).collect();
        for bevorzugt in ["smollm2:135m", "smollm2:360m", "qwen2.5:0.5b"] {
            if let Some(i) = ids.iter().find(|i| i.ends_with(bevorzugt)) { return Some(i.clone()) }
        }
        ids.into_iter().next()
    }

    // ── Der Kundenbericht vom 02.09.2026, gegen den echten Server ────────
    //
    // Diese neun Tests sind die Gegenprobe zu einem Bericht, den ein Agent
    // ohne jede Kenntnis des Codes geschrieben hat. Sie pruefen NICHT, was der
    // Code tut, sondern was der Kunde vermisst hat.

    #[tokio::test]
    async fn was_zurueckkommt_steht_auch_in_der_liste() {
        // Fund 2, der haerteste: `ollama/llama3.2:3b` rein, `llama3.2:3b` raus.
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();

        let liste: serde_json::Value = c.get(format!("{}/v1/models", base)).bearer_auth(TOKEN)
            .send().await.unwrap().json().await.unwrap();
        let ids: Vec<String> = liste["data"].as_array().unwrap().iter()
            .map(|m| m["id"].as_str().unwrap().to_string()).collect();
        let Some(erstes) = ids.first().cloned() else {
            eprintln!("[local_api_echt] keine Modelle geladen — uebersprungen");
            h.abort();
            return;
        };

        let r: serde_json::Value = c.post(format!("{}/v1/chat/completions", base)).bearer_auth(TOKEN)
            .json(&serde_json::json!({
                "model": erstes, "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}],
            }))
            .send().await.unwrap().json().await.unwrap();
        let zurueck = r["model"].as_str().unwrap_or("");
        assert_eq!(zurueck, erstes, "Round-Trip gebrochen: rein {}, raus {}", erstes, zurueck);
        assert!(ids.contains(&zurueck.to_string()), "{} steht nicht in /v1/models", zurueck);
        h.abort();
    }

    #[tokio::test]
    async fn auch_jeder_streaming_chunk_traegt_ihn() {
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();
        let liste: serde_json::Value = c.get(format!("{}/v1/models", base)).bearer_auth(TOKEN)
            .send().await.unwrap().json().await.unwrap();
        let Some(erstes) = liste["data"].as_array().unwrap().first()
            .map(|m| m["id"].as_str().unwrap().to_string()) else { h.abort(); return };

        let text = c.post(format!("{}/v1/chat/completions", base)).bearer_auth(TOKEN)
            .json(&serde_json::json!({
                "model": erstes, "stream": true, "max_tokens": 3,
                "messages": [{"role": "user", "content": "zaehl bis drei"}],
            }))
            .send().await.unwrap().text().await.unwrap();

        let mut gesehen = 0usize;
        for zeile in text.lines().filter(|l| l.starts_with("data: ") && !l.contains("[DONE]")) {
            let v: serde_json::Value = match serde_json::from_str(&zeile[6..]) { Ok(v) => v, Err(_) => continue };
            if let Some(m) = v["model"].as_str() {
                assert_eq!(m, erstes, "Chunk traegt {} statt {}", m, erstes);
                gesehen += 1;
            }
        }
        assert!(gesehen > 0, "kein einziger Chunk mit model-Feld:\n{}", text);
        // Und das Protokoll ist heil geblieben.
        assert!(text.contains("data: [DONE]"), "kein [DONE]:\n{}", text);
        h.abort();
    }

    #[tokio::test]
    async fn eine_stille_lane_wird_als_solche_gemeldet() {
        // Fund 1. LM Studio laeuft auf dieser Maschine nicht — genau der Fall.
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();
        let r = c.post(format!("{}/v1/chat/completions", base)).bearer_auth(TOKEN)
            .json(&serde_json::json!({
                "model": "lmstudio/gibt-es-hier-nicht",
                "messages": [{"role": "user", "content": "hi"}],
            }))
            .send().await.unwrap();
        assert_eq!(r.status(), 404);
        let v: serde_json::Value = r.json().await.unwrap();
        let code = v["error"]["code"].as_str().unwrap_or("");
        let msg = v["error"]["message"].as_str().unwrap_or("");
        // Laeuft LM Studio doch, ist „unbekannt" die richtige Antwort — dann
        // prueft dieser Test die andere Haelfte derselben Regel.
        assert!(
            code == "lane_unavailable" || code == "model_not_found",
            "unerwarteter code {}: {}", code, msg
        );
        if code == "lane_unavailable" {
            assert!(msg.contains("LM Studio") && msg.contains("not running"), "{}", msg);
        }
        assert_eq!(v["error"]["param"], "model");
        h.abort();
    }

    #[tokio::test]
    async fn fehlende_pflichtfelder_heissen_beim_namen() {
        // Fund 4: „[] is too short - 'messages'" kam vom Upstream durch.
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();

        let r = c.post(format!("{}/v1/chat/completions", base)).bearer_auth(TOKEN)
            .json(&serde_json::json!({ "model": "ollama/irgendwas" }))
            .send().await.unwrap();
        assert_eq!(r.status(), 400);
        let v: serde_json::Value = r.json().await.unwrap();
        assert_eq!(v["error"]["param"], "messages");
        assert_eq!(v["error"]["code"], "missing_required_parameter");
        assert!(!v["error"]["message"].as_str().unwrap().contains("too short"),
                "Upstream-Meldung durchgereicht: {}", v["error"]["message"]);

        let r = c.post(format!("{}/v1/chat/completions", base)).bearer_auth(TOKEN)
            .json(&serde_json::json!({ "messages": [{"role": "user", "content": "hi"}] }))
            .send().await.unwrap();
        let v: serde_json::Value = r.json().await.unwrap();
        assert_eq!(v["error"]["param"], "model");
        h.abort();
    }

    #[tokio::test]
    async fn ohne_freigabe_bleibt_der_browser_draussen_mit_freigabe_nicht() {
        // Fund 3. Beide Haelften, sonst prueft der Test nur eine Meinung.
        if !an() { return }
        let c = reqwest::Client::new();

        // Zu: kein einziger CORS-Kopf, auch nicht fuer eine freundliche Seite.
        let Some((base, h)) = starte().await else { return };
        let r = c.request(reqwest::Method::OPTIONS, format!("{}/v1/chat/completions", base))
            .header("Origin", "http://localhost:3000")
            .header("Access-Control-Request-Method", "POST")
            .send().await.unwrap();
        assert!(r.headers().get("access-control-allow-origin").is_none(),
                "Freigabe ohne Eintrag erteilt");
        h.abort();

        // Offen: der Preflight geht durch, OHNE Token — der Browser sendet nie
        // eines mit, und genau daran scheiterte der Kunde.
        let Some((base, h)) = starte_mit(vec!["http://localhost:3000".into()]).await else { return };
        let r = c.request(reqwest::Method::OPTIONS, format!("{}/v1/chat/completions", base))
            .header("Origin", "http://localhost:3000")
            .header("Access-Control-Request-Method", "POST")
            .send().await.unwrap();
        assert!(r.status().is_success(), "Preflight kam mit {} zurueck", r.status());
        assert_eq!(r.headers()["access-control-allow-origin"], "http://localhost:3000");
        assert!(r.headers()["access-control-allow-headers"].to_str().unwrap().contains("authorization"));

        // Eine andere Herkunft bekommt trotzdem nichts.
        let r = c.request(reqwest::Method::OPTIONS, format!("{}/v1/chat/completions", base))
            .header("Origin", "https://boese.example")
            .header("Access-Control-Request-Method", "POST")
            .send().await.unwrap();
        assert!(r.headers().get("access-control-allow-origin").is_none(), "fremde Herkunft freigegeben");

        // Und die Freigabe ersetzt das Token NICHT.
        let r = c.get(format!("{}/v1/models", base)).header("Origin", "http://localhost:3000")
            .send().await.unwrap();
        assert_eq!(r.status(), 401, "CORS hat die Token-Schranke uebersprungen");
        h.abort();
    }

    #[tokio::test]
    async fn die_selbstauskunft_ist_erreichbar_und_der_404_nennt_sie() {
        // Fund 5: /docs und /openapi.json waren beide 404, und alles musste
        // erraten werden.
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();

        let v: serde_json::Value = c.get(format!("{}/lu/v1/docs", base)).bearer_auth(TOKEN)
            .send().await.unwrap().json().await.unwrap();
        assert!(v["routes"].as_array().unwrap().len() >= 7);
        assert!(v["model_names"]["prefix_optional"].is_string());

        // Der Weg dorthin steht im 404 — so hat der Kunde die Routen gefunden.
        let v: serde_json::Value = c.get(format!("{}/docs", base)).bearer_auth(TOKEN)
            .send().await.unwrap().json().await.unwrap();
        assert!(v["error"]["message"].as_str().unwrap().contains("/lu/v1/docs"),
                "der 404 nennt die Doku nicht: {}", v["error"]["message"]);
        h.abort();
    }

    #[tokio::test]
    async fn jede_antwort_traegt_eine_kennung() {
        // Fund 8: es gab nichts zu korrelieren.
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();

        // Auch auf dem 401 — gerade dort, denn darueber wird berichtet.
        let r = c.get(format!("{}/v1/models", base)).send().await.unwrap();
        assert_eq!(r.status(), 401);
        assert!(r.headers().contains_key("x-request-id"));
        assert!(r.headers().contains_key("www-authenticate"), "401 ohne WWW-Authenticate");

        let a = c.get(format!("{}/v1/models", base)).bearer_auth(TOKEN).send().await.unwrap();
        let b = c.get(format!("{}/v1/models", base)).bearer_auth(TOKEN).send().await.unwrap();
        assert_ne!(a.headers()["x-request-id"], b.headers()["x-request-id"]);

        // Eine mitgebrachte Kennung bleibt erhalten.
        let r = c.get(format!("{}/v1/models", base)).bearer_auth(TOKEN)
            .header("x-request-id", "kunde-4711").send().await.unwrap();
        assert_eq!(r.headers()["x-request-id"], "kunde-4711");
        h.abort();
    }

    #[tokio::test]
    async fn die_werkzeugantwort_nennt_keine_quelldatei() {
        // Fund 6/7.
        if !an() { return }
        let Some((base, h)) = starte().await else { return };
        let c = reqwest::Client::new();
        let t = c.get(format!("{}/lu/v1/tools", base)).bearer_auth(TOKEN)
            .send().await.unwrap().text().await.unwrap();
        assert!(!t.contains("local_api.rs"), "Quelldateiverweis beim Kunden: {}", t);
        assert!(t.contains("\"callable_here\":false"), "sagt nicht, dass hier nichts aufrufbar ist");
        h.abort();
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    fn katalog() -> Vec<(Lane, String)> {
        vec![
            (Lane::Engine, "qwen3-8b".into()),
            (Lane::Ollama, "llama3.2:3b".into()),
            (Lane::Ollama, "huihui_ai/qwen3-abliterated:4b".into()),
            (Lane::Ollama, "qwen3-8b".into()),
            (Lane::LmStudio, "mistral-7b-instruct".into()),
        ]
    }

    // ── Namensaufloesung ──────────────────────────────────────────────────

    #[test]
    fn qualifizierter_name_trifft_genau_eine_lane() {
        let r = resolve_model("ollama/qwen3-8b", &katalog()).unwrap();
        assert_eq!(r.lane, Lane::Ollama);
        assert_eq!(r.upstream_id, "qwen3-8b");

        let r = resolve_model("lu/qwen3-8b", &katalog()).unwrap();
        assert_eq!(r.lane, Lane::Engine);
    }

    #[test]
    fn blosser_name_geht_wenn_er_eindeutig_ist() {
        let r = resolve_model("mistral-7b-instruct", &katalog()).unwrap();
        assert_eq!(r.lane, Lane::LmStudio);
    }

    #[test]
    fn blosser_name_in_zwei_lanes_wird_nicht_geraten() {
        // Der Fall, um den es geht: `qwen3-8b` liegt in der Engine UND in
        // Ollama. Eine stille Wahl waere hier das Schlimmste — der Nutzer
        // bekaeme Antworten von einem Modell, das er nicht gemeint hat, und
        // nichts im Ablauf sagte es ihm.
        let e = resolve_model("qwen3-8b", &katalog()).unwrap_err();
        match &e {
            ResolveError::Ambiguous { candidates, .. } => {
                assert_eq!(candidates, &vec!["lu/qwen3-8b".to_string(), "ollama/qwen3-8b".to_string()]);
            }
            other => panic!("erwartet Ambiguous, war {:?}", other),
        }
        assert!(e.message().contains("lu/qwen3-8b"));
        assert!(e.message().contains("ollama/qwen3-8b"));
    }

    #[test]
    fn eine_ollama_id_mit_schraegstrich_bleibt_lesbar() {
        // `huihui_ai/…` faengt mit einem Segment an, das keine Lane ist — das
        // ist der leichte Teil.
        let r = resolve_model("huihui_ai/qwen3-abliterated:4b", &katalog()).unwrap();
        assert_eq!(r.lane, Lane::Ollama);
        // Und qualifiziert davor gestellt ebenfalls.
        let r = resolve_model("ollama/huihui_ai/qwen3-abliterated:4b", &katalog()).unwrap();
        assert_eq!(r.lane, Lane::Ollama);
        assert_eq!(r.upstream_id, "huihui_ai/qwen3-abliterated:4b");
    }

    #[test]
    fn ein_modellname_der_wie_ein_praefix_beginnt_geht_nicht_verloren() {
        // Der Fall, an dem eine naive Fassung scheitert: jemand zieht bei
        // Ollama ein Modell, dessen Namensraum zufaellig "lu" heisst. Wer nach
        // dem Praefix-Fehlschlag aufgibt, meldet "unbekannt" fuer ein Modell,
        // das direkt vor ihm liegt.
        let k = vec![(Lane::Ollama, "lu/experiment:latest".to_string())];
        let r = resolve_model("lu/experiment:latest", &k).unwrap();
        assert_eq!(r.lane, Lane::Ollama);
    }

    #[test]
    fn unbekannt_nennt_den_weg_nach_draussen() {
        let e = resolve_model("gibtsnicht", &katalog()).unwrap_err();
        assert_eq!(e, ResolveError::Unknown("gibtsnicht".into()));
        assert!(e.message().contains("/v1/models"));
    }

    #[test]
    fn leerer_name_ist_unbekannt_und_stuerzt_nicht_ab() {
        assert!(matches!(resolve_model("", &katalog()), Err(ResolveError::Unknown(_))));
        assert!(matches!(resolve_model("   ", &katalog()), Err(ResolveError::Unknown(_))));
    }

    // ── Bindeadresse ──────────────────────────────────────────────────────

    #[test]
    fn ab_werk_hoert_nur_dieser_rechner_zu() {
        assert_eq!(bind_addr(false, 8129).ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(bind_addr(false, 8129).port(), 8129);
    }

    #[test]
    fn lan_bedeutet_alle_interfaces_und_nur_wenn_gewaehlt() {
        assert_eq!(bind_addr(true, 8129).ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }

    // ── Token ─────────────────────────────────────────────────────────────

    #[test]
    fn ein_leeres_token_passt_zu_nichts() {
        // Die wichtigste Zusicherung dieser Datei. Ohne sie heisst "noch nicht
        // eingerichtet" in der Wirkung "offen fuer alle".
        assert!(!token_matches("", ""));
        assert!(!token_matches("", "irgendwas"));
        assert!(!token_matches("geheim", ""));
    }

    #[test]
    fn gleiches_token_passt_ungleiches_nicht() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc1234"));
        assert!(!token_matches("abc123", "abc12"));
    }

    #[test]
    fn erzeugte_token_sind_lang_und_verschieden() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64, "32 Bytes hex");
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn das_token_kommt_aus_beiden_ueblichen_kopfzeilen() {
        let mut h = BTreeMap::new();
        h.insert("authorization".to_string(), "Bearer geheim".to_string());
        assert_eq!(presented_token(&h), "geheim");

        let mut h = BTreeMap::new();
        h.insert("x-api-key".to_string(), "geheim".to_string());
        assert_eq!(presented_token(&h), "geheim");

        assert_eq!(presented_token(&BTreeMap::new()), "");
    }

    #[test]
    fn ein_authorization_ohne_bearer_gilt_nicht_als_token() {
        // `Basic …` ist kein Bearer, und wir wollen keinen Zufallstreffer.
        let mut h = BTreeMap::new();
        h.insert("authorization".to_string(), "Basic YWJjOmRlZg==".to_string());
        assert_eq!(presented_token(&h), "");
    }

    // ── Weiterleitung ─────────────────────────────────────────────────────

    #[test]
    fn das_token_des_aufrufers_geht_nicht_nach_oben() {
        // Regel 3. Ohne sie reichte die lokale API das Token des Clients an
        // llama-server / Ollama / LM Studio durch — an Programme, die es nichts
        // angeht, und in deren Logs es dann steht.
        let mut h = BTreeMap::new();
        h.insert("authorization".to_string(), "Bearer geheim".to_string());
        h.insert("x-api-key".to_string(), "auchgeheim".to_string());
        h.insert("content-type".to_string(), "application/json".to_string());
        let raus = forward_headers(&h);
        assert!(!raus.contains_key("authorization"));
        assert!(!raus.contains_key("x-api-key"));
        assert_eq!(raus.get("content-type").map(String::as_str), Some("application/json"));
    }

    #[test]
    fn hop_by_hop_kopfzeilen_bleiben_hier() {
        let mut h = BTreeMap::new();
        for k in ["host", "content-length", "connection", "transfer-encoding", "te"] {
            h.insert(k.to_string(), "x".to_string());
        }
        h.insert("accept".to_string(), "text/event-stream".to_string());
        let raus = forward_headers(&h);
        assert_eq!(raus.len(), 1, "nur accept bleibt uebrig: {:?}", raus);
        assert!(raus.contains_key("accept"));
    }

    #[test]
    fn grossschreibung_schuetzt_keine_kopfzeile() {
        // HTTP-Kopfzeilen sind ohne Ruecksicht auf Gross- und Kleinschreibung.
        // Ein Filter, der das vergisst, laesst `Authorization` durch und
        // streicht nur `authorization` — und niemand sieht es.
        let mut h = BTreeMap::new();
        h.insert("Authorization".to_string(), "Bearer geheim".to_string());
        h.insert("X-Api-Key".to_string(), "geheim".to_string());
        let raus = forward_headers(&h);
        assert!(raus.is_empty(), "durchgerutscht: {:?}", raus);
    }

    // ── Namen nach aussen ─────────────────────────────────────────────────

    #[test]
    fn jede_lane_hat_ein_eigenes_praefix_und_es_geht_hin_und_zurueck() {
        let mut gesehen = std::collections::HashSet::new();
        for l in Lane::ALL {
            assert!(gesehen.insert(l.prefix()), "Praefix doppelt: {}", l.prefix());
            assert_eq!(Lane::from_prefix(l.prefix()), Some(l));
        }
        assert_eq!(Lane::from_prefix("openai"), None);
    }

    #[test]
    fn qualifizierte_namen_sehen_aus_wie_erwartet() {
        assert_eq!(qualified_id(Lane::Engine, "qwen3-8b"), "lu/qwen3-8b");
        assert_eq!(qualified_id(Lane::Ollama, "llama3.2:3b"), "ollama/llama3.2:3b");
        assert_eq!(qualified_id(Lane::LmStudio, "m"), "lmstudio/m");
    }

    // ── Round-Trip: was rausgeht, muss in /v1/models stehen ───────────────
    //
    // Aus dem Kundenbericht vom 02.09.2026, Fund 2. Diese Tests beschreiben
    // NICHT den Code, sondern was der Kunde erwartet hat und nicht bekam.

    #[test]
    fn die_antwort_nennt_das_modell_so_wie_die_liste_es_fuehrt() {
        let mut v: serde_json::Value =
            serde_json::from_str(r#"{"id":"chatcmpl-1","model":"llama3.2:3b","object":"chat.completion"}"#).unwrap();
        assert!(modell_zurueckschreiben(&mut v, "ollama/llama3.2:3b"));
        assert_eq!(v["model"], "ollama/llama3.2:3b");
        // Der Rest bleibt unangetastet.
        assert_eq!(v["id"], "chatcmpl-1");
        assert_eq!(v["object"], "chat.completion");
    }

    #[test]
    fn ohne_modellfeld_wird_nichts_erfunden() {
        // Fehlerantworten des Upstreams haben kein `model`. Eines einzusetzen
        // hiesse, eine Auskunft zu erfinden, die niemand gegeben hat.
        let mut v: serde_json::Value = serde_json::from_str(r#"{"error":{"message":"nope"}}"#).unwrap();
        assert!(!modell_zurueckschreiben(&mut v, "ollama/llama3.2:3b"));
        assert!(v.get("model").is_none());
    }

    #[test]
    fn jeder_streaming_chunk_traegt_die_qualifizierte_id() {
        let mut u = SseModellUmschreiber::neu("ollama/llama3.2:3b");
        let ein = b"data: {\"model\":\"llama3.2:3b\",\"choices\":[]}\n\ndata: [DONE]\n\n";
        let aus = String::from_utf8(u.schub(ein)).unwrap();
        assert!(aus.contains(r#""model":"ollama/llama3.2:3b""#), "kam an: {}", aus);
        assert!(!aus.contains(r#""model":"llama3.2:3b""#), "nackte ID uebrig: {}", aus);
        // Das Abschlusszeichen des Protokolls bleibt, sonst haengt jeder Client.
        assert!(aus.contains("data: [DONE]"), "kam an: {}", aus);
        assert!(u.schluss().is_empty());
    }

    #[test]
    fn ein_modellname_ueber_der_chunk_grenze_ueberlebt() {
        // Der Fall, an dem jede Fassung scheitert, die im Bytestrom sucht:
        // TCP zerlegt, wo es will, auch mitten im Namen.
        let mut u = SseModellUmschreiber::neu("lu/qwen3-8b");
        let mut aus = u.schub(b"data: {\"model\":\"qwen3");
        aus.extend(u.schub(b"-8b\",\"object\":\"chat.completion.chunk\"}\n"));
        aus.extend(u.schluss());
        let s = String::from_utf8(aus).unwrap();
        assert!(s.contains(r#""model":"lu/qwen3-8b""#), "kam an: {}", s);
    }

    #[test]
    fn unlesbare_zeilen_gehen_unveraendert_durch() {
        // Kommentarzeilen (`: ping`) und alles, was wir nicht als JSON lesen,
        // sind fremdes Protokoll. Durchreichen, nicht raten.
        let mut u = SseModellUmschreiber::neu("ollama/x");
        let aus = String::from_utf8(u.schub(b": ping\ndata: kein-json\n")).unwrap();
        assert_eq!(aus, ": ping\ndata: kein-json\n");
    }

    // ── Was der Kunde gemeldet hat, Punkt fuer Punkt ──────────────────────

    #[test]
    fn eine_stille_lane_sagt_dass_sie_still_ist() {
        // Fund 1: nur Ollama lief. `lu/…` beantwortete das mit „Unknown model",
        // und der Kunde schloss daraus, das Drei-Wege-Versprechen sei unbelegt.
        let nur_ollama = vec![(Lane::Ollama, "llama3.2:3b".to_string())];
        let e = resolve_model("lu/qwen3-8b", &nur_ollama).unwrap_err();
        assert_eq!(e, ResolveError::LaneLeer { lane: Lane::Engine, requested: "lu/qwen3-8b".into() });
        assert_eq!(e.code(), "lane_unavailable");
        let m = e.message();
        assert!(m.contains("LU Engine"), "{}", m);
        assert!(m.contains("not running"), "{}", m);
        assert!(m.contains("/lu/v1/health"), "{}", m);
    }

    #[test]
    fn eine_laufende_lane_sagt_weiter_unbekannt() {
        // Die Gegenprobe, ohne die der Fix nur eine Umbenennung waere: fuehrt
        // die Lane etwas, ist ein Fehlgriff wieder schlicht ein Fehlgriff.
        let e = resolve_model("ollama/gibt-es-nicht", &katalog()).unwrap_err();
        assert_eq!(e.code(), "model_not_found");
    }

    #[test]
    fn pflichtfelder_werden_hier_geprueft_und_nicht_oben() {
        // Fund 4: ohne `messages` kam eine Ollama-Schemameldung beim Kunden an.
        let ohne_messages: serde_json::Value = serde_json::from_str(r#"{"model":"ollama/llama3.2:3b"}"#).unwrap();
        let f = koerper_pruefen(&ohne_messages, "messages").unwrap_err();
        assert_eq!(f.param, "messages");
        assert!(f.nachricht.contains("Missing required parameter"), "{}", f.nachricht);

        let ohne_modell: serde_json::Value = serde_json::from_str(r#"{"messages":[]}"#).unwrap();
        let f = koerper_pruefen(&ohne_modell, "messages").unwrap_err();
        assert_eq!(f.param, "model", "fehlendes model muss model heissen, nicht „Unknown model ''\u{22}");

        // Leere Liste ist kein gueltiges Gespraech.
        let leer: serde_json::Value = serde_json::from_str(r#"{"model":"x","messages":[]}"#).unwrap();
        assert_eq!(koerper_pruefen(&leer, "messages").unwrap_err().param, "messages");

        // Und der Normalfall geht durch — sonst waere die Pruefung eine Mauer.
        let gut: serde_json::Value =
            serde_json::from_str(r#"{"model":"x","messages":[{"role":"user","content":"hi"}]}"#).unwrap();
        assert!(koerper_pruefen(&gut, "messages").is_ok());
        // Jeder Endpunkt hat sein eigenes Pflichtfeld.
        let emb: serde_json::Value = serde_json::from_str(r#"{"model":"x","input":"hi"}"#).unwrap();
        assert!(koerper_pruefen(&emb, "input").is_ok());
        assert_eq!(koerper_pruefen(&emb, "prompt").unwrap_err().param, "prompt");
    }

    #[test]
    fn cors_ist_zu_bis_jemand_eine_herkunft_benennt() {
        // Fund 3, und Regel 1 im Dateikopf gleichzeitig.
        assert!(!cors_erlaubt("http://localhost:3000", &[]));
        assert!(cors_erlaubt("http://localhost:3000", &["http://localhost:3000".into()]));
        // Gross/klein ist bei Hostnamen bedeutungslos.
        assert!(cors_erlaubt("http://LocalHost:3000", &["http://localhost:3000".into()]));
        // Eine andere Herkunft bleibt draussen, auch wenn eine freigegeben ist.
        assert!(!cors_erlaubt("https://boese.example", &["http://localhost:3000".into()]));
    }

    #[test]
    fn der_platzhalter_oeffnet_nichts() {
        // Absicht, nicht Versehen: `*` in der Liste ist wieder „jede Webseite",
        // und damit waere die Liste sinnlos. Sie wirkt sichtbar nicht, statt
        // still alles aufzumachen.
        assert!(!cors_erlaubt("https://irgendwas.example", &["*".into()]));
        assert!(!cors_erlaubt("*", &["*".into()]));
        assert!(!cors_erlaubt("null", &["null".into()]));
        assert!(!cors_erlaubt("", &["".into()]));
    }

    #[test]
    fn jede_antwort_ist_zuordenbar_und_eigene_kennungen_bleiben() {
        // Fund 8. Eine eigene Kennung UEBERNEHMEN ist der ganze Punkt —
        // sonst korreliert man nur mit sich selbst.
        assert_eq!(naechste_request_id(Some("kunde-42")), "kunde-42");
        let a = naechste_request_id(None);
        let b = naechste_request_id(None);
        assert_ne!(a, b, "zwei Anfragen duerfen nicht dieselbe Kennung tragen");
        assert!(a.starts_with("req_"), "{}", a);
        // Muell wird nicht uebernommen: der Wert landet in einem Antwortkopf.
        assert!(naechste_request_id(Some("")).starts_with("req_"));
        assert!(naechste_request_id(Some(&"x".repeat(500))).starts_with("req_"));
        assert!(naechste_request_id(Some("zeile\numbruch")).starts_with("req_"));
    }

    #[test]
    fn die_doku_beschreibt_die_routen_die_es_wirklich_gibt() {
        // Fund 5 — und eine Doku, die von den Routen abweicht, ist schlimmer
        // als keine. Dieser Test faellt, sobald eine Route dazukommt und die
        // Selbstauskunft sie verschweigt.
        let d = lu_doku();
        let beschrieben: Vec<String> = d["routes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["path"].as_str().unwrap().to_string())
            .collect();
        for pfad in [
            "/v1/models",
            "/v1/chat/completions",
            "/v1/completions",
            "/v1/embeddings",
            "/lu/v1/health",
            "/lu/v1/tools",
            "/lu/v1/docs",
        ] {
            assert!(beschrieben.contains(&pfad.to_string()), "{} fehlt in der Doku", pfad);
        }
        // Alle Fehlercodes, die der Code wirklich sendet, stehen drin.
        let codes = d["errors"]["codes"].to_string();
        for c in ["invalid_api_key", "missing_required_parameter", "model_not_found", "model_ambiguous", "lane_unavailable"] {
            assert!(codes.contains(c), "{} fehlt in der Doku", c);
        }
        // Und jede Lane nennt sich so, wie das Praefix wirklich heisst.
        let lanes = d["model_names"]["lanes"].to_string();
        for l in Lane::ALL {
            assert!(lanes.contains(l.prefix()), "{} fehlt", l.prefix());
        }
    }

    #[test]
    fn die_werkzeugliste_verweist_nicht_auf_den_quelltext() {
        // Fund 6: „see the comment on lu_werkzeuge() in local_api.rs" stand
        // woertlich in einer Kundenantwort. Der Kunde hat kein local_api.rs.
        let w = lu_werkzeuge().to_string();
        assert!(!w.contains(".rs"), "interner Dateiverweis in der Antwort: {}", w);
        assert!(!w.contains("lu_werkzeuge"), "interner Funktionsname in der Antwort");
        // Stattdessen wird gesagt, dass es hier keinen Aufrufweg gibt.
        assert_eq!(lu_werkzeuge()["callable_here"], false);
    }
}
