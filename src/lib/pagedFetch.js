const PAGE_SIZE = 1000;

// Supabase's project-wide "Max Rows" setting hard-caps any single request at 1000 regardless of
// what .range() asks for - a plain select() (or a select().range(0, 9999), which looks safe but
// isn't) silently truncates once a table crosses that many rows, with no error to say so. Confirmed
// live, 5 Sep 2026: workspace_devices quietly lost 73 real rows off the bottom of "Total Devices"
// this exact way. Asking for an exact count alongside the first page (free - PostgREST returns it
// in the same request's Content-Range header) turns any table that outgrows one page into a single
// extra parallel batch of requests instead of silent data loss, no matter how large it gets.
//
// `buildQuery(withCount)` must return a FRESH Supabase query each call (the query builder is
// single-use) with every filter/order this fetch needs already applied, via
// .select(columns, withCount ? { count: 'exact' } : undefined) for the columns - only .range() is
// added here, so callers stay in full control of what they select/filter/order by.
export async function fetchAllPages(buildQuery) {
  const first = await buildQuery(true).range(0, PAGE_SIZE - 1);
  if (first.error) throw first.error;

  let all = first.data || [];
  const total = first.count;
  // count can come back null if the header is unavailable - falling back to a sequential walk
  // (each page's own length tells us when to stop) is better than silently truncating to one page.
  if (total == null) {
    for (let from = PAGE_SIZE; ; from += PAGE_SIZE) {
      const { data, error } = await buildQuery(false).range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      all = all.concat(data);
      if (data.length < PAGE_SIZE) break;
    }
  } else if (total > PAGE_SIZE) {
    const starts = [];
    for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) starts.push(from);
    const pages = await Promise.all(starts.map((from) => buildQuery(false).range(from, from + PAGE_SIZE - 1)));
    for (const p of pages) {
      if (p.error) throw p.error;
      all = all.concat(p.data || []);
    }
  }
  return all;
}
