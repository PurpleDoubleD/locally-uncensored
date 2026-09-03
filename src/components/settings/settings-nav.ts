/**
 * Die Navigationsstruktur der Einstellungen — als Daten, nicht als JSX.
 *
 * Warum es diese Datei gibt (Design-Audit D-S27 / D-S48): die Inhaltsspalte
 * stand auf `max-w-lg mx-auto` und schwebte damit in der Fenstermitte; nach
 * oben skalierte der Screen gar nicht, weil es nichts gab, was den gewonnenen
 * Platz benutzen konnte. Das Soll des Audits ist eine 200px-Rail links mit den
 * Sektionen und die Inhaltsspalte linksbuendig daneben. Eine Rail braucht eine
 * Liste — und diese Liste darf nicht neben dem JSX her leben, sonst zeigt sie
 * irgendwann auf Sektionen, die es nicht mehr gibt.
 *
 * Deshalb zwei Dinge hier:
 *
 *  1. `sectionAnchorId()` ist die EINE Ableitung Titel → Ankername. Die
 *     `<Section>`-Komponente setzt damit ihr `id`, die Rail baut damit ihr
 *     Sprungziel. Zwei Kopien derselben Slug-Regel waeren genau der Zustand,
 *     in dem ein Sprungziel still ins Leere zeigt.
 *
 *  2. `sectionsFor()` ist die Reihenfolge der Sektionen je Tab, abhaengig von
 *     denselben Bedingungen, die im JSX die Sektion ueberhaupt rendern. Die
 *     Bedingungen kommen als Flags herein, damit diese Funktion rein bleibt
 *     und geprueft werden kann, ohne die Plattform zu kennen.
 *
 * Gegen das Auseinanderlaufen von Liste und JSX steht eine Sperrklinke im
 * Test (`__tests__/settings-rail-und-rang.test.ts`): er liest die
 * `<Section title="…">`-Literale aus SettingsPage.tsx je Tab-Zweig und
 * vergleicht sie mit dem, was hier steht. Wer eine Sektion hinzufuegt und die
 * Rail vergisst, faellt dort durch.
 */
import type { SettingsTab } from '../../lib/settings-reset'

/**
 * Titel → DOM-`id`. Kleinbuchstaben, alles Nicht-Alphanumerische wird zu
 * einem Bindestrich, das Praefix haelt die ids aus dem globalen id-Raum der
 * App heraus ("Speech" ist ein zu naheliegender Name, um ihn unpraefixiert zu
 * vergeben).
 */
export function sectionAnchorId(title: string): string {
  return `set-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

/**
 * Die Bedingungen, unter denen einzelne Sektionen ueberhaupt gerendert
 * werden. Genau die Ausdruecke, die im JSX vor der Sektion stehen — hier
 * benannt, damit Rail und Inhalt dieselbe Wahrheit lesen.
 */
export interface SettingsSectionFlags {
  /** `!isMlxImageHost()` — der GPU-Picker ist auf Apple Silicon durchweg ein No-op. */
  gpuPicker: boolean
  /** `builtinManaged` — der Expertenblock existiert nur, wenn der openai-Slot die eigene Engine IST. */
  builtinExpert: boolean
  /** `!isMlxImageHost()` — Windows/Linux bekommen ComfyUI, der Mac an derselben Stelle MLX. */
  comfyui: boolean
  /** `FEATURE_FLAGS.AGENT_MODE` */
  agentMode: boolean
  /** `FEATURE_FLAGS.AGENT_WORKFLOWS` */
  agentWorkflows: boolean
  /**
   * `settings.appMode !== 'cloud' && !isMlxImageHost()` — die
   * ComfyUI-Zeitgrenzen. Zwei Bedingungen, nicht eine: im Cloud-Modus gelten
   * serverseitige Grenzen, und die MLX-Pipeline des Macs hat ihre eigene.
   * Diese Bedingung hat mich beim ersten Anlauf erwischt — die Rail bot einen
   * Sprung an, den der Inhalt nicht hatte. Der Beweis dafuer, dass die
   * Sperrklinke im Test noetig ist.
   */
  mediaTimeouts: boolean
}

/**
 * Die Sektionen eines Tabs, in Renderreihenfolge. Leere Eintraege fallen
 * heraus, damit die Rail keine Sprungziele anbietet, die im Inhalt fehlen.
 */
export function sectionsFor(tab: SettingsTab, flags: SettingsSectionFlags): string[] {
  switch (tab) {
    case 'general':
      return [
        'LU Cloud Account',
        'Cloud API Keys',
        'Appearance',
        'Generation',
        ...(flags.gpuPicker ? ['Hardware (GPU picker)'] : []),
        'Import from other chatbots',
        'Chat Backup',
        ...(flags.mediaTimeouts ? ['Image / Video Generation Timeouts'] : []),
        'Privacy',
        'Onboarding',
        'Updates',
        'Troubleshoot',
      ]
    case 'backends':
      return [
        'Providers',
        'Model Storage',
        'CivitAI API key',
        ...(flags.builtinExpert ? ['LU Engine (expert)'] : []),
        flags.comfyui ? 'ComfyUI (Image & Video)' : 'Local Media (Apple MLX)',
      ]
    case 'agent':
      return [
        'Personas',
        'Memory',
        ...(flags.agentMode ? ['Agent Permissions'] : []),
        // Die Kappen fuer delegierte Agenten. Sie standen bis zum
        // 03.09.2026 unter General → Generation, zwischen Temperatur und
        // Auto-Compact; eine Persona suchte sie beim Agenten und fand sie
        // dort nicht. Ein delegierter Lauf hat keinen Zuschauer — das ist
        // ein anderer Gegenstand als die Werte des Zugs, vor dem man sitzt.
        ...(flags.agentMode ? ['Sub-agents'] : []),
        ...(flags.agentWorkflows ? ['Agent Workflows'] : []),
        ...(flags.agentMode ? ['MCP Servers', 'Coding Agent', 'Search Provider'] : []),
      ]
    case 'voice-remote':
      return ['Speech', 'Remote Access', 'Local API']
  }
}
