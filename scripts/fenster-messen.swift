// Misst die Fenster einer laufenden App, ohne Bildschirmsteuerung.
//
// Warum es das gibt: die Onboarding-Uebergabe (E1) ist die eine Zusicherung
// des Experiment-Builds, die sich mit Tests allein nicht belegen laesst — die
// Entscheidung dahinter ist in `onboarding_window.rs` fuenfzehnfach geprueft,
// aber ob am Ende wirklich ein Fenster auf dem Schirm steht, sagt kein Test.
// Bildschirmsteuerung ist auf dieser Maschine nicht freigegeben.
//
// `CGWindowListCopyWindowInfo` braucht keine: Besitzer, Groesse und Position
// stehen ohne Berechtigung zur Verfuegung (nur der Fenstertitel braeuchte
// Bildschirmaufnahme, und den fragen wir nicht ab). Das reicht fuer die
// Zusicherung, denn die lautet in Zahlen: waehrend des Onboardings genau EIN
// Fenster mit 640x640 und kein Hauptfenster; danach das Hauptfenster und
// kein 640x640 mehr.
//
//   swift scripts/fenster-messen.swift lu-experiment
import CoreGraphics
import Foundation

let gesucht = (CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "lu-experiment").lowercased()
let liste = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []

var fenster: [(Int, Int, Int, Int)] = []
for w in liste {
    let besitzer = ((w[kCGWindowOwnerName as String] as? String) ?? "").lowercased()
    guard besitzer.contains(gesucht) else { continue }
    // Schicht 0 ist gewoehnliches Fensterwerk; alles andere ist Systemzeug
    // (Menueleiste, Mitteilungen) und gehoert nicht zur Aussage.
    guard ((w[kCGWindowLayer as String] as? Int) ?? 0) == 0 else { continue }
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    fenster.append((
        Int((b["Width"] as? Double) ?? 0), Int((b["Height"] as? Double) ?? 0),
        Int((b["X"] as? Double) ?? 0), Int((b["Y"] as? Double) ?? 0)
    ))
}

if fenster.isEmpty {
    print("KEIN FENSTER fuer \"\(gesucht)\" — laeuft die App?")
    exit(2)
}
for (b, h, x, y) in fenster { print("\(b)x\(h) @ (\(x),\(y))") }

let onboarding = fenster.filter { $0.0 == 640 && $0.1 == 640 }
let haupt = fenster.filter { !($0.0 == 640 && $0.1 == 640) }
if onboarding.count == 1 && haupt.isEmpty {
    print("URTEIL: Onboarding laeuft in seinem eigenen 640x640-Fenster, das Hauptfenster ist verborgen.")
} else if onboarding.isEmpty && haupt.count == 1 {
    print("URTEIL: Uebergabe vollzogen — nur noch das Hauptfenster.")
} else {
    print("URTEIL: WEDER NOCH — \(onboarding.count) Onboarding-Fenster und \(haupt.count) andere. Genau das darf nie stehen.")
    exit(1)
}
