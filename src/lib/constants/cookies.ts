/**
 * Cookie names shared across the server/client boundary.
 *
 * These deliberately live in a module with no `"use client"` directive.
 * Next.js replaces every export of a client module with a client *reference*
 * when it is imported from a server component — so a string constant exported
 * from a `"use client"` file arrives on the server as an opaque proxy, and
 * `cookies().get(THAT)` silently returns undefined. The failure is quiet: the
 * feature simply never works, with no error to follow.
 *
 * Anything read on the server and written in the browser belongs here.
 */

/** Sidebar collapsed state. Read during the server render so the first paint
 *  is already the right width. Not sensitive, so it is writable from script. */
export const SIDEBAR_COOKIE = "riai_sidebar";

/** Selected financial year. Validated against the tenant's own years on read. */
export const FISCAL_YEAR_COOKIE = "riai_fy";
