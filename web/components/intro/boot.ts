/**
 * Shared by the root layout (a server component) and the intro provider (a
 * client one). It lives in a plain module because a value exported from a
 * "use client" file reaches a server component as a reference, not a string.
 */

export const SEEN_KEY = "multiply.intro.v1";
export const INTRO_EVENT = "multiply:intro";
export const PENDING_CLASS = "intro-pending";

/**
 * Runs in <head> before the first paint. A first-time visitor to "/" would
 * otherwise see the whole market flash up and then disappear under the
 * overlay; this paints the night colour first instead. The timeout is the
 * safety net: if the story chunk never arrives, the cover lifts by itself.
 */
export const INTRO_BOOT_SCRIPT = `(function(){try{var q=/[?&]intro(=|&|$)/.test(location.search);if(q||(location.pathname==='/'&&localStorage.getItem('${SEEN_KEY}')!=='1')){var r=document.documentElement;r.classList.add('${PENDING_CLASS}');setTimeout(function(){r.classList.remove('${PENDING_CLASS}')},5000)}}catch(e){}})();`;
