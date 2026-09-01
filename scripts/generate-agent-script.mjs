// Renders the two PowerShell scripts that live inside src/pages/settings.js as JavaScript template
// literals, so CI can hand them to a real PowerShell parser (see .github/workflows/deploy.yml).
//
// WHY THIS EXISTS
// Those scripts are written inside JS template literals, which means JavaScript processes every
// backslash escape before PowerShell ever sees the text: "\s" becomes "s", "\r\n" becomes two real
// newlines, and '\"' becomes a bare quote that terminates a PowerShell string. Forgetting to double
// a backslash does not produce a subtly wrong script - it produces one that will not PARSE, and
// PowerShell refuses to run such a file in its entirety. On 25 Aug 2026 exactly that shipped as
// agent v48 and took three machines offline: no check-in, no poll, and no self-update, which is the
// mechanism that would otherwise have delivered the fix.
//
// It is deliberately a RENDERER, not a re-implementation. It pulls the template text straight out of
// the source file and lets JavaScript itself evaluate it, so what gets parse-checked went through
// exactly the same escaping the real build does. A checker that rebuilt the string by hand - or that
// "helpfully" normalised backslashes on the way - would silently repair the very defect it is meant
// to catch, which is how the v48 bug got through a check that reported success.
import fs from 'node:fs';
import path from 'node:path';

const SETTINGS = path.join('src', 'pages', 'settings.js');

// Finds the backtick that closes a template literal opened at `from`.
//
// Scanned properly rather than searched for, because a naive indexOf lands in the wrong place: the
// PowerShell inside these templates contains escaped backticks (PowerShell's own escape character),
// and the interpolations contain NESTED template literals. Getting this wrong silently returns a
// truncated or over-long script, which then "fails to parse" for reasons that have nothing to do
// with the code being checked.
function findTemplateEnd(s, from) {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i;
    if (c === '$' && s[i + 1] === '{') { i = skipInterpolation(s, i + 2); continue; }
    i += 1;
  }
  throw new Error('unterminated template literal');
}

// Skips a ${ ... } interpolation, from just after the "${", returning the index just past its "}".
// Tracks brace depth, and recurses through nested template literals and quoted strings so a brace
// or backtick inside them cannot be mistaken for the end of the interpolation.
function skipInterpolation(s, from) {
  let i = from;
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { i = findTemplateEnd(s, i + 1) + 1; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(s, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  throw new Error('unterminated interpolation');
}

function skipQuoted(s, from) {
  const quote = s[from];
  let i = from + 1;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error('unterminated string');
}

// Pulls out the body of the single template literal a function returns.
function extractTemplate(source, functionName) {
  const fnStart = source.indexOf(`function ${functionName}(`);
  if (fnStart === -1) throw new Error(`${functionName} not found in ${SETTINGS}`);
  const marker = 'return `';
  const bodyStart = source.indexOf(marker, fnStart);
  if (bodyStart === -1) throw new Error(`${functionName} does not return a template literal`);
  const from = bodyStart + marker.length;
  return source.slice(from, findTemplateEnd(source, from));
}

// Evaluates a template body with the given bindings, using JS's own template evaluation so the
// escaping behaviour is identical to the real build. Values are placeholders - CI is checking that
// the script PARSES, which is a property of its structure, not of any particular secret or URL.
function renderTemplate(templateBody, bindings) {
  const names = Object.keys(bindings);
  const render = new Function(...names, 'return `' + templateBody + '`;');
  return render(...names.map((n) => bindings[n]));
}

const source = fs.readFileSync(SETTINGS, 'utf8');

// anyDeskInstallsScript is rendered first because BOTH the collector and the agent shell embed it
// (as a `${anyDeskInstallsScript()}` call in their own template) - it's Get-AnyDeskInstalls'
// PowerShell text, kept as one JS source of truth since the collector and the agent shell are two
// independently-fetched PowerShell documents at runtime that can't share a function definition any
// other way. Passed to renderTemplate as a zero-arg function binding (matching how the template
// calls it), not a plain string, so `${anyDeskInstallsScript()}` resolves the same way it does in
// the real build.
const anyDeskInstalls = renderTemplate(extractTemplate(source, 'anyDeskInstallsScript'), {});
const anyDeskInstallsScript = () => anyDeskInstalls;

// The collector is rendered first because the agent shell embeds it (as $indented) to use as its
// built-in fallback collector, so a syntax error in the collector is also a syntax error in the
// agent - checking both separately makes it obvious which one is at fault.
const collector = renderTemplate(extractTemplate(source, 'defaultCollectorScript'), { anyDeskInstallsScript });
const indented = collector.split('\n').map((l) => `    ${l}`).join('\n');

const agent = renderTemplate(extractTemplate(source, 'buildWorkspaceDirectoryAgentScript'), {
  secret: 'CI_PLACEHOLDER_SECRET',
  uninstallHash: 'ci_placeholder_hash',
  anonKey: 'CI_PLACEHOLDER_ANON_KEY',
  checkinUrl: 'https://ci.invalid/functions/v1/workspace-directory-checkin',
  collectorUrl: 'https://ci.invalid/functions/v1/workspace-directory-collector',
  agentShellUrl: 'https://ci.invalid/functions/v1/workspace-directory-agent-shell',
  forceStatusUrl: 'https://ci.invalid/functions/v1/workspace-directory-force-status',
  indented,
  AGENT_CANARY_HOSTNAMES: ['CI-TEST-PC-1', 'CI-TEST-PC-2', 'CI-TEST-PC-3'],
  anyDeskInstallsScript,
});

const outDir = process.argv[2] || path.join('.ci-out');
fs.mkdirSync(outDir, { recursive: true });
const collectorPath = path.join(outDir, 'collector.generated.ps1');
const agentPath = path.join(outDir, 'agent.generated.ps1');
fs.writeFileSync(collectorPath, collector, 'utf8');
fs.writeFileSync(agentPath, agent, 'utf8');

console.log(`collector -> ${collectorPath} (${collector.length} bytes, ${collector.split('\n').length} lines)`);
console.log(`agent     -> ${agentPath} (${agent.length} bytes, ${agent.split('\n').length} lines)`);
