// Turns a raw User-Agent string into a short "Browser on OS, Device" summary for the Admin > Login
// History tab - just enough to answer "what did this login come from", not a full UA-parsing
// library. Order matters throughout: Edge/OPR/Chrome all contain "Chrome" in their own UA string,
// and iPad's UA contains "Mac OS X", so the more specific checks have to run first.
export function summarizeUserAgent(ua) {
  if (!ua) return '-';

  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Version\/.*Safari\//.test(ua)) browser = 'Safari';

  let os = 'Unknown OS';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';

  const device = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi|iPhone|Android/.test(ua) ? 'Mobile' : 'Desktop';

  return `${browser} on ${os}, ${device}`;
}
