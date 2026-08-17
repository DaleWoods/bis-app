import { useEffect, useState } from 'react';

function remaining(target: string, now: number): { ms: number; label: string } {
  const ms = new Date(target).getTime() - now;
  if (ms <= 0) return { ms, label: 'Closed' };
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (!days) parts.push(`${minutes}m`);
  return { ms, label: `${parts.join(' ')} left` };
}

/**
 * A live "time left until cut-off" badge. Ticks every 30 seconds rather than
 * every one - a deadline measured in hours or days does not need
 * second-precision, and a badge that never stops re-rendering is a worse
 * neighbour on a page with other live state.
 */
export function Countdown({ target }: { target: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const { ms, label } = remaining(target, now);
  if (ms <= 0) return <span className="badge warn">Closed</span>;

  // Inside the last four hours is stop-the-clock territory - worth a colour
  // change, not just a smaller number.
  const urgent = ms < 4 * 3600_000;
  return <span className={`badge${urgent ? ' warn' : ' open'}`}>{label}</span>;
}
