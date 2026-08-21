// The agent (Get-Problems/Get-VisibleIntrusiveWindows-equivalent in settings.js) reports plain free-
// text problem strings, most of which embed details that change over time (a disk-space message's
// exact GB-free figure, a popup message's exact window title) - matching an "ignore" against the
// literal text would stop working the moment those details shift even slightly. This classifies
// each string into a stable TYPE instead, so ignoring one occurrence mutes every future one of the
// same kind on that device, regardless of which specific number/title triggered it.
//
// Deliberately simple pattern matching here rather than a type field the agent itself reports -
// keeps this in sync with whatever the agent currently emits without needing an agent-script change
// (and a republish/wait-for-checkin cycle) every time the wording is tweaked. Falls back to the
// literal text as its own "type" for anything unrecognized, so a genuinely novel message still gets
// a stable (if narrower) ignore key rather than never matching anything.
const PROBLEM_TYPES = [
  { type: 'low-disk-space', label: 'Low disk space', test: (p) => /^Low disk space on /.test(p) },
  { type: 'no-antivirus', label: 'No antivirus detected', test: (p) => p === 'No antivirus product detected' },
  { type: 'antivirus-disabled', label: 'Antivirus disabled', test: (p) => /is reporting disabled$/.test(p) },
  { type: 'no-remote-access', label: 'No remote-access tool detected', test: (p) => p === 'No remote-access tool (AnyDesk/TeamViewer) detected' },
  { type: 'unexpected-popup', label: 'Unexpected window/popup detected', test: (p) => /^Unexpected window\/popup detected:/.test(p) },
];

export function problemType(text) {
  const match = PROBLEM_TYPES.find((t) => t.test(text));
  return match ? match.type : text;
}

export function problemTypeLabel(type) {
  const match = PROBLEM_TYPES.find((t) => t.type === type);
  return match ? match.label : type;
}

// The problems a device should actually show as issues right now - whatever the agent most
// recently reported, minus any type this device's admin has chosen to stop seeing.
export function visibleProblems(device) {
  const ignored = new Set(device.ignored_problem_types || []);
  return (device.problems || []).filter((p) => !ignored.has(problemType(p)));
}
