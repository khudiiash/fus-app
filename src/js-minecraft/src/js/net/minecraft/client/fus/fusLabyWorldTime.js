/**
 * Shared Laby day/night: wall clock in {@link Europe/Kyiv} mapped to MC ticks [0,24000),
 * with 06:00 Kyiv ≈ dawn (0) and 18:00 ≈ dusk (12000) so afternoon stays visually “day”.
 *
 * @returns {number}
 */
export function fusLabyWorldTimeTicksFromKyivClock() {
    const d = new Date();
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Kyiv",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hour12: false,
    }).formatToParts(d);
    const ho = Number(parts.find((p) => p.type === "hour")?.value);
    const mi = Number(parts.find((p) => p.type === "minute")?.value);
    const se = Number(parts.find((p) => p.type === "second")?.value);
    if (![ho, mi, se].every((n) => Number.isFinite(n))) {
        const ms = Date.now() % 86400000;
        return (ms / 86400000) * 24000;
    }
    const hKyiv = ho + mi / 60 + se / 3600;
    /** Align 06:00 → tick 0 (dawn), 18:00 → 12000 (sunset). */
    const hRel = (hKyiv - 6 + 24) % 24;
    return (hRel / 24) * 24000;
}
