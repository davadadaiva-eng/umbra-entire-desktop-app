/**
 * MeetingNativeControls — control the *native* Zoom / Microsoft Teams desktop
 * apps via their global in-meeting keyboard shortcuts (sent with SendInput),
 * complementing the browser DOM automation in MeetingScreenShare.ts.
 *
 * The DOM path only works when the meeting runs in the user's browser; when
 * they join from the native app instead, there is no tab to evaluate against.
 * This module supplies the provider → process-name → shortcut mapping and the
 * auto-detection logic; index.ts wires it to InputNative (focus window, send
 * hotkey) as a fallback/primary path.
 *
 * Pure logic only (no native imports) so it is unit-testable; the SendInput
 * side effects live in index.ts.
 */

export type NativeMeetingApp = 'zoom' | 'teams';
export type NativeMeetingPreference = 'none' | 'auto' | NativeMeetingApp;

export type NativeMeetingAction = 'mute' | 'unmute' | 'raiseHand' | 'lowerHand' | 'share' | 'stopShare';

interface NativeAppSpec {
  /** Candidate process names (checked in order during auto-detection). */
  processes: string[];
  /** Global in-meeting shortcuts (absent = no reliable shortcut). */
  shortcuts: Partial<Record<NativeMeetingAction, string>>;
}

const APPS: Record<NativeMeetingApp, NativeAppSpec> = {
  zoom: {
    processes: ['Zoom'],
    shortcuts: {
      mute: 'Alt+A', // toggle mute/unmute
      unmute: 'Alt+A',
      raiseHand: 'Alt+Y', // toggle raise/lower hand
      lowerHand: 'Alt+Y',
      share: 'Alt+S', // opens the share dialog (source selection is manual)
      // no stopShare: Zoom has no reliable global shortcut — click "Stop Share"
    },
  },
  teams: {
    processes: ['ms-teams', 'Teams'],
    shortcuts: {
      mute: 'Ctrl+Shift+M', // toggle mute/unmute
      unmute: 'Ctrl+Shift+M',
      raiseHand: 'Ctrl+Shift+K', // toggle raise/lower hand
      lowerHand: 'Ctrl+Shift+K',
      share: 'Ctrl+Shift+E', // toggles screen share
      stopShare: 'Ctrl+Shift+E',
    },
  },
};

/**
 * Resolve which native meeting app to drive.
 *
 * - 'none' → always null (DOM/browser automation only)
 * - 'zoom' | 'teams' → that app
 * - 'auto' → the first app whose process is running
 */
export function detectNativeMeetingApp(
  preference: NativeMeetingPreference | undefined,
  isProcessRunning: (processName: string) => boolean,
): NativeMeetingApp | null {
  if (preference === 'none' || preference === undefined) return null;
  if (preference === 'zoom' || preference === 'teams') return preference;
  for (const app of ['zoom', 'teams'] as NativeMeetingApp[]) {
    if (APPS[app].processes.some(isProcessRunning)) return app;
  }
  return null;
}

/** The shortcut for a control action, or null when none is reliable. */
export function nativeShortcut(app: NativeMeetingApp, action: NativeMeetingAction): string | null {
  return APPS[app].shortcuts[action] ?? null;
}

/** Primary process name to focus before sending a shortcut. */
export function nativeProcessName(app: NativeMeetingApp): string {
  return APPS[app].processes[0];
}

/** All candidate process names (useful for logging/diagnostics). */
export function nativeProcessNames(app: NativeMeetingApp): string[] {
  return APPS[app].processes;
}
