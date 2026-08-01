'use strict';

/** Formats a whole-second duration as 'HH:MM:SS', extending to 'D:HH:MM:SS' once it reaches 24h. */
function formatDuration(totalSeconds) {
  const secs = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return days > 0 ? `${days}:${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

module.exports = { formatDuration };
