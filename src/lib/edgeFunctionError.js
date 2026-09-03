// supabase-js sets `error` on any non-2xx Edge Function response with the generic message "Edge
// Function returned a non-2xx status code", discarding whatever the function's own JSON body
// actually said - every Edge Function in this app returns { error: "<real reason>" } on failure
// (see e.g. traffic-sheet-proxy), but a plain `throw error` shows the user that generic wrapper
// text instead. The real body is still reachable via error.context (the raw fetch Response), which
// this reads once and falls back to the generic message only if that fails for any reason (already
// consumed, not JSON, network-level error with no Response at all).
export async function edgeFunctionErrorMessage(error) {
  if (!error) return null;
  try {
    if (error.context && typeof error.context.json === 'function') {
      const body = await error.context.json();
      if (body?.error) return body.error;
    }
  } catch {}
  return error.message || String(error);
}
